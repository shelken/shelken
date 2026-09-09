#!/usr/bin/env bun
/**
 * 把 shields badge 合成横向 SVG 条，避免 GitHub profile 上 img display:block 竖排 / table 边框。
 *
 * 数据源:
 *   config/tech-stack.yaml
 *
 * 用法:
 *   bun scripts/build-badges.ts
 *   bun scripts/build-badges.ts --no-cache
 *   bun scripts/build-badges.ts --config custom-path.yaml --concurrency 12
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const DEFAULT_CONFIG_PATH = join(ROOT, "config", "tech-stack.yaml");
export const CACHE_DIR = join(ROOT, ".cache", "badges");
export const OUT = join(ROOT, "assets", "badges");
export const README = join(ROOT, "README.md");

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
export const MAX_ROW_WIDTH = 860;
const DEFAULT_CONCURRENCY = 10;

export type BadgeItem = [label: string, colorKey: PalKey, logo?: string | null];

export interface BadgeGroup {
  slug: string;
  title: string;
  items: BadgeItem[];
}

export function isPalKey(color: string): color is PalKey {
  return Object.hasOwn(PAL, color);
}

/**
 * 将标题转换为 kebab-case 格式的文件名 slug
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 构造特定 badge 的 shields.io 请求 URL
 */
export function getBadgeUrl(item: BadgeItem): string {
  const [label, key, logo] = item;
  const name = label.replace(/\s+/g, "_");
  const color = PAL[key];
  let q = `style=for-the-badge&labelColor=${LABEL}&color=${color}&logoColor=${LOGO}`;
  if (logo) q += `&logo=${encodeURIComponent(logo)}`;
  return `https://img.shields.io/badge/${encodeURIComponent(name)}-${color}?label=&${q}`;
}

/**
 * 生成基于 URL 的本地缓存安全文件名
 */
export function getCacheFileName(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const match = url.match(/\/badge\/([^?]+)/);
  const prefix = match ? match[1].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) : "badge";
  return `${prefix}-${hash}.svg`;
}

/**
 * 将各种 YAML item 表示归一化为标准的 BadgeItem 元组
 */
export function normalizeBadgeItem(raw: unknown, index: number, groupTitle: string): BadgeItem {
  if (Array.isArray(raw)) {
    const [label, color, logo] = raw;
    if (typeof label !== "string" || !label.trim()) {
      throw new Error(`Group "${groupTitle}" item #${index}: label must be a non-empty string`);
    }
    if (typeof color !== "string" || !isPalKey(color)) {
      throw new Error(
        `Group "${groupTitle}" item "${label}": invalid color "${color}". Allowed colors: ${Object.keys(PAL).join(", ")}`
      );
    }
    const cleanLogo = typeof logo === "string" && logo.trim() ? logo.trim() : null;
    return [label.trim(), color, cleanLogo];
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rawLabel = obj.name ?? obj.label;
    if (typeof rawLabel !== "string" || !rawLabel.trim()) {
      throw new Error(`Group "${groupTitle}" item #${index}: missing or invalid "name" string`);
    }
    const color = obj.color;
    if (typeof color !== "string" || !isPalKey(color)) {
      throw new Error(
        `Group "${groupTitle}" item "${rawLabel}": invalid color "${color}". Allowed colors: ${Object.keys(PAL).join(", ")}`
      );
    }
    const logo = obj.logo;
    const cleanLogo = typeof logo === "string" && logo.trim() ? logo.trim() : null;
    return [rawLabel.trim(), color, cleanLogo];
  }

  throw new Error(`Group "${groupTitle}" item #${index}: expected an object or array item, got ${typeof raw}`);
}

/**
 * 校验并归一化分组定义
 */
