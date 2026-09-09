import { describe, expect, it } from "bun:test";
import {
  type Client,
  type DailyRecord,
  type ModelBreakdown,
  type AggregateUsage,
  USAGE_CONFIG,
  ACCENT,
  PALETTE,
} from "./usage/types";
import {
  normalizeDay,
  mergeDailyRecords,
  calculateStreaks,
  aggregateUsage,
  fmtTokens,
  rankModels,
} from "./usage/store";
import {
  buildClientSvg,
  buildHistorySvg,
  buildHarnessSvg,
} from "./usage/cards";

describe("UsageStore - 跨节点与多数据源标准化及深度合并", () => {
  it("标准化多客户端格式差异（字典 models vs 数组 modelBreakdowns）", () => {
    // 模拟来自不同版本客户端的数据结构
    const rawArray = {
      date: "2026-09-01",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
      totalCost: 0.15,
      modelBreakdowns: [
        {
          modelName: "[omp] gpt-5.6-sol",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 2000,
          cacheCreationTokens: 100,
          cost: 0.15,
        },
      ],
    };

    const rawDict = {
      date: "2026-09-01",
      cost: 0.25,
      models: {
        "claude-3-7-sonnet": {
          inputTokens: 2000,
          outputTokens: 800,
          cacheReadTokens: 5000,
          cacheCreationTokens: 0,
          cost: 0.25,
        },
      },
    };

    const norm1 = normalizeDay(rawArray);
    expect(norm1.date).toBe("2026-09-01");
    expect(norm1.totalTokens).toBe(3600);
    expect(norm1.modelBreakdowns[0].modelName).toBe("[omp] gpt-5.6-sol");

    const norm2 = normalizeDay(rawDict);
    expect(norm2.date).toBe("2026-09-01");
    expect(norm2.totalTokens).toBe(7800);
    expect(norm2.modelBreakdowns[0].modelName).toBe("claude-3-7-sonnet");
    expect(norm2.totalCost).toBe(0.25);
  });

  it("跨节点（mio 与 sakamoto）同日数据深度合并、去重与降序排序", () => {
    // 模拟 mio 节点
    const mioRecord: DailyRecord = {
      date: "2026-09-01",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 1_000,
      totalTokens: 63_000,
      totalCost: 1.5,
      modelBreakdowns: [
        {
          modelName: "deepseek-v4-flash",
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 50_000,
          cacheCreationTokens: 1_000,
          cost: 1.5,
        },
      ],
    };

    // 模拟 sakamoto 节点（包含共同模型与独立模型）
    const sakamotoRecord: DailyRecord = {
      date: "2026-09-01",
      inputTokens: 20_000,
      outputTokens: 5_000,
      cacheReadTokens: 80_000,
      cacheCreationTokens: 0,
      totalTokens: 105_000,
      totalCost: 3.0,
      modelBreakdowns: [
        {
          modelName: "deepseek-v4-flash",
          inputTokens: 15_000,
          outputTokens: 4_000,
          cacheReadTokens: 70_000,
          cacheCreationTokens: 0,
          cost: 2.2,
        },
        {
          modelName: "gpt-5.6-sol",
          inputTokens: 5_000,
          outputTokens: 1_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 0,
          cost: 0.8,
        },
      ],
    };

    const merged = mergeDailyRecords([mioRecord, sakamotoRecord]);
    expect(merged.length).toBe(1);

    const day = merged[0];
    expect(day.date).toBe("2026-09-01");
    expect(day.totalTokens).toBe(168_000);
    expect(day.totalCost).toBe(4.5);
    expect(day.modelBreakdowns.length).toBe(2);

    // 验证深度合并后按 Token 降序排列：deepseek-v4-flash (63000 + 89000 = 152000) > gpt-5.6-sol (16000)
    expect(day.modelBreakdowns[0].modelName).toBe("deepseek-v4-flash");
    expect(day.modelBreakdowns[0].cacheReadTokens).toBe(120_000);
    expect(day.modelBreakdowns[0].cost).toBe(3.7);

    expect(day.modelBreakdowns[1].modelName).toBe("gpt-5.6-sol");
    expect(day.modelBreakdowns[1].inputTokens).toBe(5_000);
  });
});

