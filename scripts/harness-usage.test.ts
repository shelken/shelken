import { describe, expect, it } from "bun:test";
import {
  cleanModelName,
  fmtTokens,
  modelTokens,
  dayTokens,
  sumTokens,
  filterLastNDays,
  rankModels,
  calculateStreaks,
  normalizeDay,
  mergeDailyRecords,
  buildClientSvg,
  buildHistorySvg,
  USAGE_CONFIG,
  type DailyRecord,
  type ModelBreakdown,
} from "./harness-usage";

describe("fmtTokens", () => {
  it("formats < 1M correctly", () => {
    expect(fmtTokens(0)).toBe("0.00M");
    expect(fmtTokens(50_000)).toBe("0.05M");
    expect(fmtTokens(500_000)).toBe("0.50M");
  });

  it("formats 1M to 999M correctly", () => {
    expect(fmtTokens(3_800_000)).toBe("3.8M");
    expect(fmtTokens(66_800_000)).toBe("66.8M");
    expect(fmtTokens(147_000_000)).toBe("147M");
    expect(fmtTokens(789_000_000)).toBe("789M");
  });

  it("formats >= 1000M in Billions", () => {
    expect(fmtTokens(1_000_000_000)).toBe("1.00B");
    expect(fmtTokens(4_040_000_000)).toBe("4.04B");
    expect(fmtTokens(7_360_000_000)).toBe("7.36B");
    expect(fmtTokens(30_429_000_000)).toBe("30.4B");
    expect(fmtTokens(150_000_000_000)).toBe("150B");
  });
});

