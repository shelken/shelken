import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BadgeItem,
  BadgeFetchError,
  BadgeMissingError,
  GAP,
  MAX_ROW_WIDTH,
  PAL,
} from "./badges/types";
import {
  DEFAULT_CONFIG_PATH,
  fetchBadges,
  getBadgeUrl,
  getCacheFileName,
  loadBadgeConfig,
  normalizeBadgeGroup,
  normalizeBadgeItem,
  ROOT_DIR,
  slugify,
} from "./badges/store";
import {
  composeBadges,
  parseSvg,
} from "./badges/layout";
import { composeBadges as legacyComposeBadges } from "./build-badges";

describe("BadgeLayout - parseSvg", () => {
  it("解析提取 SVG 宽度、高度与内部子图元", () => {
    const raw = `<svg width="88.5" height="28" viewBox="0 0 88.5 28" xmlns="http://www.w3.org/2000/svg"><g id="content"><rect/></g></svg>`;
    const [w, h, inner] = parseSvg(raw);
    expect(w).toBe(88.5);
    expect(h).toBe(28);
    expect(inner).toBe('<g id="content"><rect/></g>');
  });

  it("当缺失 width 或 height 属性时抛出异常", () => {
    const invalid = `<svg viewBox="0 0 100 28"><g/></svg>`;
    expect(() => parseSvg(invalid)).toThrow("missing width/height");
  });

  it("当非合法 SVG 格式时抛出异常", () => {
    expect(() => parseSvg("not an svg")).toThrow("invalid svg");
  });
});

describe("BadgeStore - 基础工具与名称标准化", () => {
  it("slugify 将标题转换为 kebab-case 格式", () => {
    expect(slugify("Languages & Runtime")).toBe("languages-runtime");
    expect(slugify("Java Backend (Modern)")).toBe("java-backend-modern");
    expect(slugify("Cloud / GitOps")).toBe("cloud-gitops");
    expect(slugify("---Trim Test---")).toBe("trim-test");
  });

  it("getBadgeUrl 构造标准 Shields.io 请求 URL", () => {
    const itemWithLogo: BadgeItem = ["TypeScript", "blue", "typescript"];
    const url1 = getBadgeUrl(itemWithLogo);
    expect(url1).toContain("https://img.shields.io/badge/TypeScript-");
    expect(url1).toContain(`color=${PAL.blue}`);
    expect(url1).toContain("logo=typescript");

    const itemNoLogo: BadgeItem = ["Nix / NixOS", "teal", null];
    const url2 = getBadgeUrl(itemNoLogo);
    expect(url2).toContain("Nix_%2F_NixOS");
    expect(url2).not.toContain("logo=");
  });

  it("getCacheFileName 基于 SHA256 生成安全唯一文件名", () => {
    const url1 = "https://img.shields.io/badge/TypeScript-8aadf4?label=&logo=typescript";
    const name1 = getCacheFileName(url1);
    expect(name1.startsWith("TypeScript")).toBeTrue();
    expect(name1.endsWith(".svg")).toBeTrue();

    const url2 = "https://img.shields.io/badge/TypeScript-8aadf4?label=&logo=different";
    const name2 = getCacheFileName(url2);
    expect(name1).not.toBe(name2);
  });
});

describe("BadgeStore - 配置归一化与加载", () => {
  it("normalizeBadgeItem 验证并标准化对象与数组结构", () => {
    const fromArray = normalizeBadgeItem(["Bun", "pink", "bun"], 0, "Test");
    expect(fromArray).toEqual(["Bun", "pink", "bun"]);

    const fromObj = normalizeBadgeItem({ name: "Go", color: "sky", logo: "go" }, 1, "Test");
    expect(fromObj).toEqual(["Go", "sky", "go"]);

    expect(() => normalizeBadgeItem(["InvalidColor", "not-a-color"], 2, "Test")).toThrow("invalid color");
  });

  it("normalizeBadgeGroup 校验分组并生成有效 slug", () => {
    const raw = {
      title: "Observability & Tracing",
      items: [["OpenTelemetry", "blue", "opentelemetry"]],
    };
    const group = normalizeBadgeGroup(raw, 0);
    expect(group.title).toBe("Observability & Tracing");
    expect(group.slug).toBe("observability-tracing");
    expect(group.items.length).toBe(1);
  });

  it("loadBadgeConfig 加载真实配置文件并严格断言 8 个分组契约", () => {
    const groups = loadBadgeConfig(DEFAULT_CONFIG_PATH);
    expect(groups.length).toBe(8);

    const expectedSlugs = [
      "languages",
      "java-backend",
      "cloud-gitops",
      "iac-secrets",
      "network-security",
      "observability",
      "automation-vision",
      "macos-agent",
    ];
    expect(groups.map((g) => g.slug)).toEqual(expectedSlugs);

    const langGroup = groups.find((g) => g.slug === "languages");
    expect(langGroup).toBeDefined();
    expect(langGroup!.items).toContainEqual(["TypeScript", "blue", "typescript"]);
    expect(langGroup!.items).toContainEqual(["Rust", "peach", "rust"]);
  });

  it("当配置文件不存在时抛出明确异常", () => {
    expect(() => loadBadgeConfig(join(ROOT_DIR, "non-existent.yaml"))).toThrow(
      "Badge configuration file not found"
    );
  });
});

