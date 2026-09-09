#!/usr/bin/env python3
"""多 Harness 用量：ccusage 导出 JSON，渲染 usage/*.svg，挂到 README。

  python3 scripts/harness_usage.py export [--client omp|pi|claude|codex|opencode|all] [--name mio]
  python3 scripts/harness_usage.py render
  python3 scripts/harness_usage.py sync [--client all] [--name mio] [--commit] [--push]
"""

from __future__ import annotations

import argparse
import json
import os
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
START = "<!-- HARNESS-USAGE:START -->"
END = "<!-- HARNESS-USAGE:END -->"
LEGACY_STARTS = ("<!-- AGENT-USAGE:START -->", "<!-- PI-USAGE:START -->")
LEGACY_ENDS = ("<!-- AGENT-USAGE:END -->", "<!-- PI-USAGE:END -->")
TOP = 5

# 客户端：omp 为当前主力；pi/claude/codex/opencode 为历史卡片
CLIENTS = ("omp", "pi", "claude", "codex", "opencode")

# Catppuccin Macchiato 强调色（与 nix-config 多样性一致）
ACCENT = {
    "omp": "#c6a0f6",  # mauve
    "pi": "#f5bde6",  # pink
    "claude": "#f5a97f",  # peach
    "codex": "#8aadf4",  # blue
    "opencode": "#8bd5ca",  # teal
}
TITLE = {
    "omp": "OMP",
    "pi": "Pi",
    "claude": "Claude Code",
    "codex": "Codex",
    "opencode": "OpenCode",
}


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    USAGE_DIR.mkdir(parents=True, exist_ok=True)


def ccusage_cmd(client: str, omp_path: Path | None = None) -> list[str]:
    if client not in CLIENTS:
        die(f"未知 client: {client}")
    base = ["ccusage"] if shutil.which("ccusage") else (["bunx", "ccusage"] if shutil.which("bunx") else None)
    if not base:
        die("需要 ccusage 或 bunx")

    if client == "omp":
        omp_dir = omp_path or Path(os.environ.get("OMP_SESSIONS_DIR") or (Path.home() / ".omp" / "agent" / "sessions"))
        if not omp_dir.is_dir():
            die(f"OMP 会话目录不存在: {omp_dir}")
        return [*base, "pi", "daily", "--pi-path", str(omp_dir), "--json", "--offline"]
    return [*base, client, "daily", "--json", "--offline"]

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
    if client in ("omp", "pi"):
        device = name or "mio"
        if not re.fullmatch(r"[A-Za-z0-9_-]+", device):
            die(f"非法 name: {device}")
        return DATA_DIR / f"{client}-{device}.json"
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


def merge_daily_records(days: list[dict]) -> list[dict]:
    """按 date 深度合并同日数据（支持多设备数据合并），消除重复日、均值失真问题。"""
    by_date: dict[str, dict] = {}
    for d in days:
        dt = d["date"]
        if dt not in by_date:
            by_date[dt] = {
                "date": dt,
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheCreationTokens": 0,
                "totalTokens": 0,
                "totalCost": 0.0,
                "_models": defaultdict(lambda: {
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cacheReadTokens": 0,
                    "cacheCreationTokens": 0,
                    "cost": 0.0,
                }),
            }
        target = by_date[dt]
        target["inputTokens"] += int(d.get("inputTokens") or 0)
        target["outputTokens"] += int(d.get("outputTokens") or 0)
        target["cacheReadTokens"] += int(d.get("cacheReadTokens") or 0)
        target["cacheCreationTokens"] += int(d.get("cacheCreationTokens") or 0)
        target["totalTokens"] += int(d.get("totalTokens") or 0)
        target["totalCost"] += float(d.get("totalCost") or d.get("cost") or 0.0)

        for m in d.get("modelBreakdowns") or []:
            m_name = m.get("modelName") or "unknown"
            m_target = target["_models"][m_name]
            m_target["inputTokens"] += int(m.get("inputTokens") or 0)
            m_target["outputTokens"] += int(m.get("outputTokens") or 0)
            m_target["cacheReadTokens"] += int(m.get("cacheReadTokens") or 0)
            m_target["cacheCreationTokens"] += int(m.get("cacheCreationTokens") or 0)
            m_target["cost"] += float(m.get("cost") or 0.0)

    merged: list[dict] = []
    for dt in sorted(by_date.keys()):
        item = by_date[dt]
        model_dict = item.pop("_models")
        breakdowns = []
        for m_name, m_stats in model_dict.items():
            breakdowns.append({
                "modelName": m_name,
                "inputTokens": m_stats["inputTokens"],
                "outputTokens": m_stats["outputTokens"],
                "cacheReadTokens": m_stats["cacheReadTokens"],
                "cacheCreationTokens": m_stats["cacheCreationTokens"],
                "cost": m_stats["cost"],
            })
        breakdowns.sort(
            key=lambda x: x["inputTokens"] + x["outputTokens"] + x["cacheReadTokens"] + x["cacheCreationTokens"],
            reverse=True,
        )
        item["modelBreakdowns"] = breakdowns
        item["modelsUsed"] = [b["modelName"] for b in breakdowns]
        merged.append(item)
    return merged


