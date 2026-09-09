#!/usr/bin/env bun
/**
 * 用本地 Vibe (Token) 数据生成 GitHub 贪吃蛇动态 SVG。
 *
 * 输入：
 *   复用 harness-usage 的多客户端日用量聚合数据
 * 输出：
 *   usage/vibe-snake.svg
 *
 * 用法：
 *   bun scripts/vibe-snake.ts [output_file]
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSnakeAnimation } from "generate-snake-animation";
import {
  type AggregateUsage,
  type Client,
  type DailyRecord,
  fmtTokens,
  getAggregateUsage,
  loadAllClientDays,
} from "./harness-usage";

const ROOT = resolve(import.meta.dir, "..");
const OUT_FILE = join(ROOT, "usage", "vibe-snake.svg");

interface ContributionDay {
  contributionCount: number;
  contributionLevel: "NONE" | "FIRST_QUARTILE" | "SECOND_QUARTILE" | "THIRD_QUARTILE" | "FOURTH_QUARTILE";
  date: string;
  weekday: number;
}

interface Week {
  contributionDays: ContributionDay[];
}

export async function renderVibeSnake(options?: {
  outFile?: string;
  agg?: AggregateUsage | null;
  clientDays?: Record<Client, DailyRecord[]>;
}): Promise<string | null> {
  const outFile = options?.outFile || OUT_FILE;
  const agg = options?.agg !== undefined ? options.agg : getAggregateUsage(options?.clientDays || loadAllClientDays());
  if (!agg) return null;

  const {
    dailyTokens,
    totalTokens,
    activeDays,
    currentStreak,
    maxStreak,
    startDate,
    latestDate,
    startDateStr,
    latestDateStr,
  } = agg;

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
      contributionCount: levelNum,
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

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, opts?: unknown) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
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
  try {
    const outputs = [
      {
        format: "svg",
        drawOptions: {
          colorSnake: "#c6a0f6",
          colorBackground: "#181926",
          colorDotBorder: "#363a4f",
          colorEmpty: "#24273a",
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
      const origOpen = rawSvg.match(/<svg view[bB]ox="[^"]+" width="(\d+)" height="(\d+)"[^>]*>/);
      if (origOpen) {
        const newSvgOpen =
          '<svg viewBox="-16 -80 880 248" width="880" height="248" ' +
          'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vibe Activity">';

        const header =
          '<rect width="879" height="247" x="-15.5" y="-79.5" rx="6" fill="#181926" stroke="#363a4f" stroke-width="1"/>\n' +
          '  <text x="16" y="-48" fill="#c6a0f6" font-size="16" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Vibe Activity</text>\n' +
          '  <text x="846" y="-49" fill="#b8c0e0" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif" text-anchor="end">@shelken</text>\n' +
          `  <text x="846" y="-34" fill="#6e738d" font-size="11" font-weight="400" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">${startDateStr} · ${latestDateStr}</text>\n` +
          '  <text x="16" y="-28" font-size="12" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">\n' +
          `    <tspan fill="#cad3f5" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="#6e738d"> tokens · </tspan>\n` +
          `    <tspan fill="#cad3f5" font-weight="700">${activeDays}</tspan><tspan fill="#6e738d"> active days · </tspan>\n` +
          `    <tspan fill="#c6a0f6" font-weight="700">${currentStreak}d</tspan><tspan fill="#6e738d"> streak (max ${maxStreak}d)</tspan>\n` +
          "  </text>\n";

        const svgWithHeader = rawSvg
          .replace(origOpen[0], newSvgOpen)
          .replace("</style>", `</style>\n${header}`);

        writeFileSync(outFile, svgWithHeader, "utf-8");
        const rel = outFile.startsWith(ROOT) ? outFile.slice(ROOT.length + 1) : outFile;
        console.log(`✓ ${rel}`);
        return outFile;
      }
    }
    return null;
  } finally {
    globalThis.fetch = origFetch;
  }
}

if (import.meta.main) {
  const target = process.argv[2] || OUT_FILE;
  await renderVibeSnake({ outFile: target });
}
