import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeBadges,
  DEFAULT_CONFIG_PATH,
  getBadgeUrl,
  getCacheFileName,
  loadBadgeConfig,
  MAX_ROW_WIDTH,
  normalizeBadgeGroup,
  normalizeBadgeItem,
  parseSvg,
  preloadBadges,
  ROOT,
  slugify,
  type BadgeItem,
} from "./build-badges";

describe("build-badges parseSvg", () => {
  it("extracts width, height, and inner content from SVG", () => {
    const raw = `<svg width="105.5" height="28" viewBox="0 0 105.5 28" xmlns="http://www.w3.org/2000/svg"><g id="badge"><rect width="105.5" height="28"/></g></svg>`;
    const [w, h, inner] = parseSvg(raw);
    expect(w).toBe(105.5);
    expect(h).toBe(28);
    expect(inner).toBe('<g id="badge"><rect width="105.5" height="28"/></g>');
  });

  it("throws on missing width/height", () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>`;
    expect(() => parseSvg(raw)).toThrow("missing width/height");
  });

  it("throws on invalid svg format", () => {
    expect(() => parseSvg("not an svg")).toThrow("invalid svg");
  });
});

describe("build-badges slugify", () => {
  it("converts titles to kebab-case slugs", () => {
    expect(slugify("Languages")).toBe("languages");
    expect(slugify("Java / backend")).toBe("java-backend");
    expect(slugify("Cloud native / GitOps")).toBe("cloud-native-gitops");
    expect(slugify("macOS & AI Agents")).toBe("macos-ai-agents");
  });
});

describe("build-badges getBadgeUrl & getCacheFileName", () => {
  it("generates correct shields.io URL with logo", () => {
    const item: BadgeItem = ["Java", "peach", "openjdk"];
    const url = getBadgeUrl(item);
    expect(url).toContain("https://img.shields.io/badge/Java-f5a97f");
    expect(url).toContain("logo=openjdk");
    expect(url).toContain("style=for-the-badge");
  });

  it("generates correct shields.io URL without logo", () => {
    const item: BadgeItem = ["XXL-Job", "mauve", null];
    const url = getBadgeUrl(item);
    expect(url).toContain("https://img.shields.io/badge/XXL-Job-c6a0f6");
    expect(url).not.toContain("&logo=");
  });

  it("replaces spaces with underscores in URL path", () => {
    const item: BadgeItem = ["Spring Boot", "green", "springboot"];
    const url = getBadgeUrl(item);
    expect(url).toContain("/badge/Spring_Boot-a6da95");
  });

  it("generates stable cache file names with hash suffix", () => {
    const url = "https://img.shields.io/badge/Rust-f5a97f?label=&style=for-the-badge&color=f5a97f";
    const name1 = getCacheFileName(url);
    const name2 = getCacheFileName(url);
    expect(name1).toBe(name2);
    expect(name1.endsWith(".svg")).toBe(true);
    expect(name1.startsWith("Rust-f5a97f")).toBe(true);
  });
});

describe("build-badges normalizeBadgeItem", () => {
  it("supports object format with name, color, and logo", () => {
    const item = normalizeBadgeItem({ name: "TypeScript", color: "blue", logo: "typescript" }, 0, "Languages");
    expect(item).toEqual(["TypeScript", "blue", "typescript"]);
  });

  it("supports object format without logo", () => {
    const item = normalizeBadgeItem({ name: "XXL-Job", color: "mauve" }, 0, "Java / backend");
    expect(item).toEqual(["XXL-Job", "mauve", null]);
  });

  it("supports label alias in object format", () => {
    const item = normalizeBadgeItem({ label: "Spring Boot", color: "green", logo: "springboot" }, 0, "Backend");
    expect(item).toEqual(["Spring Boot", "green", "springboot"]);
  });

  it("supports array shorthand format", () => {
    const item = normalizeBadgeItem(["Rust", "peach", "rust"], 0, "Languages");
    expect(item).toEqual(["Rust", "peach", "rust"]);
  });

  it("supports array shorthand format without logo", () => {
    const item = normalizeBadgeItem(["Nacos", "blue"], 0, "Java / backend");
    expect(item).toEqual(["Nacos", "blue", null]);
  });

  it("throws on invalid color with helpful message", () => {
    expect(() =>
      normalizeBadgeItem({ name: "Rust", color: "neon-pink" }, 0, "Languages")
    ).toThrow('invalid color "neon-pink". Allowed colors:');
  });

  it("throws on missing item name", () => {
    expect(() =>
      normalizeBadgeItem({ color: "blue" }, 0, "Languages")
    ).toThrow('missing or invalid "name" string');
  });
});

describe("build-badges normalizeBadgeGroup", () => {
  it("normalizes a valid group and respects explicit slug", () => {
    const group = normalizeBadgeGroup(
      {
        title: "Languages",
        slug: "my-languages",
        items: [{ name: "Rust", color: "peach" }],
      },
      0
    );
    expect(group.slug).toBe("my-languages");
    expect(group.title).toBe("Languages");
    expect(group.items).toEqual([["Rust", "peach", null]]);
  });

  it("auto-generates slug if omitted", () => {
    const group = normalizeBadgeGroup(
      {
        title: "Network / security",
        items: [{ name: "Tailscale", color: "sky", logo: "tailscale" }],
      },
      0
    );
    expect(group.slug).toBe("network-security");
    expect(group.title).toBe("Network / security");
    expect(group.items).toEqual([["Tailscale", "sky", "tailscale"]]);
  });

  it("throws if title is missing", () => {
    expect(() => normalizeBadgeGroup({ items: [] }, 0)).toThrow('missing a valid "title" string');
  });

  it("throws if items is missing", () => {
    expect(() => normalizeBadgeGroup({ title: "Test" }, 0)).toThrow('missing an "items" array');
  });
});

describe("build-badges loadBadgeConfig", () => {
  it("loads config/tech-stack.yaml successfully with all 8 groups", () => {
    const groups = loadBadgeConfig(DEFAULT_CONFIG_PATH);
    expect(groups.length).toBe(8);

    const slugs = groups.map((g) => g.slug);
    expect(slugs).toEqual([
      "languages",
      "java-backend",
      "cloud-gitops",
      "iac-secrets",
      "network-security",
      "observability",
      "automation-vision",
      "macos-agent",
    ]);

    const languages = groups.find((g) => g.slug === "languages");
    expect(languages?.items.length).toBe(8);
    expect(languages?.items[0]).toEqual(["Java", "peach", "openjdk"]);
  });

  it("throws if config file does not exist", () => {
    expect(() => loadBadgeConfig(join(ROOT, "non-existent.yaml"))).toThrow(
      "Badge configuration file not found"
    );
  });
});

describe("build-badges preloadBadges caching", () => {
  it("reads directly from disk cache without network requests", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "badges-test-"));
    try {
      const item: BadgeItem = ["MockTest", "blue", null];
      const url = getBadgeUrl(item);
      const fileName = getCacheFileName(url);
      const mockSvg = `<svg width="80" height="28" xmlns="http://www.w3.org/2000/svg"><g id="mock"/></svg>`;

      // 写入假缓存
      writeFileSync(join(tmp, fileName), mockSvg, "utf-8");

      const map = await preloadBadges([item], {
        cacheDir: tmp,
        useCache: true,
      });

      expect(map.get(url)).toBe(mockSvg);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("build-badges composeBadges uniform dimensions", () => {
  it("generates consistent base width and viewBox regardless of item count", async () => {
    const item1: BadgeItem = ["Single", "blue", null];
    const url1 = getBadgeUrl(item1);
    const badgeMap = new Map<string, string>();
    badgeMap.set(url1, `<svg width="100" height="28" xmlns="http://www.w3.org/2000/svg"><g/></svg>`);

    const svg = await composeBadges([item1], badgeMap);
    expect(svg).toContain(`viewBox="0 0 ${MAX_ROW_WIDTH} 28.00"`);
    expect(svg).toContain(`width="${MAX_ROW_WIDTH}"`);
    expect(svg).toContain(`height="28.00"`);
  });
});
