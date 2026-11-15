/**
 * 用量管线类型与配置契约
 */

export const CLIENTS = ["omp", "pi", "claude", "codex", "opencode"] as const;
export type Client = (typeof CLIENTS)[number];
// 主力客户端各自独占一张单客户端卡片（<client>.svg）
export const PRIMARY_CLIENTS: Client[] = ["omp", "pi"];
export const HISTORICAL_CLIENTS: Client[] = ["codex", "opencode", "claude"];

/**
 * Catppuccin Macchiato 主题配色与客户端强调色
 */
export const ACCENT: Record<Client, string> = {
  omp: "#c6a0f6", // mauve
  pi: "#f5bde6", // pink
  claude: "#f5a97f", // peach
  codex: "#8aadf4", // blue
  opencode: "#8bd5ca", // teal
};

export const TITLE: Record<Client, string> = {
  omp: "OMP",
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const PALETTE = {
  bg: "#181926",
  stroke: "#363a4f",
  user: "#b8c0e0",
  text: "#cad3f5",
  sub: "#a5adcb",
  foot: "#6e738d",
  barBg: "#24273a",
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,sans-serif",
} as const;

export const USAGE_CONFIG = {
  // 模型排行窗口（月）：以各客户端最近有记录的日期为终点向前回溯；窗口内模型不足 N 个时退回全周期
  topModelsWindowMonths: 3,
  // 单客户端卡片（omp.svg / pi.svg）
  clientCard: {
    width: 846,
    height: 230,
    topModels: 5,
  },
  // 1×3 历史归档卡片（history.svg）：每个历史客户端一列
  historyCard: {
    title: "History",
    user: "@shelken",
    width: 846,
    height: 420,
    topModels: 5,
    clients: HISTORICAL_CLIENTS,
    columnXs: [30, 308, 586],
    columnWidth: 230,
    dividerXs: [284, 562],
    columnY: 76,
    headerLineY: 64,
  },
  // 全周期热力图卡片（harness.svg）
  harnessCard: {
    width: 846,
    height: 215,
  },
} as const;

export interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}

export interface DailyRecord {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCost: number;
  modelBreakdowns: ModelBreakdown[];
  modelsUsed?: string[];
}

export interface StreakStats {
  currentStreak: number;
  maxStreak: number;
}

export interface AggregateUsage {
  dailyTokens: Record<string, number>;
  clientDailyTokens: Record<string, Partial<Record<Client, number>>>;
  allDates: string[];
  startDate: Date;
  latestDate: Date;
  startDateStr: string;
  latestDateStr: string;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  maxStreak: number;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
