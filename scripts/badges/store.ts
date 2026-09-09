import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  PAL,
  type PalKey,
  LABEL,
  LOGO,
  DEFAULT_CONCURRENCY,
  type BadgeItem,
  type BadgeGroup,
  isPalKey,
  BadgeFetchError,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, "../..");
export const DEFAULT_CONFIG_PATH = join(ROOT_DIR, "config", "tech-stack.yaml");
export const DEFAULT_CACHE_DIR = join(ROOT_DIR, ".cache", "badges");

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
    const cleanLogo = typeof obj.logo === "string" && obj.logo.trim() ? obj.logo.trim() : null;
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

/**
 * 单个徽章 HTTP 抓取，带重试机制
 */
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
  throw new BadgeFetchError(url, lastErr?.message || "fetch failed");
}

export interface BadgeStoreOptions {
  useCache?: boolean;
  cacheDir?: string;
  concurrency?: number;
  retries?: number;
}

/**
 * 资产获取深接口：双适配器模式（本地磁盘缓存 vs Shields.io 并发池）
 */
export async function fetchBadges(
  items: BadgeItem[],
  options: BadgeStoreOptions = {}
): Promise<Map<string, string>> {
  const useCache = options.useCache ?? true;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const retries = options.retries ?? 4;
  if (useCache) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // 去重收集 URL
  const urlMap = new Map<string, string>(); // url -> svg content
  const queuedUrls = new Set<string>();
  const urlsToFetch: string[] = [];

  for (const item of items) {
    const url = getBadgeUrl(item);
    if (urlMap.has(url) || queuedUrls.has(url)) continue;

    if (useCache) {
      const cachePath = join(cacheDir, getCacheFileName(url));
      if (existsSync(cachePath)) {
        try {
          const cached = readFileSync(cachePath, "utf-8");
          urlMap.set(url, cached);
          continue;
        } catch {
          // 缓存读取失败时回退到重新拉取
        }
      }
    }

    queuedUrls.add(url);
    urlsToFetch.push(url);
  }
  if (urlsToFetch.length > 0) {
    const queue = [...urlsToFetch];
    const workers = Array.from({ length: Math.min(concurrency, urlsToFetch.length) }, async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        const svg = await fetchBadge(url, retries);
        urlMap.set(url, svg);

        if (useCache) {
          try {
            const cachePath = join(cacheDir, getCacheFileName(url));
            writeFileSync(cachePath, svg, "utf-8");
          } catch {
            // 写入磁盘缓存失败不阻断内存中可用性
          }
        }
      }
    });

    await Promise.all(workers);
  }

  return urlMap;
}

// 别名向后兼容
export const preloadBadges = fetchBadges;
