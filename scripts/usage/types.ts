/**
 * 用量管线类型与配置契约
 */

export const CLIENTS = ["omp", "pi", "claude", "codex", "opencode"] as const;
export type Client = (typeof CLIENTS)[number];
export const HISTORICAL_CLIENTS: Client[] = ["pi", "codex", "opencode", "claude"];

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
  // 单客户端卡片（如 omp.svg）
  clientCard: {
    width: 846,
    height: 230,
    topModels: 5,
  },
  // 2×2 历史归档卡片（history.svg）
  historyCard: {
    title: "History",
    user: "@shelken",
    width: 846,
    height: 425,
    topModels: 5,
    clients: ["pi", "codex", "opencode", "claude"] as Client[],
    coordinates: [
      { client: "pi" as Client, x: 30, y: 76 },
      { client: "codex" as Client, x: 441, y: 76 },
      { client: "opencode" as Client, x: 30, y: 252 },
      { client: "claude" as Client, x: 441, y: 252 },
    ],
    dividerX: 423,
    dividerY: 240,
    headerLineY: 64,
    quadrantWidth: 375,
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