def load_client_days(client: str) -> list[dict]:
    ensure_dirs()
    if client == "omp":
        files = sorted(DATA_DIR.glob("omp-*.json"))
        fallback = DATA_DIR / "omp.json"
        if fallback.is_file() and fallback not in files:
            files.append(fallback)
        if not files:
            die("没有 usage/data/omp-*.json，先 export --client omp")
    elif client == "pi":
        files = sorted(DATA_DIR.glob("pi-*.json"))
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
    return merge_daily_records(days)


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
    return re.sub(r"^\[(?:pi|omp)\]\s*", "", name, flags=re.I).strip()


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

    # 全量 All-Time 模型聚合（大小写不敏感归一化，精准反映各客户端生命周期主力模型）
    model_totals: dict[str, int] = defaultdict(int)
    display_names: dict[str, str] = {}
    for d in days:
        for m in d.get("modelBreakdowns") or []:
            raw_name = clean_name(str(m.get("modelName") or "?"))
            lower = raw_name.lower()
            tok = model_tokens(m)
            model_totals[lower] += tok
            if lower not in display_names or (raw_name.islower() and not display_names[lower].islower()):
                display_names[lower] = raw_name

    sorted_models = sorted(
        [(display_names[k], v) for k, v in model_totals.items()],
        key=lambda x: x[1],
        reverse=True,
    )
    dates = sorted(d["date"] for d in days)
    fr, to = (dates[0], dates[-1]) if dates else ("—", "—")
    date_str = fr if fr == to else f"{fr} · {to}"

    n_days = len(days) or 1
    active = sum(1 for d in days if day_tokens(d) > 0)
    avg_day = total // n_days
    peak_tok = max((day_tokens(d) for d in days), default=0)

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
    BAR_BG = "#24273a"
    FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,sans-serif"

    W, H = 846, 225

    def text(x, y, body, *, fill, size, weight="400", anchor=None, spacing=None) -> str:
        attrs = (
            f'x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}" '
            f'font-family="{FONT}"'
        )
        if anchor:
            attrs += f' text-anchor="{anchor}"'
        if spacing:
            attrs += f' letter-spacing="{spacing}"'
        return f"<text {attrs}>{escape(str(body))}</text>"

    parts = [
        f'<rect width="{W - 1}" height="{H - 1}" x="0.5" y="0.5" rx="6" '
        f'fill="{BG}" stroke="{STROKE}" stroke-width="1"/>',
        # 顶部标题栏
        text(30, 36, title, fill=A, size=17, weight="700"),
        text(W - 30, 35, "@shelken", fill=USER, size=13, weight="600", anchor="end"),
        text(W - 30, 50, date_str, fill=FOOT, size=11, anchor="end"),
        # 竖向列分割线
        f'<line x1="250" y1="62" x2="250" y2="202" stroke="{STROKE}" stroke-width="1"/>',
        f'<line x1="510" y1="62" x2="510" y2="202" stroke="{STROKE}" stroke-width="1"/>',
    ]

    # 第一列：ALL-TIME & ACTIVITY（x: 30 ~ 230）
    col1_x = 30
    parts += [
        text(col1_x, 74, "ALL-TIME", fill=FOOT, size=10, weight="700", spacing="1.2"),
        text(col1_x, 112, fmt_tokens(total), fill=A, size=38, weight="800"),
        text(col1_x, 132, f"tokens · {cache_pct}% cache-hit", fill=SUB, size=12),
        f'<line x1="{col1_x}" y1="144" x2="230" y2="144" stroke="{STROKE}" stroke-dasharray="3 3"/>',
        text(col1_x, 163, "Active days", fill=LBL, size=12),
        text(230, 163, str(active), fill=A, size=12, weight="700", anchor="end"),
        text(col1_x, 182, "Avg / day", fill=LBL, size=12),
        text(230, 182, fmt_tokens(avg_day), fill=A, size=12, weight="700", anchor="end"),
        text(col1_x, 201, "Peak day", fill=LBL, size=12),
        text(230, 201, fmt_tokens(peak_tok), fill=A, size=12, weight="700", anchor="end"),
    ]

    # 第二列：TOKEN MIX & PERIOD（x: 275 ~ 490）
    col2_x = 275
    col2_val = 490
    parts += [
        text(col2_x, 74, "TOKEN MIX & PERIOD", fill=FOOT, size=10, weight="700", spacing="1.2"),
        text(col2_x, 96, "Output", fill=LBL, size=12),
        text(col2_val, 96, fmt_tokens(out), fill=A, size=12, weight="700", anchor="end"),
        text(col2_x, 113, "Input", fill=LBL, size=12),
        text(col2_val, 113, fmt_tokens(inp), fill=A, size=12, weight="700", anchor="end"),
        text(col2_x, 130, "Cache read", fill=LBL, size=12),
        text(col2_val, 130, fmt_tokens(cr), fill=A, size=12, weight="700", anchor="end"),
        text(col2_x, 147, "Cache write", fill=LBL, size=12),
        text(col2_val, 147, fmt_tokens(cw), fill=A, size=12, weight="700", anchor="end"),
        f'<line x1="{col2_x}" y1="157" x2="{col2_val}" y2="157" stroke="{STROKE}" stroke-dasharray="3 3"/>',
        text(col2_x, 179, "Recent 7d", fill=LBL, size=12),
        text(col2_val, 179, fmt_tokens(t7), fill=A, size=12, weight="700", anchor="end"),
        text(col2_x, 199, "Recent 40d", fill=LBL, size=12),
        text(col2_val, 199, fmt_tokens(t40), fill=A, size=12, weight="700", anchor="end"),
    ]

    # 第三列：TOP MODELS（x: 535 ~ 816，宽 281px 独立榜单）
    col3_x = 535
    parts += [
        text(col3_x, 74, "TOP MODELS", fill=FOOT, size=10, weight="700", spacing="1.2"),
    ]

    top_models = sorted_models[:4]
    max_model_tokens = top_models[0][1] if top_models else 1

    if not top_models:
        parts.append(text(col3_x, 120, "No model breakdown available", fill=FOOT, size=12))
    else:
        bar_x = 718
        bar_w = 42
        spacing_y = 26 if len(top_models) == 4 else (32 if len(top_models) == 3 else 36)
        y_pos = 97 if len(top_models) == 4 else (102 if len(top_models) == 3 else 108)
        for name, tok in top_models:
            display_name = name if len(name) <= 25 else name[:24] + "…"
            ratio = tok / max_model_tokens if max_model_tokens > 0 else 0
            fill_w = max(2, int(bar_w * ratio))

            parts += [
                text(col3_x, y_pos, display_name, fill=USER, size=12, weight="500"),
                f'<rect x="{bar_x}" y="{y_pos - 8}" width="{bar_w}" height="6" rx="3" fill="{BAR_BG}"/>',
                f'<rect x="{bar_x}" y="{y_pos - 8}" width="{fill_w}" height="6" rx="3" fill="{A}"/>',
                text(816, y_pos, fmt_tokens(tok), fill=A, size=12, weight="700", anchor="end"),
            ]
            y_pos += spacing_y
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{escape(title)}">\n'
        + "\n".join(parts)
        + "\n</svg>\n"
    )


