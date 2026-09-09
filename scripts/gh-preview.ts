#!/usr/bin/env bun
/**
 * 用 GitHub 官方 Markdown API 渲染 README，本地静态服务（比 grip 更接近 GitHub）。
 *
 * 用法:
 *   bun scripts/gh_preview.ts [--port 6450] [--light] [--once] [--open] [--context user/repo]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_PORT = 6450;

function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"]);
    if (proc.exitCode === 0) {
      const tok = proc.stdout.toString().trim();
      if (tok) return tok;
    }
  } catch {
    // gh cli not installed or no auth
  }
  return null;
}

export async function renderMarkdown(md: string, context?: string | null): Promise<string> {
  const payload: Record<string, string> = { text: md, mode: "gfm" };
  if (context) {
    payload.context = context;
  }

  const headers: Record<string, string> = {
    "User-Agent": "gh_preview/1.0",
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  };

  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API HTTP ${res.status}: ${body}`);
  }

  return res.text();
}

export function buildHtml(article: string, dark: boolean): string {
  const bg = dark ? "#181926" : "#eff1f5";
  const surface = dark ? "#24273a" : "#e6e9ef";
  const text = dark ? "#cad3f5" : "#4c4f69";
  const pink = "#f5bde6";
  const link = dark ? pink : "#8839ef";
  const css = dark ? "github-markdown-dark.min.css" : "github-markdown-light.min.css";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>README preview (Macchiato)</title>
  <link rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/${css}" />
  <style>
    html, body {
      margin: 0;
      background: ${bg};
      color: ${text};
    }
    body {
      display: flex;
      justify-content: center;
      padding: 24px 12px 48px;
    }
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      width: 100%;
      padding: 32px 40px;
      background: ${surface};
      color: ${text};
      border: 1px solid #363a4f;
      border-radius: 8px;
    }
    .markdown-body a { color: ${link}; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
      color: ${text};
      border-bottom-color: #363a4f;
    }
    .markdown-body hr { background-color: #363a4f; height: 1px; border: 0; }
    /* usage 全宽卡 */
    .markdown-body img.usage-card,
    .markdown-body a img[src*="/usage/"],
    .markdown-body img[src*="/usage/"] {
      display: block;
      width: 100% !important;
      max-width: 100% !important;
      height: auto !important;
      margin: 8px 0 16px;
    }
    /* badges 徽章组 */
    .markdown-body a img[src*="/badges/"],
    .markdown-body img[src*="/badges/"] {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 6px 0 12px;
    }
    /* shields badge 横排 */
    .markdown-body p > a > img[src*="shields.io"],
    .markdown-body p > a > img[src*="camo.githubusercontent.com"],
    .markdown-body p > img[src*="shields.io"] {
      display: inline-block;
      height: 22px;
      width: auto;
      max-width: none;
      vertical-align: middle;
      margin: 2px 2px;
    }
  </style>
</head>
<body>
  <article class="markdown-body">
${article}
  </article>
</body>
</html>
`;
}

export async function writePreview(outPath: string, dark: boolean, context?: string | null): Promise<void> {
  const mdPath = join(ROOT, "README.md");
  const md = readFileSync(mdPath, "utf-8");
  const article = await renderMarkdown(md, context);
  writeFileSync(outPath, buildHtml(article, dark), "utf-8");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url];
  Bun.spawn(cmd);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let dark = true;
  let once = false;
  let shouldOpen = false;
  let context: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10) || DEFAULT_PORT;
    } else if (a === "--light") {
      dark = false;
    } else if (a === "--once") {
      once = true;
    } else if (a === "--open") {
      shouldOpen = true;
    } else if (a === "--context" && args[i + 1]) {
      context = args[++i];
    }
  }

  const outHtml = join(ROOT, ".readme-preview.html");
  const htmlName = ".readme-preview.html";

  await writePreview(outHtml, dark, context);
  console.log(`wrote ${htmlName}`);

  if (once) return;

  const url = `http://127.0.0.1:${port}/${htmlName}`;
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const reqUrl = new URL(req.url);
      let pathname = decodeURIComponent(reqUrl.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = `/${htmlName}`;
      }

      const filePath = resolve(ROOT, pathname.replace(/^\/+/, ""));
      if (!filePath.startsWith(ROOT)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (existsSync(filePath)) {
        const file = Bun.file(filePath);
        return new Response(file);
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`Preview ready: ${url} (Ctrl+C to stop)`);

  if (shouldOpen) {
    openBrowser(url);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
