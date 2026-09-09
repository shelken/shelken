#!/usr/bin/env bun
/**
 * 把 shields badge 合成横向 SVG 条，避免 GitHub profile 上 img display:block 竖排 / table 边框。
 *
 * 用法:
 *   bun scripts/build_badges.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = join(ROOT, "usage", "badges");
const README = join(ROOT, "README.md");

// Catppuccin Macchiato 配色
export const PAL = {
  pink: "f5bde6",
  mauve: "c6a0f6",
  red: "ed8796",
  peach: "f5a97f",
  yellow: "eed49f",
  green: "a6da95",
  teal: "8bd5ca",
  sky: "91d7e3",
  sapphire: "7dc4e4",
  blue: "8aadf4",
  lavender: "b7bdf8",
  text: "cad3f5",
  surface0: "363a4f",
} as const;

export type PalKey = keyof typeof PAL;

const LABEL = PAL.surface0;
const LOGO = PAL.text;
const GAP = 6;
const HEIGHT = 28;
const MAX_ROW_WIDTH = 860;

export type BadgeItem = [label: string, colorKey: PalKey, logo?: string | null];

export interface BadgeGroup {
  slug: string;
  title: string;
  items: BadgeItem[];
}

export const GROUPS: BadgeGroup[] = [
  {
    slug: "languages",
    title: "Languages",
    items: [
      ["Java", "peach", "openjdk"],
      ["Python", "yellow", "python"],
      ["TypeScript", "blue", "typescript"],
      ["JavaScript", "yellow", "javascript"],
      ["Bash", "green", "gnubash"],
      ["Rust", "peach", "rust"],
      ["Lua", "lavender", "lua"],
      ["Go", "sapphire", "go"],
    ],
  },
  {
    slug: "java-backend",
    title: "Java / backend",
    items: [
      ["Spring_Boot", "green", "springboot"],
      ["Spring_Cloud", "teal", "spring"],
      ["MySQL", "sapphire", "mysql"],
      ["Redis", "red", "redis"],
      ["RabbitMQ", "peach", "rabbitmq"],
      ["Elasticsearch", "yellow", "elasticsearch"],
      ["Nacos", "blue", null],
      ["XXL-Job", "mauve", null],
      ["DataX", "lavender", null],
    ],
  },
  {
    slug: "cloud-gitops",
    title: "Cloud native / GitOps",
    items: [
      ["Docker", "blue", "docker"],
      ["Kubernetes", "sapphire", "kubernetes"],
      ["K3s", "sky", "k3s"],
      ["Flux_CD", "lavender", "flux"],
      ["Helm", "blue", "helm"],
      ["Cilium", "yellow", "cilium"],
      ["Longhorn", "mauve", null],
      ["VolSync", "sapphire", null],
      ["MinIO", "red", "minio"],
      ["CloudNativePG", "blue", "postgresql"],
      ["KEDA", "sky", null],
      ["GitHub_Actions", "lavender", "githubactions"],
    ],
  },
  {
    slug: "iac-secrets",
    title: "IaC / secrets",
    items: [
      ["Nix", "yellow", "NixOS"],
      ["NixOS", "yellow", "NixOS"],
      ["nix-darwin", "peach", null],
      ["Home_Manager", "blue", null],
      ["Ansible", "red", "ansible"],
      ["SOPS", "mauve", null],
      ["External_Secrets", "sapphire", null],
      ["Azure_Key_Vault", "blue", "azurekeyvault"],
      ["age", "peach", null],
    ],
  },
  {
    slug: "network-security",
    title: "Network / security",
    items: [
      ["Tailscale", "sky", "tailscale"],
      ["OpenWrt", "teal", "openwrt"],
      ["Nginx", "green", "nginx"],
      ["Caddy", "sapphire", "caddy"],
      ["CrowdSec", "peach", null],
      ["Authelia", "teal", null],
      ["Envoy_Gateway", "pink", "envoyproxy"],
      ["External-DNS", "blue", null],
    ],
  },
  {
    slug: "observability",
    title: "Observability",
    items: [
      ["Prometheus", "peach", "prometheus"],
      ["Grafana", "peach", "grafana"],
      ["Gatus", "green", null],
      ["Fluent_Bit", "teal", "fluentbit"],
      ["VictoriaLogs", "mauve", null],
    ],
  },
  {
    slug: "automation-vision",
    title: "Automation / vision",
    items: [
      ["Python", "yellow", "python"],
      ["FastAPI", "teal", "fastapi"],
      ["pytest", "sky", "pytest"],
      ["Playwright", "green", "playwright"],
      ["OpenCV", "blue", "opencv"],
      ["YOLO", "red", null],
      ["ADB", "green", "android"],
    ],
  },
  {
    slug: "macos-agent",
    title: "macOS / Agent",
    items: [
      ["TypeScript", "blue", "typescript"],
      ["Bun", "peach", "bun"],
      ["Pi_Agent", "pink", null],
      ["macOS", "text", "apple"],
      ["Rust", "peach", "rust"],
      ["Neovim", "green", "neovim"],
      ["Zed", "sapphire", null],
      ["mise", "lavender", null],
    ],
  },
];

export async function fetchBadge(url: string, retries = 4): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "shelken-build-badges" },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        return await res.text();
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await Bun.sleep(600 * (i + 1));
    }
  }
  throw lastErr || new Error("fetch failed");
}
export function parseSvg(svg: string): [width: number, height: number, inner: string] {
  const m = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg\s*>/i);
  if (!m) throw new Error("invalid svg");

  const attrs = m[1];
  const inner = m[2].trim();

  const wm = attrs.match(/\bwidth="([\d.]+)"/);
  const hm = attrs.match(/\bheight="([\d.]+)"/);
  if (!wm || !hm) throw new Error(`missing width/height in ${attrs.slice(0, 80)}`);

  return [parseFloat(wm[1]), parseFloat(hm[1]), inner];
}

export async function composeBadges(items: BadgeItem[]): Promise<string> {
  const parts: string[] = [];
  let x = 0.0;
  let y = 0.0;
  let rowH = Number(HEIGHT);
  let maxW = 0.0;

  for (const [label, key, logo] of items) {
    const name = label.replace(/\s+/g, "_");
    const color = PAL[key];
    let q = `style=for-the-badge&labelColor=${LABEL}&color=${color}&logoColor=${LOGO}`;
    if (logo) q += `&logo=${logo}`;
    const url = `https://img.shields.io/badge/${name}-${color}?label=&${q}`;

    const raw = await fetchBadge(url);
    const [w, h, inner] = parseSvg(raw);
    rowH = Math.max(rowH, h);

    if (x > 0 && x + w > MAX_ROW_WIDTH) {
      maxW = Math.max(maxW, x - GAP);
      y += rowH + GAP;
      x = 0.0;
      rowH = h;
    }

    parts.push(
      `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
    );
    x += w + GAP;
  }

  maxW = Math.max(maxW, items.length > 0 ? x - GAP : 0);
  const totalH = y + rowH;
  const body = parts.join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxW.toFixed(2)}" height="${totalH.toFixed(2)}" role="img" aria-label="tech badges">\n` +
    `${body}\n` +
    `</svg>\n`
  );
}

export function patchReadme(built: [title: string, relPath: string][]): void {
  const lines = ["### Tech stack", ""];
  for (const [title, rel] of built) {
    lines.push(`**${title}**`, "", `<img alt="${title}" src="${rel}" />`, "");
  }
  const block = lines.join("\n").trimEnd() + "\n";

  const text = readFileSync(README, "utf-8");
  const target = "### Tech stack";
  if (!text.includes(target)) {
    throw new Error("README missing ### Tech stack");
  }

  const start = text.indexOf(target);
  const afterStart = text.slice(start);
  const marker = "\nMore on [blog";
  const end = afterStart.includes(marker) ? start + afterStart.lastIndexOf(marker) : text.length;

  writeFileSync(README, text.slice(0, start) + block + text.slice(end), "utf-8");
}

export async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const built: [string, string][] = [];

  for (const group of GROUPS) {
    const svg = await composeBadges(group.items);
    const path = join(OUT, `${group.slug}.svg`);
    writeFileSync(path, svg, "utf-8");
    const rel = `./usage/badges/${group.slug}.svg`;
    built.push([group.title, rel]);
    console.log(`✓ usage/badges/${group.slug}.svg`);
  }

  patchReadme(built);
  console.log(`✓ README Tech stack → ${built.length} strips`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