def build_harness_svg() -> str:
    """生成全周期 Harness 活跃图谱 SVG。"""
    daily_tokens: dict[str, int] = defaultdict(int)
    client_daily_tokens: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for c in CLIENTS:
        try:
            days = load_client_days(c)
        except SystemExit:
            continue
        for d in days:
            dt = d.get("date")
            if not dt:
                continue
            tok = day_tokens(d)
            daily_tokens[dt] += tok
            client_daily_tokens[dt][c] += tok

    if not daily_tokens:
        return ""

    all_dates = sorted(daily_tokens.keys())
    latest_date = parse_day(all_dates[-1])
    w_offset = (latest_date.weekday() + 1) % 7
    start_date = latest_date - timedelta(days=52 * 7 + w_offset)

    total_tokens = sum(daily_tokens.values())
    active_days = len([d for d, v in daily_tokens.items() if v > 0])

    first_record = parse_day(all_dates[0])
    max_streak = 0
    cur_streak = 0
    temp_streak = 0
    cur = first_record
    while cur <= latest_date:
        if daily_tokens.get(cur.isoformat(), 0) > 0:
            temp_streak += 1
            if temp_streak > max_streak:
                max_streak = temp_streak
        else:
            temp_streak = 0
        cur += timedelta(days=1)

    cur = latest_date
    while cur >= first_record:
        if daily_tokens.get(cur.isoformat(), 0) > 0:
            cur_streak += 1
            cur -= timedelta(days=1)
        else:
            break

    months_labels: list[tuple[int, str]] = []
    months_seen: dict[str, int] = {}
    cur = start_date
    w_idx = 0
    while cur <= latest_date:
        d_w = (cur.weekday() + 1) % 7
        if cur.day == 1 or cur == start_date:
            m_str = cur.strftime("%b")
            if m_str not in months_seen or (w_idx - months_seen[m_str] >= 3):
                months_labels.append((w_idx, m_str))
                months_seen[m_str] = w_idx
        if d_w == 6:
            w_idx += 1
        cur += timedelta(days=1)

    card_title = "Harness"
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg width="846" height="215" viewBox="0 0 846 215" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{escape(card_title)}">',
        '  <rect width="845" height="214" x="0.5" y="0.5" rx="6" fill="#181926" stroke="#363a4f" stroke-width="1"/>',
        f'  <text x="30" y="33" fill="#c6a0f6" font-size="16" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">{card_title}</text>',
        '  <text x="816" y="32" fill="#b8c0e0" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif" text-anchor="end">@shelken</text>',
        f'  <text x="816" y="47" fill="#6e738d" font-size="11" font-weight="400" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif" text-anchor="end">{start_date.isoformat()} · {latest_date.isoformat()}</text>',
        '  <text x="30" y="52" font-size="12" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">',
        f'    <tspan fill="#cad3f5" font-weight="700">{fmt_tokens(total_tokens)}</tspan><tspan fill="#6e738d"> tokens · </tspan>',
        f'    <tspan fill="#cad3f5" font-weight="700">{active_days}</tspan><tspan fill="#6e738d"> active days · </tspan>',
        f'    <tspan fill="#c6a0f6" font-weight="700">{cur_streak}d</tspan><tspan fill="#6e738d"> streak (max {max_streak}d)</tspan>',
        '  </text>',
    ]

    for w, m in months_labels:
        x = 52 + w * 14
        lines.append(f'  <text x="{x}" y="70" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">{m}</text>')

    lines.append('  <text x="30" y="99" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Mon</text>')
    lines.append('  <text x="30" y="127" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Wed</text>')
    lines.append('  <text x="30" y="155" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Fri</text>')

    avg_tokens = total_tokens / active_days if active_days > 0 else 1

    cur = start_date
    w_idx = 0
    while cur <= latest_date:
        d_w = (cur.weekday() + 1) % 7
        iso = cur.isoformat()
        tok = daily_tokens.get(iso, 0)
        x = 52 + w_idx * 14
        y = 78 + d_w * 14

        if tok <= 0:
            lines.append(f'  <rect x="{x}" y="{y}" width="11" height="11" rx="2" fill="#24273a"><title>{iso}: Inactive</title></rect>')
        else:
            ratio = tok / avg_tokens
            if ratio < 0.4:
                tier_name = "Light (< 0.5× avg)"
                opacity = 0.35
            elif ratio < 1.0:
                tier_name = "Moderate (~1× avg)"
                opacity = 0.60
            elif ratio < 1.8:
                tier_name = "Elevated (~1.5× avg)"
                opacity = 0.85
            else:
                tier_name = "Peak (> 2× avg)"
                opacity = 1.0

            top_client = max(client_daily_tokens[iso].items(), key=lambda item: item[1])[0] if client_daily_tokens[iso] else "omp"
            client_label = TITLE.get(top_client, top_client)
            tip = f"{iso}: {tier_name} · {client_label}"
            base_color = ACCENT.get(top_client, "#c6a0f6")
            lines.append(f'  <rect x="{x}" y="{y}" width="11" height="11" rx="2" fill="{base_color}" fill-opacity="{opacity}"><title>{escape(tip)}</title></rect>')

        if d_w == 6:
            w_idx += 1
        cur += timedelta(days=1)

    lines.extend([
        '  <text x="30" y="198" fill="#6e738d" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Harness:</text>',
        '  <circle cx="102" cy="194" r="4.5" fill="#c6a0f6"/>',
        '  <text x="112" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">OMP</text>',
        '  <circle cx="160" cy="194" r="4.5" fill="#f5bde6"/>',
        '  <text x="170" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Pi</text>',
        '  <circle cx="200" cy="194" r="4.5" fill="#f5a97f"/>',
        '  <text x="210" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Claude</text>',
        '  <circle cx="265" cy="194" r="4.5" fill="#8aadf4"/>',
        '  <text x="275" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Codex</text>',
        '  <circle cx="330" cy="194" r="4.5" fill="#8bd5ca"/>',
        '  <text x="340" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">OpenCode</text>',
        '  <text x="636" y="198" fill="#6e738d" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Intensity:</text>',
        '  <text x="690" y="198" fill="#6e738d" font-size="10" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">&lt; 0.5×</text>',
        '  <rect x="726" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.35"/>',
        '  <rect x="740" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.60"/>',
        '  <rect x="754" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.85"/>',
        '  <rect x="768" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="1.0"/>',
        '  <text x="784" y="198" fill="#6e738d" font-size="10" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">&gt; 2× avg</text>',
        '</svg>',
    ])
    return "\n".join(lines) + "\n"