describe("cleanModelName", () => {
  it("strips [pi] and [omp] prefixes", () => {
    expect(cleanModelName("[pi] gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(cleanModelName("[omp] deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(cleanModelName("claude-3-7-sonnet")).toBe("claude-3-7-sonnet");
  });
});

describe("Token calculations", () => {
  it("calculates modelTokens correctly", () => {
    const m: ModelBreakdown = {
      modelName: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      cost: 0.01,
    };
    expect(modelTokens(m)).toBe(1350);
  });

  it("calculates dayTokens with totalTokens fallback", () => {
    const d1 = { totalTokens: 5000 } as DailyRecord;
    expect(dayTokens(d1)).toBe(5000);

    const d2 = {
      totalTokens: 0,
      modelBreakdowns: [
        { modelName: "a", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
        { modelName: "b", inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
      ],
    } as DailyRecord;
    expect(dayTokens(d2)).toBe(350);
  });

  it("filters last N days", () => {
    const days = [
      { date: "2026-09-01", totalTokens: 100 },
      { date: "2026-09-05", totalTokens: 200 },
      { date: "2026-09-09", totalTokens: 300 },
    ] as DailyRecord[];
    const filtered = filterLastNDays(days, 5);
    expect(filtered.length).toBe(2);
    expect(filtered[0].date).toBe("2026-09-05");
    expect(filtered[1].date).toBe("2026-09-09");
  });

  it("ranks models aggregating by clean name", () => {
    const days = [
      {
        date: "2026-09-01",
        modelBreakdowns: [
          { modelName: "[pi] ModelA", inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "[pi] ModelB", inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
        ],
      },
      {
        date: "2026-09-02",
        modelBreakdowns: [
          { modelName: "ModelA", inputTokens: 600, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
        ],
      },
    ] as DailyRecord[];

    const ranked = rankModels(days, 2);
    expect(ranked[0]).toEqual(["ModelA", 1100]);
    expect(ranked[1]).toEqual(["ModelB", 1000]);
  });
});

describe("calculateStreaks", () => {
  it("computes current and max streaks accurately", () => {
    const dailyTokens = {
      "2026-09-01": 100,
      "2026-09-02": 200,
      "2026-09-03": 0,
      "2026-09-04": 50,
      "2026-09-05": 60,
    };
    const { currentStreak, maxStreak } = calculateStreaks(dailyTokens);
    expect(currentStreak).toBe(2);
    expect(maxStreak).toBe(2);
  });

  it("handles empty or single day correctly", () => {
    expect(calculateStreaks({})).toEqual({ currentStreak: 0, maxStreak: 0 });
    expect(calculateStreaks({ "2026-09-01": 100 })).toEqual({ currentStreak: 1, maxStreak: 1 });
    expect(calculateStreaks({ "2026-09-01": 0 })).toEqual({ currentStreak: 0, maxStreak: 0 });
  });
});

describe("normalizeDay", () => {
  it("normalizes standard records", () => {
    const raw = {
      date: "2026-09-01",
      totalTokens: 100,
      modelBreakdowns: [{ modelName: "A", inputTokens: 100 }],
    };
    const res = normalizeDay(raw);
    expect(res.date).toBe("2026-09-01");
    expect(res.totalTokens).toBe(100);
  });

  it("normalizes codex dictionary models", () => {
    const raw = {
      date: "2026-05-01",
      models: {
        "gpt-4": {
          inputTokens: 200,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0.05,
        },
      },
    };
    const res = normalizeDay(raw);
    expect(res.date).toBe("2026-05-01");
    expect(res.totalTokens).toBe(250);
    expect(res.modelBreakdowns.length).toBe(1);
    expect(res.modelBreakdowns[0].modelName).toBe("gpt-4");
  });

  it("throws on missing date", () => {
    expect(() => normalizeDay({ totalTokens: 100 })).toThrow();
  });
});

describe("mergeDailyRecords", () => {
  it("merges multi-device records on the same day and sorts breakdowns", () => {
    const day1Dev1 = {
      date: "2026-09-01",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      totalCost: 1.0,
      modelBreakdowns: [
        { modelName: "model-x", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1.0 },
      ],
    } as DailyRecord;

    const day1Dev2 = {
      date: "2026-09-01",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 300,
      totalCost: 2.0,
      modelBreakdowns: [
        { modelName: "model-x", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1.0 },
        { modelName: "model-y", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1.0 },
      ],
    } as DailyRecord;

    const merged = mergeDailyRecords([day1Dev1, day1Dev2]);
    expect(merged.length).toBe(1);
    expect(merged[0].totalTokens).toBe(450);
    expect(merged[0].totalCost).toBe(3.0);
    expect(merged[0].modelBreakdowns.length).toBe(2);
    expect(merged[0].modelBreakdowns[0].modelName).toBe("model-x");
    expect(merged[0].modelBreakdowns[1].modelName).toBe("model-y");
  });
});

describe("buildClientSvg", () => {
  it("generates valid SVG with Catppuccin theme and three columns", () => {
    const days: DailyRecord[] = [
      {
        date: "2026-09-01",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 0,
        totalTokens: 3500,
        totalCost: 0.1,
        modelBreakdowns: [
          {
            modelName: "gpt-5.6-sol",
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 2000,
            cacheCreationTokens: 0,
            cost: 0.1,
          },
        ],
      },
    ];

    const svg = buildClientSvg(days, "omp");
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
    expect(svg.trim().endsWith("</svg>")).toBeTrue();
    expect(svg).toContain("OMP");
    expect(svg).toContain("@shelken");
    expect(svg).toContain("ALL-TIME");
    expect(svg).toContain("gpt-5.6-sol");
  });

  it("renders top 5 models and token composition bar", () => {
    const days: DailyRecord[] = [
      {
        date: "2026-09-01",
        inputTokens: 5000,
        outputTokens: 1000,
        cacheReadTokens: 90000,
        cacheCreationTokens: 0,
        totalTokens: 96000,
        totalCost: 0.5,
        modelBreakdowns: [
          { modelName: "model-one", inputTokens: 50000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "model-two", inputTokens: 40000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "model-three", inputTokens: 30000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "model-four", inputTokens: 20000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "model-five", inputTokens: 10000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
          { modelName: "model-six", inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 },
        ],
      },
    ];

    const svg = buildClientSvg(days, "omp");
    expect(svg).toContain("TOP 5 MODELS");
    expect(svg).toContain("TOKEN COMPOSITION");
    expect(svg).toContain("model-one");
    expect(svg).toContain("model-two");
    expect(svg).toContain("model-three");
    expect(svg).toContain("model-four");
    expect(svg).toContain("model-five");
    expect(svg).not.toContain("model-six");
  });
});
describe("buildHistorySvg", () => {
  it("generates 2x2 quadrant SVG with 4 historical clients", () => {
    const mockData = {
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
          modelBreakdowns: [{ modelName: "[pi] gpt-5.6-sol", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8500, cacheCreationTokens: 0, cost: 0.1 }],
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

    const svg = buildHistorySvg(mockData as any);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBeTrue();
    expect(svg.trim().endsWith("</svg>")).toBeTrue();
    expect(svg).toContain(`viewBox="0 0 ${USAGE_CONFIG.historyCard.width} ${USAGE_CONFIG.historyCard.height}"`);
    expect(svg).toContain(USAGE_CONFIG.historyCard.title);
    expect(svg).toContain("@shelken");
    expect(svg).toContain("Active days");
    expect(svg).toContain("Avg / day");
    expect(svg).toContain("Peak day");
    expect(svg).toContain("TOP 5 MODELS");
    expect(svg).toContain("cache-hit");
    expect(svg).not.toContain("243 active days");
    expect(svg).toContain(">4</tspan><tspan fill=\"#6e738d\"> active days</tspan>");
    expect(svg).toContain("Pi");
    expect(svg).toContain("Codex");
    expect(svg).toContain("OpenCode");
    expect(svg).toContain("Claude Code");
    expect(svg).toContain("gpt-5.6-sol");
    expect(svg).toContain("gpt-5.2-codex");
    expect(svg).toContain("deepseek-v3.2");
    expect(svg).toContain("claude-3-5-sonnet");
  });
});
