#!/usr/bin/env python3
"""把 shields badge 合成横向 SVG 条，避免 GitHub profile 上 img display:block 竖排 / table 边框。"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "usage" / "badges"
README = ROOT / "README.md"

# Catppuccin Macchiato（与 nix-config / home-ops badge 同逻辑）
PAL = {
    "pink": "f5bde6",
    "mauve": "c6a0f6",
    "red": "ed8796",
    "peach": "f5a97f",
    "yellow": "eed49f",
    "green": "a6da95",
    "teal": "8bd5ca",
    "sky": "91d7e3",
    "sapphire": "7dc4e4",
    "blue": "8aadf4",
    "lavender": "b7bdf8",
    "text": "cad3f5",
    "surface0": "363a4f",
}
LABEL = PAL["surface0"]
LOGO = PAL["text"]
GAP = 6
HEIGHT = 28

GROUPS: list[tuple[str, str, list[tuple[str, str, str | None]]]] = [
    (
        "languages",
        "Languages",
        [
            ("Java", "peach", "openjdk"),
            ("Python", "yellow", "python"),
            ("TypeScript", "blue", "typescript"),
            ("JavaScript", "yellow", "javascript"),
            ("Bash", "green", "gnubash"),
            ("Rust", "peach", "rust"),
            ("Lua", "lavender", "lua"),
            ("Go", "sapphire", "go"),
        ],
    ),
    (
        "java-backend",
        "Java / backend",
        [
            ("Spring_Boot", "green", "springboot"),
            ("Spring_Cloud", "teal", "spring"),
            ("MySQL", "sapphire", "mysql"),
            ("Redis", "red", "redis"),
            ("RabbitMQ", "peach", "rabbitmq"),
            ("Elasticsearch", "yellow", "elasticsearch"),
            ("Nacos", "blue", None),
            ("XXL-Job", "mauve", None),
            ("DataX", "lavender", None),
        ],
    ),
    (
        "cloud-gitops",
        "Cloud native / GitOps",
        [
            ("Docker", "blue", "docker"),
            ("Kubernetes", "sapphire", "kubernetes"),
            ("K3s", "sky", "k3s"),
            ("Flux_CD", "lavender", "flux"),
            ("Helm", "blue", "helm"),
            ("Cilium", "yellow", "cilium"),
            ("Longhorn", "mauve", None),
            ("VolSync", "sapphire", None),
            ("MinIO", "red", "minio"),
            ("CloudNativePG", "blue", "postgresql"),
            ("KEDA", "sky", None),
            ("GitHub_Actions", "lavender", "githubactions"),
        ],
    ),
    (
        "iac-secrets",
        "IaC / secrets",
        [
            ("Nix", "yellow", "NixOS"),
            ("NixOS", "yellow", "NixOS"),
            ("nix-darwin", "peach", None),
            ("Home_Manager", "blue", None),
            ("Ansible", "red", "ansible"),
            ("SOPS", "mauve", None),
            ("External_Secrets", "sapphire", None),
            ("Azure_Key_Vault", "blue", "azurekeyvault"),
            ("age", "peach", None),
        ],
    ),
    (
        "network-security",
        "Network / security",
        [
            ("Tailscale", "sky", "tailscale"),
            ("OpenWrt", "teal", "openwrt"),
            ("Nginx", "green", "nginx"),
            ("Caddy", "sapphire", "caddy"),
            ("CrowdSec", "peach", None),
            ("Authelia", "teal", None),
            ("Envoy_Gateway", "pink", "envoyproxy"),
            ("External-DNS", "blue", None),
        ],
    ),
    (
        "observability",
        "Observability",
        [
            ("Prometheus", "peach", "prometheus"),
            ("Grafana", "peach", "grafana"),
            ("Gatus", "green", None),
            ("Fluent_Bit", "teal", "fluentbit"),
            ("VictoriaLogs", "mauve", None),
        ],
    ),
    (
        "automation-vision",
        "Automation / vision",
        [
            ("Python", "yellow", "python"),
            ("FastAPI", "teal", "fastapi"),
            ("pytest", "sky", "pytest"),
            ("Playwright", "green", "playwright"),
            ("OpenCV", "blue", "opencv"),
            ("YOLO", "red", None),
            ("ADB", "green", "android"),
        ],
    ),
    (
        "macos-agent",
        "macOS / Agent",
        [
            ("TypeScript", "blue", "typescript"),
            ("Bun", "peach", "bun"),
            ("Pi_Agent", "pink", None),
            ("macOS", "text", "apple"),
            ("Rust", "peach", "rust"),
            ("Neovim", "green", "neovim"),
            ("Zed", "sapphire", None),
            ("mise", "lavender", None),
        ],
    ),
]


def badge_url(label: str, color: str, logo: str | None) -> str:
    name = label.replace(" ", "_")
    q = f"style=for-the-badge&labelColor={LABEL}&color={color}&logoColor={LOGO}"
    if logo:
        q += f"&logo={logo}"
    return f"https://img.shields.io/badge/{name}-{color}?label=&{q}"


def fetch(url: str, retries: int = 4) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "shelken-build-badges"})
    last: Exception | None = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001 — 网络抖动重试
            last = e
            import time

            time.sleep(0.6 * (i + 1))
    assert last is not None
    raise last


def parse_svg(svg: str) -> tuple[float, float, str]:
    m = re.search(
        r"<svg\b([^>]*)>(.*)</svg\s*>",
        svg,
        flags=re.I | re.S,
    )
    if not m:
        raise ValueError("invalid svg")
    attrs, inner = m.group(1), m.group(2)
    wm = re.search(r'\bwidth="([\d.]+)"', attrs)
    hm = re.search(r'\bheight="([\d.]+)"', attrs)
    if not wm or not hm:
        raise ValueError(f"missing width/height in {attrs[:80]}")
    return float(wm.group(1)), float(hm.group(1)), inner.strip()


def compose(items: list[tuple[str, str, str | None]]) -> str:
    parts: list[str] = []
    x = 0.0
    height = float(HEIGHT)
    for label, key, logo in items:
        url = badge_url(label, PAL[key], logo)
        try:
            raw = fetch(url)
        except urllib.error.URLError as e:
            raise SystemExit(f"fetch failed {label}: {e}") from e
        w, h, inner = parse_svg(raw)
        height = max(height, h)
        # nested svg keeps badge internal coords; position via x
        parts.append(
            f'<svg x="{x:.2f}" y="0" width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">{inner}</svg>'
        )
        x += w + GAP
    total_w = x - GAP if items else 0
    body = "\n".join(parts)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w:.2f}" height="{height}" '
        f'role="img" aria-label="tech badges">\n{body}\n</svg>\n'
    )


def patch_readme(built: list[tuple[str, str]]) -> None:
    """built: (title, rel_path) in order."""
    lines = ["### Tech stack", ""]
    for title, rel in built:
        lines.append(f"**{title}**")
        lines.append("")
        # 单图横条：profile/仓库都不会竖排；无 table 边框
        lines.append(f'<img alt="{title}" src="{rel}" height="{HEIGHT}" />')
        lines.append("")
    block = "\n".join(lines).rstrip() + "\n"

    text = README.read_text(encoding="utf-8")
    if "### Tech stack" not in text:
        raise SystemExit("README missing ### Tech stack")
    start = text.index("### Tech stack")
    if "\nMore on [blog" in text[start:]:
        end = text.rindex("\nMore on [blog")
    else:
        end = len(text)
    README.write_text(text[:start] + block + text[end:], encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    built: list[tuple[str, str]] = []
    for slug, title, items in GROUPS:
        svg = compose(items)
        path = OUT / f"{slug}.svg"
        path.write_text(svg, encoding="utf-8")
        rel = f"./usage/badges/{slug}.svg"
        built.append((title, rel))
        print(f"✓ {path.relative_to(ROOT)}  ({path.stat().st_size} bytes)")
    patch_readme(built)
    print(f"✓ README Tech stack → {len(built)} strips")


if __name__ == "__main__":
    main()