def render_vibe_snake() -> Path | None:
    """调用 scripts/vibe_snake.mjs 生成动态贪吃蛇 SVG。"""
    script = ROOT / "scripts" / "vibe_snake.mjs"
    bun = shutil.which("bun")
    if not script.is_file() or not bun:
        return None
    proc = subprocess.run([bun, str(script)], capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"⚠ render_vibe_snake 失败: {proc.stderr or proc.stdout}")
        return None
    out = USAGE_DIR / "vibe-snake.svg"
    if out.is_file():
        print(f"✓ {out.relative_to(ROOT)}")
        return out
    return None

def patch_readme(rendered: list[str]) -> None:
    """rendered: 已成功写出的 client 名，按 CLIENTS 顺序。"""
    lines = [START, ""]
    if (USAGE_DIR / "vibe-snake.svg").is_file():
        rel = "./usage/vibe-snake.svg"
        lines.append(
            f'<a href="{rel}"><img class="usage-card" width="100%" src="{rel}" alt="Vibe Activity" /></a>'
        )
        lines.append("")
    if (USAGE_DIR / "harness.svg").is_file():
        rel = "./usage/harness.svg"
        lines.append(
            f'<a href="{rel}"><img class="usage-card" width="100%" src="{rel}" alt="Harness" /></a>'
        )
        lines.append("")
    for c in CLIENTS:
        if c not in rendered:
            continue
        rel = f"./usage/{c}.svg"
        label = TITLE[c]
        lines.append(
            f'<a href="{rel}"><img class="usage-card" width="100%" src="{rel}" alt="{label}" /></a>'
        )
        lines.append("")
    lines.append(END)
    block = "\n".join(lines)

    text = README.read_text(encoding="utf-8")
    if START in text and END in text:
        i = text.index(START)
        j = text.index(END) + len(END)
    else:
        found = False
        for l_start, l_end in zip(LEGACY_STARTS, LEGACY_ENDS):
            if l_start in text and l_end in text:
                i = text.index(l_start)
                j = text.index(l_end) + len(l_end)
                found = True
                break
        if not found:
            die(f"README.md 缺少 {START} / {END}")
    README.write_text(text[:i] + block + text[j:], encoding="utf-8")


def render() -> list[str]:
    ensure_dirs()
    rendered: list[str] = []
    render_vibe_snake()
    harness_svg = build_harness_svg()
    if harness_svg:
        (USAGE_DIR / "harness.svg").write_text(harness_svg, encoding="utf-8")
        print("✓ usage/harness.svg")

    for c in CLIENTS:
        try:
            days = load_client_days(c)
        except SystemExit as e:
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
    p = argparse.ArgumentParser(description="多 Harness 编码助手用量导出与 SVG 渲染")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="导出 usage/data/*.json")
    e.add_argument(
        "--client",
        default="all",
        choices=[*CLIENTS, "all"],
        help="omp|pi|claude|codex|opencode|all",
    )
    e.add_argument("--name", default="mio", help="设备数据源 ID → {client}-{name}.json")

    sub.add_parser("render", help="生成 usage/*.svg 并更新 README")
    sub.add_parser("migrate", help="根目录旧 mac-cc.json / pi-usage.svg 迁入 usage/")

    s = sub.add_parser("sync", help="导出 + 渲染")
    s.add_argument("--client", default="all", choices=[*CLIENTS, "all"])
    s.add_argument("--name", default="mio", help="设备数据源 ID → {client}-{name}.json")
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
