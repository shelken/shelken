#!/usr/bin/env bun
/**
 * 用本地 Vibe (Token) 数据生成 GitHub 贪吃蛇动态 SVG。
 * 原理：将 usage/data/*.json 的日用量转为 GitHub 贡献日历格式，
 * 拦截 generate-snake-animation 内部请求，生成吃 Token 的动态贪吃蛇 SVG，
 * 并注入 Catppuccin Macchiato 主题卡片、标题与活跃统计指标。
 *
 * 用法: bun scripts/vibe_snake.mjs [--output usage/vibe-snake.svg]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSnakeAnimation } from "generate-snake-animation";

const ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "usage", "data");
const OUT_FILE = process.argv[2] || join(ROOT, "usage", "vibe-snake.svg");

// 1. 读取并汇总 usage/data/*.json
const dailyTokens = {};
const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));

for (const file of files) {
  const content = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
  for (const day of content.daily || []) {
    if (!day.date) continue;
    let tok = day.totalTokens;
    if (tok === undefined) {
      tok = (day.modelBreakdowns || []).reduce(
        (acc, m) =>
          acc +
          (m.inputTokens || 0) +
          (m.outputTokens || 0) +
          (m.cacheReadTokens || 0) +
          (m.cacheCreationTokens || 0),
        0
      );
    }
    dailyTokens[day.date] = (dailyTokens[day.date] || 0) + tok;
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

// 连击统计
let maxStreak = 0;
let curStreak = 0;
let tempStreak = 0;
const firstRecord = new Date(`${allDates[0]}T00:00:00Z`);

for (let d = new Date(firstRecord); d <= latestDate; d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if ((dailyTokens[iso] || 0) > 0) {
    tempStreak++;
    if (tempStreak > maxStreak) maxStreak = tempStreak;
  } else {
    tempStreak = 0;
  }
}
const avgTokens = activeDays > 0 ? totalTokens / activeDays : 1;
function fmtTokens(n) {
  const m = Math.abs(n) / 1_000_000;
  if (m > 1000) {
    const b = m / 1000;
    return b >= 10 ? `${b.toFixed(1)}B` : `${b.toFixed(2)}B`;
  }
  return m >= 10 ? `${m.toFixed(1)}M` : `${m.toFixed(2)}M`;
}


const weeks = [];
let curWeek = { contributionDays: [] };
let cur = new Date(startDate);

while (cur <= latestDate) {
  const iso = cur.toISOString().slice(0, 10);
  const weekday = cur.getUTCDay();
  const count = dailyTokens[iso] || 0;

  let level = "NONE";
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
globalThis.fetch = async (url, opts) => {
  if (typeof url === "string" && url.includes("graphql")) {
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
  return origFetch(url, opts);
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
  outputs
);

if (results[0]) {
  let rawSvg = results[0];

  // 注入卡片外框、标题与活跃指标
  const newSvgOpen =
    '<svg viewBox="-16 -80 880 248" width="880" height="248" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vibe Activity">';
  rawSvg = rawSvg.replace(/<svg[^>]+>/, newSvgOpen);

  const header = `
  <rect width="879" height="247" x="-15.5" y="-79.5" rx="6" fill="#181926" stroke="#363a4f" stroke-width="1"/>
  <text x="16" y="-48" fill="#c6a0f6" font-size="16" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">Vibe Activity</text>
  <text x="846" y="-49" fill="#b8c0e0" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">@shelken</text>
  <text x="846" y="-34" fill="#6e738d" font-size="11" font-weight="400" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">${startDateStr} · ${latestDateStr}</text>
  <text x="16" y="-28" font-size="12" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <tspan fill="#cad3f5" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="#6e738d"> tokens · </tspan>
    <tspan fill="#cad3f5" font-weight="700">${activeDays}</tspan><tspan fill="#6e738d"> active days · </tspan>
    <tspan fill="#c6a0f6" font-weight="700">${curStreak}d</tspan><tspan fill="#6e738d"> streak (max ${maxStreak}d)</tspan>
  </text>
`;

  const styleEndIdx = rawSvg.indexOf("</style>");
  if (styleEndIdx !== -1) {
    rawSvg =
      rawSvg.slice(0, styleEndIdx + "</style>".length) +
      header +
      rawSvg.slice(styleEndIdx + "</style>".length);
  }

  writeFileSync(OUT_FILE, rawSvg);
  console.log(`✓ 已生成: ${OUT_FILE}`);
}