export function normalizeBadgeGroup(raw: unknown, groupIndex: number): BadgeGroup {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid group definition at index ${groupIndex}: expected an object`);
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new Error(`Group at index ${groupIndex} is missing a valid "title" string`);
  }
  const title = obj.title.trim();

  const slug = typeof obj.slug === "string" && obj.slug.trim()
    ? obj.slug.trim()
    : slugify(title);

  if (!slug) {
    throw new Error(`Unable to determine slug for group "${title}"`);
  }

  const rawItems = obj.items ?? obj.badges;
  if (!Array.isArray(rawItems)) {
    throw new Error(`Group "${title}" is missing an "items" array`);
  }

  const items = rawItems.map((item, itemIdx) => normalizeBadgeItem(item, itemIdx, title));
  return { slug, title, items };
}

/**
 * 加载并解析 YAML 配置文件中的 badge 分组
 */
export function loadBadgeConfig(configPath: string = DEFAULT_CONFIG_PATH): BadgeGroup[] {
  if (!existsSync(configPath)) {
    throw new Error(`Badge configuration file not found at: ${configPath}`);
  }

  const content = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(content);

  if (!parsed) {
    throw new Error(`Empty or invalid YAML file at: ${configPath}`);
  }

  const rawGroups = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>).groups)
      ? (parsed as Record<string, unknown>).groups
      : null;

  if (!rawGroups || !Array.isArray(rawGroups)) {
    throw new Error(`Configuration in "${configPath}" must contain a top-level "groups" array or be an array of groups`);
  }

  return rawGroups.map((g, idx) => normalizeBadgeGroup(g, idx));
}

// 供向后兼容外部引用
export const GROUPS: BadgeGroup[] = existsSync(DEFAULT_CONFIG_PATH) ? loadBadgeConfig(DEFAULT_CONFIG_PATH) : [];

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
      await Bun.sleep(500 * (i + 1));
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

/**
 * 预加载所有用到的 badge，支持并发池拉取与磁盘缓存
 */
export async function preloadBadges(
  items: BadgeItem[],
  options: {
    useCache?: boolean;
    cacheDir?: string;
    concurrency?: number;
  } = {}
): Promise<Map<string, string>> {
  const useCache = options.useCache ?? true;
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  if (useCache) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // 去重收集 URL
  const urlMap = new Map<string, string>(); // url -> cachedSvg
  const urlsToFetch: string[] = [];

  for (const item of items) {
    const url = getBadgeUrl(item);
    if (urlMap.has(url)) continue;

    if (useCache) {
      const cachePath = join(cacheDir, getCacheFileName(url));
      if (existsSync(cachePath)) {
        try {
          const cached = readFileSync(cachePath, "utf-8");
          urlMap.set(url, cached);
          continue;
        } catch {
          // 缓存读取异常则回退重新拉取
        }
      }
    }

    urlMap.set(url, "");
    urlsToFetch.push(url);
  }

  if (urlsToFetch.length > 0) {
    const queue = [...urlsToFetch];
    const workers = Array.from({ length: Math.min(concurrency, urlsToFetch.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        const svg = await fetchBadge(url);
        urlMap.set(url, svg);

        if (useCache) {
          try {
            const cachePath = join(cacheDir, getCacheFileName(url));
            writeFileSync(cachePath, svg, "utf-8");
          } catch {
            // 写入缓存失败不阻断流程
          }
        }
      }
    });

    await Promise.all(workers);
  }

  return urlMap;
}

/**
 * 把 items 排版合成为一个大 SVG 条
 * 可接收预取好的 badgeMap 进行纯同步内存排版；未传时回退到逐个获取（兼容老接口）
 */
export async function composeBadges(
  items: BadgeItem[],
  badgeMap?: Map<string, string>
): Promise<string> {
  const parts: string[] = [];
  let x = 0.0;
  let y = 0.0;
  let rowH = Number(HEIGHT);
  let maxW = 0.0;

  for (const item of items) {
    const url = getBadgeUrl(item);
    let raw = badgeMap?.get(url);
    if (!raw) {
      raw = await fetchBadge(url);
    }

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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAX_ROW_WIDTH} ${totalH.toFixed(2)}" width="${MAX_ROW_WIDTH}" height="${totalH.toFixed(2)}" role="img" aria-label="tech badges">\n` +
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

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const t0 = performance.now();
  let configPath = DEFAULT_CONFIG_PATH;
  let useCache = true;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = resolve(process.cwd(), args[i + 1]);
      i++;
    } else if (args[i] === "--no-cache") {
      useCache = false;
    } else if (args[i] === "--concurrency" && i + 1 < args.length) {
      concurrency = parseInt(args[i + 1], 10) || DEFAULT_CONCURRENCY;
      i++;
    }
  }

  console.log(`[Badges] Loading tech stack from: ${configPath}`);
  const groups = loadBadgeConfig(configPath);

  // 1. 收集所有 items 并发预取/读取缓存
  const allItems = groups.flatMap((g) => g.items);
  const fetchT0 = performance.now();
  const badgeMap = await preloadBadges(allItems, { useCache, concurrency });
  const fetchDuration = (performance.now() - fetchT0).toFixed(0);

  mkdirSync(OUT, { recursive: true });
  const built: [string, string][] = [];

  // 2. 同步内存排版并写入文件
  for (const group of groups) {
    const svg = await composeBadges(group.items, badgeMap);
    const path = join(OUT, `${group.slug}.svg`);
    writeFileSync(path, svg, "utf-8");
    const rel = `./assets/badges/${group.slug}.svg`;
    built.push([group.title, rel]);
    console.log(`✓ assets/badges/${group.slug}.svg`);
  }

  patchReadme(built);
  const totalDuration = (performance.now() - t0).toFixed(0);
  console.log(`✓ README Tech stack → ${built.length} strips`);
  console.log(`⚡ Finished in ${totalDuration}ms (badges load: ${fetchDuration}ms, cache: ${useCache ? "on" : "off"})`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
