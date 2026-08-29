#!/usr/bin/env python3
"""多客户端用量：ccusage 导出 JSON，渲染 usage/*.svg，挂到 README。

  python3 scripts/pi_usage.py export [--client pi|claude|codex|opencode|all] [--name mio]
  python3 scripts/pi_usage.py render
  python3 scripts/pi_usage.py sync [--client all] [--name mio] [--commit] [--push]
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
USAGE_DIR = ROOT / "usage"
DATA_DIR = USAGE_DIR / "data"
README = ROOT / "README.md"
START = "<!-- PI-USAGE:START -->"
END = "<!-- PI-USAGE:END -->"
TOP = 5

# 客户端：pi 为主；claude/codex/opencode 为历史三图
CLIENTS = ("pi", "claude", "codex", "opencode")

# Catppuccin Macchiato 强调色（与 nix-config 多样性一致）
ACCENT = {
    "pi": "#f5bde6",  # pink
    "claude": "#f5a97f",  # peach
    "codex": "#8aadf4",  # blue
    "opencode": "#8bd5ca",  # teal
}
TITLE = {
    "pi": "最近Vibe统计 · Pi",
    "claude": "历史 · Claude Code",
    "codex": "历史 · Codex",
    "opencode": "历史 · OpenCode",
}


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    USAGE_DIR.mkdir(parents=True, exist_ok=True)


def ccusage_cmd(client: str) -> list[str]:
    if client not in CLIENTS:
        die(f"未知 client: {client}")
    if shutil.which("ccusage"):
        return ["ccusage", client, "daily", "--json", "--offline"]
    if shutil.which("bunx"):
        return ["bunx", "ccusage", client, "daily", "--json", "--offline"]
    die("需要 ccusage 或 bunx")


def run_ccusage(client: str) -> dict:
    cmd = ccusage_cmd(client)
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        die(f"ccusage {client} 失败: {e.stderr or e.stdout or e}")

    raw = proc.stdout.strip()
    if not raw:
        die(f"ccusage {client} 输出为空")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        die(f"ccusage {client} JSON 无效: {e}")

    daily = data.get("daily")
    if not isinstance(daily, list):
        die(f"ccusage {client}: daily[] 缺失")
    return data


def data_path(client: str, name: str | None = None) -> Path:
    if client == "pi":
        device = name or "mio"
        if not re.fullmatch(r"[A-Za-z0-9_-]+", device):
            die(f"非法 name: {device}")
        return DATA_DIR / f"pi-{device}.json"
    return DATA_DIR / f"{client}.json"


def svg_path(client: str) -> Path:
    return USAGE_DIR / f"{client}.svg"


def export_client(client: str, name: str = "mio") -> Path | None:
    ensure_dirs()
    data = run_ccusage(client)
    daily = data.get("daily") or []
    out = data_path(client, name)
    if not daily:
        print(f"⚠ {client}: daily 为空，跳过写入 {out.name}")
        return None
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(int(d.get("totalTokens") or 0) for d in daily)
    print(f"✓ {out.relative_to(ROOT)}  days={len(daily)}  totalTokens={total:,}")
    return out


def export_all(name: str = "mio") -> list[Path]:
    paths: list[Path] = []
    for c in CLIENTS:
        p = export_client(c, name)
        if p is not None:
            paths.append(p)
    return paths


def normalize_day(d: dict) -> dict:
    """统一 pi/claude/opencode(modelBreakdowns) 与 codex(models) 日结构。"""
    out = dict(d)
    if "date" not in out:
        die(f"day 缺少 date: {list(out.keys())}")

    if out.get("modelBreakdowns"):
        return out

    # codex: models = { name: { inputTokens, ... } }
    models = out.get("models")
    if isinstance(models, dict) and models:
        breakdowns = []
        for name, m in models.items():
            if not isinstance(m, dict):
                continue
            breakdowns.append(
                {
                    "modelName": name,
                    "inputTokens": int(m.get("inputTokens") or 0),
                    "outputTokens": int(m.get("outputTokens") or 0),
                    "cacheReadTokens": int(m.get("cacheReadTokens") or 0),
                    "cacheCreationTokens": int(m.get("cacheCreationTokens") or 0),
                    "cost": m.get("cost") or m.get("costUSD") or 0,
                }
            )
        out["modelBreakdowns"] = breakdowns
        if out.get("totalTokens") is None:
            out["totalTokens"] = sum(model_tokens(m) for m in breakdowns)
        return out

    # 无模型明细时至少保留 totalTokens
    if out.get("totalTokens") is None:
        out["totalTokens"] = (
            int(out.get("inputTokens") or 0)
            + int(out.get("outputTokens") or 0)
            + int(out.get("cacheReadTokens") or 0)
            + int(out.get("cacheCreationTokens") or 0)
        )
    out.setdefault("modelBreakdowns", [])
    return out


def load_client_days(client: str) -> list[dict]:
    ensure_dirs()
    if client == "pi":
        files = sorted(DATA_DIR.glob("pi-*.json"))
        # 兼容旧根目录 mac-cc.json
        legacy = ROOT / "mac-cc.json"
        if legacy.is_file():
            files.append(legacy)
        if not files:
            die("没有 usage/data/pi-*.json，先 export --client pi")
    else:
        f = data_path(client)
        if not f.is_file():
            die(f"没有 {f.relative_to(ROOT)}，先 export --client {client}")
        files = [f]

    days: list[dict] = []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        daily = data.get("daily")
        if not isinstance(daily, list):
            die(f"{f.name}: missing daily[]")
        for d in daily:
            days.append(normalize_day(d))
    return days


def parse_day(s: str) -> date:
    return date.fromisoformat(s)


def model_tokens(m: dict) -> int:
    return int(
        (m.get("inputTokens") or 0)
        + (m.get("outputTokens") or 0)
        + (m.get("cacheReadTokens") or 0)
        + (m.get("cacheCreationTokens") or 0)
    )


def day_tokens(d: dict) -> int:
    if d.get("totalTokens") is not None:
        return int(d["totalTokens"])
    return sum(model_tokens(m) for m in d.get("modelBreakdowns") or [])


def clean_name(name: str) -> str:
    return re.sub(r"^\[pi\]\s*", "", name, flags=re.I).strip()


def filter_last_n(days: list[dict], n: int) -> list[dict]:
    if not days:
        return []
    end = max(parse_day(d["date"]) for d in days)
    start = end - timedelta(days=n - 1)
    return [d for d in days if parse_day(d["date"]) >= start]


def sum_tokens(days: list[dict]) -> int:
    return sum(day_tokens(d) for d in days)


def rank_models(days: list[dict], top: int) -> list[tuple[str, int]]:
    acc: dict[str, int] = defaultdict(int)
    for d in days:
        for m in d.get("modelBreakdowns") or []:
            acc[clean_name(str(m.get("modelName") or "?"))] += model_tokens(m)
    return sorted(acc.items(), key=lambda x: x[1], reverse=True)[:top]


def fmt_tokens(n: int) -> str:
    """>1000M 用 B，否则用 M。"""
    m = abs(int(n)) / 1_000_000
    if m > 1000:
        b = m / 1000
        if b >= 100:
            body = f"{b:.0f}"
        elif b >= 10:
            body = f"{b:.1f}"
        else:
            body = f"{b:.2f}"
        unit = "B"
    elif m >= 100:
        body = f"{m:.0f}"
        unit = "M"
    elif m >= 10:
        body = f"{m:.1f}"
        unit = "M"
    elif m >= 1:
        body = f"{m:.1f}"
        unit = "M"
    else:
        body = f"{m:.2f}"
        unit = "M"
    if "." in body:
        whole, frac = body.split(".", 1)
        body = f"{int(whole):,}.{frac}"
    else:
        body = f"{int(body):,}"
    return f"{body}{unit}"


def _sum_field(days: list[dict], key: str) -> int:
    return sum(int(d.get(key) or 0) for d in days)


def build_svg(days: list[dict], *, client: str) -> str:
    title = TITLE[client]
    A = ACCENT[client]
    d7 = filter_last_n(days, 7)
    d40 = filter_last_n(days, 40)
    total = sum_tokens(days)
    t7 = sum_tokens(d7)
    t40 = sum_tokens(d40)
    rank7 = rank_models(d7, TOP)
    rank40 = rank_models(d40, TOP)

    dates = sorted(d["date"] for d in days)
    fr, to = (dates[0], dates[-1]) if dates else ("—", "—")
    n_days = len(days) or 1
    active = sum(1 for d in days if day_tokens(d) > 0)
    avg_day = total // n_days
    peak_tok = max((day_tokens(d) for d in days), default=0)
    top_model = rank40[0][0] if rank40 else (rank7[0][0] if rank7 else "—")
    if len(top_model) > 14:
        top_model = top_model[:13] + "…"

    inp = _sum_field(days, "inputTokens")
    out = _sum_field(days, "outputTokens")
    cr = _sum_field(days, "cacheReadTokens")
    cw = _sum_field(days, "cacheCreationTokens")
    denom = inp + cr
    cache_pct = int(round(100 * cr / denom)) if denom else 0

    BG = "#181926"
    STROKE = "#363a4f"
    USER = "#b8c0e0"
    LBL = "#a5adcb"
    SUB = "#a5adcb"
    FOOT = "#6e738d"
    FONT = "'Segoe UI',Ubuntu,sans-serif"

    W, H = 846, 225
    cols = [30, 235, 465, 665]
    dividers = [215, 445, 645]

    def text(x, y, body, *, fill, size, weight="400", anchor=None, spacing=None) -> str:
        attrs = (
            f'x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}" '
            f'font-family="{FONT}"'
        )
        if anchor:
            attrs += f' text-anchor="{anchor}"'
        if spacing:
            attrs += f' letter-spacing="{spacing}"'
        return f"<text {attrs}>{escape(body)}</text>"

    def row(x: int, y: int, label: str, value: str, w_end: int) -> str:
        return text(x, y, label, fill=LBL, size=13) + text(
            w_end, y, value, fill=A, size=14, weight="700", anchor="end"
        )

    parts: list[str] = [
        f'<rect width="{W - 1}" height="{H - 1}" x="0.5" y="0.5" rx="4.5" '
        f'fill="{BG}" stroke="{STROKE}" stroke-width="1"/>',
        text(30, 38, title, fill=A, size=18, weight="600"),
        text(W - 30, 38, "@shelken", fill=USER, size=14, weight="600", anchor="end"),
        text(W - 30, 53, f"{fr} · {to}", fill=FOOT, size=11, anchor="end"),
    ]
    for x in dividers:
        parts.append(
            f'<line x1="{x}" y1="62" x2="{x}" y2="178" stroke="{STROKE}" stroke-width="1"/>'
        )

    parts += [
        text(cols[0], 72, "ALL-TIME", fill=FOOT, size=11, weight="600", spacing="1.5"),
        text(cols[0], 135, fmt_tokens(total), fill=A, size=44, weight="800"),
        text(cols[0], 160, f"tokens · {cache_pct}% cache-hit", fill=SUB, size=13),
        text(cols[1], 72, "PERIOD", fill=FOOT, size=11, weight="600", spacing="1.5"),
        row(cols[1], 98, "7 days", fmt_tokens(t7), 430),
        row(cols[1], 123, "40 days", fmt_tokens(t40), 430),
        row(cols[1], 148, "Since", fr, 430),
        row(cols[1], 173, "Until", to, 430),
        text(cols[2], 72, "TOKEN MIX", fill=FOOT, size=11, weight="600", spacing="1.5"),
        row(cols[2], 98, "Output", fmt_tokens(out), 630),
        row(cols[2], 123, "Input", fmt_tokens(inp), 630),
        row(cols[2], 148, "Cache read", fmt_tokens(cr), 630),
        row(cols[2], 173, "Cache write", fmt_tokens(cw), 630),
        text(cols[3], 72, "ACTIVITY", fill=FOOT, size=11, weight="600", spacing="1.5"),
        row(cols[3], 98, "Active days", str(active), 816),
        row(cols[3], 123, "Avg / day", fmt_tokens(avg_day), 816),
        row(cols[3], 148, "Peak day", fmt_tokens(peak_tok), 816),
        row(cols[3], 173, "Top model", top_model, 816),
    ]

    def short_rank(rows: list[tuple[str, int]], n: int = 2) -> str:
        if not rows:
            return "n/a"
        bits = []
        for name, tok in rows[:n]:
            nm = name if len(name) <= 12 else name[:11] + "…"
            bits.append(f"{nm} {fmt_tokens(tok)}")
        return " · ".join(bits)

    foot = f"7d {short_rank(rank7)}   ·   40d {short_rank(rank40)}"
    parts += [
        text(30, 205, "MODELS", fill=FOOT, size=11, weight="600", spacing="1.5"),
        text(100, 205, foot, fill=LBL, size=13),
    ]

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{escape(title)}">\n'
        + "\n".join(parts)
        + "\n</svg>\n"
    )


def patch_readme(rendered: list[str]) -> None:
    """rendered: 已成功写出的 client 名，按 CLIENTS 顺序。"""
    lines = [START, ""]
    for c in CLIENTS:
        if c not in rendered:
            continue
        rel = f"./usage/{c}.svg"
        label = TITLE[c]
        lines.append(f"**{label}**")
        lines.append("")
        # width=100%：GitHub 与本地预览都全宽；class 供预览 CSS 识别
        lines.append(
            f'<a href="{rel}"><img class="usage-card" width="100%" src="{rel}" alt="{label}" /></a>'
        )
        lines.append("")
    lines.append(END)
    block = "\n".join(lines)

    text = README.read_text(encoding="utf-8")
    if START not in text or END not in text:
        die(f"README.md 缺少 {START} / {END}")
    i = text.index(START)
    j = text.index(END) + len(END)
    README.write_text(text[:i] + block + text[j:], encoding="utf-8")


def render() -> list[str]:
    ensure_dirs()
    rendered: list[str] = []
    for c in CLIENTS:
        try:
            days = load_client_days(c)
        except SystemExit as e:
            if c == "pi":
                raise
            print(f"⚠ skip {c}: exit {e.code}")
            continue
        if not days:
            print(f"⚠ skip {c}: no days")
            continue
        out = svg_path(c)
        out.write_text(build_svg(days, client=c), encoding="utf-8")
        rendered.append(c)
        print(
            f"✓ {out.relative_to(ROOT)}  days={len(days)}  "
            f"total={fmt_tokens(sum_tokens(days))}"
        )

    if not rendered:
        die("没有可渲染的客户端数据")
    patch_readme(rendered)
    print(f"✓ README  cards={','.join(rendered)}")
    return rendered


def migrate_legacy() -> None:
    """根目录旧文件迁到 usage/。"""
    ensure_dirs()
    legacy_json = ROOT / "mac-cc.json"
    if legacy_json.is_file():
        dest = DATA_DIR / "pi-mio.json"
        if not dest.is_file():
            dest.write_text(legacy_json.read_text(encoding="utf-8"), encoding="utf-8")
            print(f"✓ migrate {legacy_json.name} → {dest.relative_to(ROOT)}")
        legacy_json.unlink()
        print(f"✓ removed {legacy_json.name}")

    legacy_svg = ROOT / "pi-usage.svg"
    if legacy_svg.is_file():
        legacy_svg.unlink()
        print(f"✓ removed {legacy_svg.name}")


def run_git(args: list[str], ok_codes: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    cmd = ["git", *args]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if proc.returncode not in ok_codes:
        details = []
        if proc.stdout.strip():
            details.append(f"stdout:\n{proc.stdout.strip()}")
        if proc.stderr.strip():
            details.append(f"stderr:\n{proc.stderr.strip()}")
        output = "\n".join(details) or "命令没有输出"
        die(
            f"Git 命令失败（退出码 {proc.returncode}）\n"
            f"命令: {shlex.join(cmd)}\n{output}"
        )
    return proc


def git_pull() -> None:
    run_git(["pull", "--rebase", "--autostash"])
    print("✓ pulled")


def git_commit(paths: list[Path], message: str) -> None:
    rels = [str(p.relative_to(ROOT)) for p in paths if p.exists()]
    run_git(["add", "--", *rels])
    diff = run_git(["diff", "--staged", "--quiet"], ok_codes=(0, 1))
    if diff.returncode == 0:
        print("无变更，跳过 commit")
        return
    run_git(["commit", "-m", message])
    print("✓ committed")


def git_push() -> None:
    run_git(["push"])
    print("✓ pushed")


def main() -> None:
    p = argparse.ArgumentParser(description="多客户端用量导出与 SVG 渲染")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="导出 usage/data/*.json")
    e.add_argument(
        "--client",
        default="all",
        choices=[*CLIENTS, "all"],
        help="pi|claude|codex|opencode|all",
    )
    e.add_argument("--name", default="mio", help="Pi 数据源 ID → pi-{name}.json")

    sub.add_parser("render", help="生成 usage/*.svg 并更新 README")
    sub.add_parser("migrate", help="根目录旧 mac-cc.json / pi-usage.svg 迁入 usage/")

    s = sub.add_parser("sync", help="导出 + 渲染")
    s.add_argument("--client", default="all", choices=[*CLIENTS, "all"])
    s.add_argument("--name", default="mio")
    s.add_argument("--commit", action="store_true")
    s.add_argument("--push", action="store_true")

    args = p.parse_args()

    if args.cmd == "migrate":
        migrate_legacy()
    elif args.cmd == "export":
        migrate_legacy()
        if args.client == "all":
            export_all(args.name)
        else:
            export_client(args.client, args.name)
    elif args.cmd == "render":
        migrate_legacy()
        render()
    elif args.cmd == "sync":
        if args.push:
            git_pull()
        migrate_legacy()
        if args.client == "all":
            export_all(args.name)
        else:
            export_client(args.client, args.name)
        render()
        do_push = bool(args.push)
        do_commit = bool(args.commit) or do_push
        if do_commit:
            git_commit(
                [USAGE_DIR, README],
                f"chore: update usage cards ({args.client})",
            )
        if do_push:
            git_push()
    else:
        die(f"unknown: {args.cmd}")


if __name__ == "__main__":
    main()
