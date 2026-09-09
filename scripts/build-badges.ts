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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAL,
  type PalKey,
  isPalKey,
  LABEL,
  LOGO,
  GAP,
  HEIGHT,
  MAX_ROW_WIDTH,
  DEFAULT_CONCURRENCY,
  type BadgeItem,
  type BadgeGroup,
  BadgeFetchError,
  BadgeMissingError,
} from "./badges/types";

import {
  ROOT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CACHE_DIR,
  slugify,
  getBadgeUrl,
  getCacheFileName,
  normalizeBadgeItem,
  normalizeBadgeGroup,
  loadBadgeConfig,
  fetchBadge,
  fetchBadges,
  preloadBadges,
} from "./badges/store";

import {
  parseSvg,
  composeBadges as syncComposeBadges,
} from "./badges/layout";
// 向后兼容导出
export {
  PAL,
  type PalKey,
  isPalKey,
  LABEL,
  LOGO,
  GAP,
  HEIGHT,
  MAX_ROW_WIDTH,
  DEFAULT_CONCURRENCY,
  type BadgeItem,
  type BadgeGroup,
  BadgeFetchError,
  BadgeMissingError,
  slugify,
  getBadgeUrl,
  getCacheFileName,
  normalizeBadgeItem,
  normalizeBadgeGroup,
  loadBadgeConfig,
  fetchBadge,
  fetchBadges,
  preloadBadges,
  parseSvg,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const CACHE_DIR = DEFAULT_CACHE_DIR;
export const OUT = join(ROOT, "assets", "badges");
export const README = join(ROOT, "README.md");

export { DEFAULT_CONFIG_PATH };

// 供向后兼容外部引用
export const GROUPS: BadgeGroup[] = existsSync(DEFAULT_CONFIG_PATH) ? loadBadgeConfig(DEFAULT_CONFIG_PATH) : [];
/**
 * 向后兼容导出的 composeBadges：
 * 允许外部遗留调用者使用 await composeBadges(items)（不传 badgeMap 时自动预取）；
 * 若提供了 badgeMap 则直接委托给纯同步排版引擎。
 */
export async function composeBadges(
  items: BadgeItem[],
  badgeMap?: Map<string, string>
): Promise<string> {
  const map = badgeMap ?? (await fetchBadges(items, { cacheDir: CACHE_DIR }));
  return syncComposeBadges(items, map);
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
  const badgeMap = await fetchBadges(allItems, { useCache, concurrency, cacheDir: CACHE_DIR });
  const fetchDuration = (performance.now() - fetchT0).toFixed(0);

  mkdirSync(OUT, { recursive: true });
  const built: [string, string][] = [];

  // 2. 纯同步内存排版并写入文件
  for (const group of groups) {
    const svg = syncComposeBadges(group.items, badgeMap);
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
