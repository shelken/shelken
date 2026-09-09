#!/usr/bin/env bun
/**
 * 用本地 Vibe (Token) 数据生成 GitHub 贪吃蛇动态 SVG。
 *
 * 原理：
 * 1. 汇总 usage/data/*.json 的每日 Token 用量；
 * 2. 对齐 53 周日历，计算连续活跃天数 (Streak)；
 * 3. 构造符合 GitHub GraphQL API 格式的数据结构；
 * 4. 拦截 globalThis.fetch，直接将构造好的数据喂给 generate-snake-animation 库；
 * 5. 注入 Catppuccin Macchiato 主题卡片（外框、标题、指标摘要），输出最终 SVG。
 *
 * 用法：
 *   bun scripts/vibe-snake.ts [output_file]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSnakeAnimation } from "generate-snake-animation";
import { calculateStreaks, fmtTokens } from "./harness-usage";

const ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "usage", "data");
const OUT_FILE = process.argv[2] || join(ROOT, "usage", "vibe-snake.svg");

interface ContributionDay {
  contributionCount: number;
  contributionLevel: "NONE" | "FIRST_QUARTILE" | "SECOND_QUARTILE" | "THIRD_QUARTILE" | "FOURTH_QUARTILE";
  date: string;
  weekday: number;
}

interface Week {
  contributionDays: ContributionDay[];
}

// 1. 读取并汇总 usage/data/*.json
const dailyTokens: Record<string, number> = {};
const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));

for (const file of files) {
  try {
    const raw = readFileSync(join(DATA_DIR, file), "utf-8");
    const json = JSON.parse(raw) as { daily?: unknown[] };
    for (const d of json.daily || []) {
      if (!d || typeof d !== "object") continue;
      const rec = d as Record<string, unknown>;
      const dt = typeof rec.date === "string" ? rec.date : null;
      if (!dt) continue;

      let tok = typeof rec.totalTokens === "number" ? rec.totalTokens : 0;
      if (tok === 0 && Array.isArray(rec.modelBreakdowns)) {
        for (const m of rec.modelBreakdowns) {
          if (m && typeof m === "object") {
            const mr = m as Record<string, unknown>;
            tok +=
              Number(mr.inputTokens || 0) +
              Number(mr.outputTokens || 0) +
              Number(mr.cacheReadTokens || 0) +
              Number(mr.cacheCreationTokens || 0);
          }
        }
      }
      dailyTokens[dt] = (dailyTokens[dt] || 0) + tok;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] 读取 ${file} 失败: ${msg}`);
  }
}

// 2. 计算统计指标与 53 周日历对齐
const allDates = Object.keys(dailyTokens).sort();
const latestDateStr = allDates[allDates.length - 1] || new Date().toISOString().slice(0, 10);
const latestDate = new Date(`${latestDateStr}T00:00:00Z`);

const wOffset = (latestDate.getUTCDay() + 0) % 7;
const startDate = new Date(latestDate);
startDate.setUTCDate(latestDate.getUTCDate() - (52 * 7 + wOffset));
const startDateStr = startDate.toISOString().slice(0, 10);

const totalTokens = Object.values(dailyTokens).reduce((a, b) => a + b, 0);
const activeDays = Object.values(dailyTokens).filter((v) => v > 0).length;
const { currentStreak, maxStreak } = calculateStreaks(dailyTokens);
const avgTokens = activeDays > 0 ? totalTokens / activeDays : 1;

const weeks: Week[] = [];
let curWeek: Week = { contributionDays: [] };
const cur = new Date(startDate);

while (cur <= latestDate) {
  const iso = cur.toISOString().slice(0, 10);
  const weekday = cur.getUTCDay();
  const count = dailyTokens[iso] || 0;

  let level: ContributionDay["contributionLevel"] = "NONE";
  let levelNum = 0;
  if (count > 0) {
    const ratio = count / avgTokens;
    if (ratio >= 1.8) {
      level = "FOURTH_QUARTILE";
      levelNum = 4;
    } else if (ratio >= 1.0) {
      level = "THIRD_QUARTILE";
      levelNum = 3;
    } else if (ratio >= 0.4) {
      level = "SECOND_QUARTILE";
      levelNum = 2;
    } else {
      level = "FIRST_QUARTILE";
      levelNum = 1;
    }
  }

  curWeek.contributionDays.push({
    contributionCount: levelNum, // 仅存范围阶梯，不存具体每日用量
    contributionLevel: level,
    date: iso,
    weekday,
  });

  if (weekday === 6 || cur.getTime() === latestDate.getTime()) {
    weeks.push(curWeek);
    curWeek = { contributionDays: [] };
  }

  cur.setUTCDate(cur.getUTCDate() + 1);
}

// 3. 拦截 fetch 注入本地数据
const origFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, opts?: unknown) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("api.github.com/graphql")) {
    return new Response(
      JSON.stringify({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                weeks,
              },
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return origFetch(url, opts as RequestInit);
};

// 4. Catppuccin Macchiato 配色参数
const outputs = [
  {
    format: "svg",
    drawOptions: {
      colorSnake: "#c6a0f6", // Mauve
      colorBackground: "#181926", // Base
      colorDotBorder: "#363a4f", // Surface1
      colorEmpty: "#24273a", // Surface0
      colorDots: {
        0: "#24273a",
        1: "#3e3859",
        2: "#67528c",
        3: "#9d7cd8",
        4: "#c6a0f6",
      },
      sizeCell: 16,
      sizeDot: 12,
      sizeDotBorderRadius: 2,
    },
    animationOptions: {
      frameByStep: 1,
      stepDurationMs: 100,
    },
  },
];

const results = await generateSnakeAnimation(
  { platform: "github", username: "shelken", githubToken: "fake" },
  outputs as unknown as Parameters<typeof generateSnakeAnimation>[1]
);

if (results[0]) {
  const rawSvg = results[0];

  // 调整尺寸与坐标系统：增加 80px 顶部空间存放标题与用量指标
  const origOpen = rawSvg.match(/<svg view[bB]ox="[^"]+" width="(\d+)" height="(\d+)"[^>]*>/);
  if (origOpen) {
    const newSvgOpen =
      `<svg viewBox="-16 -80 880 248" width="880" height="248" ` +
      `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vibe Activity">`;

    const header =
      `<rect width="879" height="247" x="-15.5" y="-79.5" rx="6" fill="#181926" stroke="#363a4f" stroke-width="1"/>\n` +
      `  <text x="16" y="-48" fill="#c6a0f6" font-size="16" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">Vibe Activity</text>\n` +
      `  <text x="846" y="-49" fill="#b8c0e0" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">@shelken</text>\n` +
      `  <text x="846" y="-34" fill="#6e738d" font-size="11" font-weight="400" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">${startDateStr} · ${latestDateStr}</text>\n` +
      `  <text x="16" y="-28" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">\n` +
      `    <tspan fill="#cad3f5" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="#6e738d"> tokens · </tspan>\n` +
      `    <tspan fill="#cad3f5" font-weight="700">${activeDays}</tspan><tspan fill="#6e738d"> active days · </tspan>\n` +
      `    <tspan fill="#c6a0f6" font-weight="700">${currentStreak}d</tspan><tspan fill="#6e738d"> streak (max ${maxStreak}d)</tspan>\n` +
      `  </text>\n`;

    const svgWithHeader = rawSvg
      .replace(origOpen[0], newSvgOpen)
      .replace("</style>", `</style>\n${header}`);

    writeFileSync(OUT_FILE, svgWithHeader, "utf-8");
    console.log(`✓ ${OUT_FILE}`);
  }
}