describe("UsageStore - 时序连续打卡与全量聚合", () => {
  it("精准计算跨年与断签场景下的连续打卡与历史最长打卡", () => {
    const dailyTokens: Record<string, number> = {
      // 第一段连续打卡 (3天)
      "2025-12-30": 1000,
      "2025-12-31": 2000,
      "2026-01-01": 1500,
      // 断签一天
      "2026-01-02": 0,
      // 第二段连续打卡，跨闰年 2 月 (4天: 27, 28, 29, 01)
      "2028-02-27": 500,
      "2028-02-28": 500,
      "2028-02-29": 500,
      "2028-03-01": 500,
      // 尾部当天正在进行中
      "2028-03-02": 200,
    };

    const streaks = calculateStreaks(dailyTokens);
    expect(streaks.maxStreak).toBe(5); // 2028-02-27 至 2028-03-02 共 5 天连续
    expect(streaks.currentStreak).toBe(5);
  });

  it("当最新一天未产生 Token 且距离最后活跃日超过 1 天时 currentStreak 归零", () => {
    const dailyTokens: Record<string, number> = {
      "2026-09-01": 500,
      "2026-09-02": 500,
      "2026-09-05": 0, // 最近日期，已断更 3 天
    };

    const streaks = calculateStreaks(dailyTokens);
    expect(streaks.maxStreak).toBe(2);
    expect(streaks.currentStreak).toBe(0);
  });

  it("aggregateUsage 生成不可变聚合契约对象", () => {
    const mockDataset: Record<Client, DailyRecord[]> = {
      omp: [
        {
          date: "2026-09-01",
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 40_000,
          cacheCreationTokens: 0,
          totalTokens: 51_000,
          totalCost: 0.5,
          modelBreakdowns: [{ modelName: "omp-model", inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 40000, cacheCreationTokens: 0, cost: 0.5 }],
        },
        {
          date: "2026-09-02",
          inputTokens: 20_000,
          outputTokens: 2_000,
          cacheReadTokens: 80_000,
          cacheCreationTokens: 0,
          totalTokens: 102_000,
          totalCost: 1.0,
          modelBreakdowns: [{ modelName: "omp-model", inputTokens: 20000, outputTokens: 2000, cacheReadTokens: 80000, cacheCreationTokens: 0, cost: 1.0 }],
        },
      ],
      pi: [
        {
          date: "2026-09-01",
          inputTokens: 5_000,
          outputTokens: 500,
          cacheReadTokens: 15_000,
          cacheCreationTokens: 0,
          totalTokens: 20_500,
          totalCost: 0.2,
          modelBreakdowns: [{ modelName: "pi-model", inputTokens: 5000, outputTokens: 500, cacheReadTokens: 15000, cacheCreationTokens: 0, cost: 0.2 }],
        },
      ],
      claude: [],
      codex: [],
      opencode: [],
    };

    const agg = aggregateUsage(mockDataset);
    expect(agg).not.toBeNull();
    if (!agg) return;

    expect(agg.totalTokens).toBe(173_500);
    expect(agg.activeDays).toBe(2);
    expect(agg.dailyTokens["2026-09-01"]).toBe(71_500);
    expect(agg.dailyTokens["2026-09-02"]).toBe(102_000);
    expect(agg.clientDailyTokens["2026-09-01"].omp).toBe(51_000);
    expect(agg.clientDailyTokens["2026-09-01"].pi).toBe(20_500);
    expect(agg.currentStreak).toBe(2);
    expect(agg.maxStreak).toBe(2);
    expect(agg.startDateStr <= "2026-09-01").toBeTrue();
    expect(agg.latestDateStr).toBe("2026-09-02");
  });
});

