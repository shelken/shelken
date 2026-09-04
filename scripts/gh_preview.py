#!/usr/bin/env python3
"""用 GitHub 官方 Markdown API 渲染 README，本地静态服务（比 grip 更接近 GitHub）。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 6450


def render_markdown(md: str, *, context: str | None = None) -> str:
    payload: dict = {"text": md, "mode": "gfm"}
    if context:
        payload["context"] = context
    body = json.dumps(payload)
    r = subprocess.run(
        ["gh", "api", "markdown", "--input", "-"],
        input=body,
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "gh api markdown failed\n")
        raise SystemExit(r.returncode or 1)
    return r.stdout


def build_html(article: str, *, dark: bool) -> str:
    # Catppuccin Macchiato（与 badge / agent-usage 一致）
    # crust / base / text / pink / surface0
    bg = "#181926" if dark else "#eff1f5"  # crust / latte base
    surface = "#24273a" if dark else "#e6e9ef"
    text = "#cad3f5" if dark else "#4c4f69"
    pink = "#f5bde6"
    link = pink if dark else "#8839ef"
    css = (
        "github-markdown-dark.min.css"
        if dark
        else "github-markdown-light.min.css"
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>README preview (Macchiato)</title>
  <link rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/{css}" />
  <style>
    html, body {{
      margin: 0;
      background: {bg};
      color: {text};
    }}
    body {{
      display: flex;
      justify-content: center;
      padding: 24px 12px 48px;
    }}
    .markdown-body {{
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      width: 100%;
      padding: 32px 40px;
      background: {surface};
      color: {text};
      border: 1px solid #363a4f;
      border-radius: 8px;
    }}
    .markdown-body a {{ color: {link}; }}
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {{
      color: {text};
      border-bottom-color: #363a4f;
    }}
    .markdown-body hr {{ background-color: #363a4f; height: 1px; border: 0; }}
    /* usage 全宽卡：勿套 badge 高度 */
    .markdown-body img.usage-card,
    .markdown-body a img[src$=".svg"] {{
      display: block;
      width: 100% !important;
      max-width: 100% !important;
      height: auto !important;
      margin: 8px 0 16px;
    }}
    /* shields badge 横排 */
    .markdown-body p > a > img[src*="shields.io"],
    .markdown-body p > a > img[src*="camo.githubusercontent.com"],
    .markdown-body p > img[src*="shields.io"] {{
      display: inline-block;
      height: 22px;
      width: auto;
      max-width: none;
      vertical-align: middle;
      margin: 2px 2px;
    }}
  </style>
</head>
<body>
  <article class="markdown-body">
{article}
  </article>
</body>
</html>
"""


def write_preview(out: Path, *, dark: bool, context: str | None) -> None:
    md_path = ROOT / "README.md"
    md = md_path.read_text(encoding="utf-8")
    article = render_markdown(md, context=context)
    out.write_text(build_html(article, dark=dark), encoding="utf-8")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def serve(port: int, html_name: str) -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/{html_name}"
    print(url, flush=True)
    httpd.serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description="GitHub-accurate local README preview")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--light", action="store_true", help="浅色主题（默认 dark）")
    ap.add_argument(
        "--context",
        default="shelken/shelken",
        help="GFM context owner/repo（默认 shelken/shelken）",
    )
    ap.add_argument(
        "--no-context",
        action="store_true",
        help="不传 context",
    )
    ap.add_argument(
        "--once",
        action="store_true",
        help="只写 HTML，不启动 HTTP 服务",
    )
    ap.add_argument(
        "--open",
        action="store_true",
        help="启动后打开浏览器",
    )
    args = ap.parse_args()

    out = ROOT / ".readme-preview.html"
    ctx = None if args.no_context else args.context
    write_preview(out, dark=not args.light, context=ctx)
    print(f"wrote {out.relative_to(ROOT)}", flush=True)

    if args.once:
        return

    if args.open:
        threading.Timer(
            0.4, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}/{out.name}")
        ).start()

    try:
        serve(args.port, out.name)
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