describe("BadgeStore - 资产获取与双适配器缓存", () => {
  it("优先从本地磁盘缓存读取，无需网络请求", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "badges-cache-test-"));
    try {
      const item: BadgeItem = ["MockTool", "blue", null];
      const url = getBadgeUrl(item);
      const fileName = getCacheFileName(url);
      const mockSvg = `<svg width="80" height="28" xmlns="http://www.w3.org/2000/svg"><g id="cached"/></svg>`;

      // 预先写入本地缓存
      writeFileSync(join(tmp, fileName), mockSvg, "utf-8");

      const map = await fetchBadges([item], {
        cacheDir: tmp,
        useCache: true,
      });

      expect(map.get(url)).toBe(mockSvg);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("对冷缓存或未缓存的重复徽章项去重处理，避免重复入队与重复请求", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "badges-dedup-test-"));
    let fetchCount = 0;
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response('<svg width="80" height="28" xmlns="http://www.w3.org/2000/svg"><g/></svg>', {
          status: 200,
        });
      };

      const item: BadgeItem = ["DuplicateLang", "blue", "dup"];
      const map = await fetchBadges([item, item, item], {
        cacheDir: tmp,
        useCache: false,
      });

      expect(fetchCount).toBe(1);
      expect(map.size).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("当远程抓取遇到 HTTP 异常时，Worker 严格抛出 BadgeFetchError 并携带具体 URL", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "badges-err-test-"));
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return new Response("Not Found", { status: 404 });
      };

      const item: BadgeItem = ["FailItem", "red", null];
      const url = getBadgeUrl(item);

      await expect(
        fetchBadges([item], {
          cacheDir: tmp,
          useCache: false,
          retries: 1,
        })
      ).rejects.toThrow(BadgeFetchError);

      try {
        await fetchBadges([item], { cacheDir: tmp, useCache: false, retries: 1 });
      } catch (err) {
        expect(err instanceof BadgeFetchError).toBeTrue();
        if (err instanceof BadgeFetchError) {
          expect(err.url).toBe(url);
          expect(err.message).toContain(url);
        }
      }
    } finally {
      globalThis.fetch = origFetch;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BadgeLayout - 纯同步几何排版与 Fail-fast", () => {
  it("排版单行徽章并确保统一视图尺寸", () => {
    const item1: BadgeItem = ["ToolA", "blue", null];
    const url1 = getBadgeUrl(item1);
    const badgeMap = new Map<string, string>();
    badgeMap.set(url1, `<svg width="100" height="28" xmlns="http://www.w3.org/2000/svg"><g/></svg>`);

    // 纯同步调用，不使用 await
    const svg = composeBadges([item1], badgeMap);
    expect(svg).toContain(`viewBox="0 0 ${MAX_ROW_WIDTH} 28.00"`);
    expect(svg).toContain(`width="${MAX_ROW_WIDTH}"`);
    expect(svg).toContain(`height="28.00"`);
  });

  it("当单行累计宽度超过 MAX_ROW_WIDTH 时自动纯同步折行并累加高度", () => {
    // 构造 10 个宽度为 120 的徽章：10 * 120 + 9 * 6 = 1254 > 860，必定折行为 2 行
    const items: BadgeItem[] = [];
    const badgeMap = new Map<string, string>();

    for (let i = 0; i < 10; i++) {
      const item: BadgeItem = [`Tool_${i}`, "teal", null];
      items.push(item);
      badgeMap.set(
        getBadgeUrl(item),
        `<svg width="120" height="28" xmlns="http://www.w3.org/2000/svg"><g id="tool-${i}"/></svg>`
      );
    }

    const svg = composeBadges(items, badgeMap);
    // 2 行高度：28 + 6 + 28 = 62
    expect(svg).toContain(`viewBox="0 0 ${MAX_ROW_WIDTH} 62.00"`);
    expect(svg).toContain(`height="62.00"`);
    expect(svg).toContain('y="0.00"');
    expect(svg).toContain(`y="${(28 + GAP).toFixed(2)}"`);
  });

  it("Fail-fast 契约：当任一徽章未在 badgeMap 中时立即抛出 BadgeMissingError", () => {
    const itemReady: BadgeItem = ["ReadyTool", "pink", null];
    const itemMissing: BadgeItem = ["MissingTool", "red", null];

    const badgeMap = new Map<string, string>();
    badgeMap.set(
      getBadgeUrl(itemReady),
      `<svg width="100" height="28" xmlns="http://www.w3.org/2000/svg"><g/></svg>`
    );

    expect(() => composeBadges([itemReady, itemMissing], badgeMap)).toThrow(BadgeMissingError);
    expect(() => composeBadges([itemReady, itemMissing], badgeMap)).toThrow("徽章资产未预取或缺失");
  });

  it("build-badges 导出的 composeBadges 兼容老调用方式（允许缺省 badgeMap 并自动预取）", async () => {
    const item: BadgeItem = ["LegacyTool", "mauve", null];
    const url = getBadgeUrl(item);
    const mockSvg = `<svg width="90" height="28" xmlns="http://www.w3.org/2000/svg"><g/></svg>`;
    const badgeMap = new Map<string, string>([[url, mockSvg]]);

    const svg = await legacyComposeBadges([item], badgeMap);
    expect(svg).toContain(`viewBox="0 0 ${MAX_ROW_WIDTH} 28.00"`);
    expect(svg).toContain(`width="${MAX_ROW_WIDTH}"`);
  });
});