describe("Card Visualizers - SVG 渲染适配器", () => {
  it("buildClientSvg 渲染符合 Catppuccin 规范的单客户端卡片", () => {
    const days: DailyRecord[] = [
      {
        date: "2026-09-01",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 8500,
        cacheCreationTokens: 0,
        totalTokens: 10_000,
        totalCost: 0.1,
        modelBreakdowns: [
          { modelName: "[omp] gpt-5.6-sol", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8500, cacheCreationTokens: 0, cost: 0.1 },
        ],
      },
    ];

    const svg = buildClientSvg(days, "omp");
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
    expect(svg.trim().endsWith("</svg>")).toBeTrue();
    expect(svg).toContain(`fill="${PALETTE.bg}"`);
    expect(svg).toContain(`fill="${ACCENT.omp}"`);
    expect(svg).toContain("OMP");
    expect(svg).toContain("@shelken");
    expect(svg).toContain("gpt-5.6-sol");
    expect(svg).toContain("TOKEN COMPOSITION");
    expect(svg).toContain("TOP 5 MODELS");
  });

  it("buildHistorySvg 正确渲染 4 象限历史生态归档", () => {
    const historyData: Record<Client, DailyRecord[]> = {
      omp: [],
      pi: [
        {
          date: "2026-08-01",
          totalTokens: 10_000_000,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 8_500_000,
          cacheCreationTokens: 0,
          totalCost: 1.0,
          modelBreakdowns: [{ modelName: "gpt-5.6-sol", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8500, cacheCreationTokens: 0, cost: 0.1 }],
        },
      ],
      codex: [
        {
          date: "2026-05-01",
          totalTokens: 5_000_000,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 3_500_000,
          cacheCreationTokens: 0,
          totalCost: 0.5,
          modelBreakdowns: [{ modelName: "gpt-5.2-codex", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 3500, cacheCreationTokens: 0, cost: 0.1 }],
        },
      ],
      opencode: [
        {
          date: "2026-03-01",
          totalTokens: 2_000_000,
          inputTokens: 500_000,
          outputTokens: 200_000,
          cacheReadTokens: 1_300_000,
          cacheCreationTokens: 0,
          totalCost: 0.2,
          modelBreakdowns: [{ modelName: "deepseek-v3.2", inputTokens: 500, outputTokens: 200, cacheReadTokens: 1300, cacheCreationTokens: 0, cost: 0.05 }],
        },
      ],
      claude: [
        {
          date: "2026-02-01",
          totalTokens: 500_000,
          inputTokens: 100_000,
          outputTokens: 50_000,
          cacheReadTokens: 350_000,
          cacheCreationTokens: 0,
          totalCost: 0.05,
          modelBreakdowns: [{ modelName: "claude-3-5-sonnet", inputTokens: 100, outputTokens: 50, cacheReadTokens: 350, cacheCreationTokens: 0, cost: 0.02 }],
        },
      ],
    };

    const svg = buildHistorySvg(historyData);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
    expect(svg.trim().endsWith("</svg>")).toBeTrue();
    expect(svg).toContain(`viewBox="0 0 ${USAGE_CONFIG.historyCard.width} ${USAGE_CONFIG.historyCard.height}"`);
    expect(svg).toContain("Pi");
    expect(svg).toContain("Codex");
    expect(svg).toContain("OpenCode");
    expect(svg).toContain("Claude Code");
    expect(svg).toContain("gpt-5.6-sol");
    expect(svg).toContain("gpt-5.2-codex");
    expect(svg).toContain("deepseek-v3.2");
    expect(svg).toContain("claude-3-5-sonnet");
  });

  it("buildHarnessSvg 渲染全周期活跃热力图与图例", () => {
    const mockDataset: Record<Client, DailyRecord[]> = {
      omp: [
        {
          date: "2026-09-01",
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 20000,
          cacheCreationTokens: 0,
          totalTokens: 26000,
          totalCost: 0.2,
          modelBreakdowns: [],
        },
      ],
      pi: [],
      claude: [],
      codex: [],
      opencode: [],
    };

    const agg = aggregateUsage(mockDataset);
    const svg = buildHarnessSvg(mockDataset, agg);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
    expect(svg.trim().endsWith("</svg>")).toBeTrue();
    expect(svg).toContain("Harness");
    expect(svg).toContain("Mon");
    expect(svg).toContain("Wed");
    expect(svg).toContain("Fri");
    expect(svg).toContain("Intensity:");
    expect(svg).toContain("2026-09-01");
  });
});
