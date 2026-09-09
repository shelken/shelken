import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENTS,
  type Client,
  type DailyRecord,
  type ModelBreakdown,
  type StreakStats,
  type AggregateUsage,
  UsageError,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, "../..");
export const DEFAULT_DATA_DIR = join(ROOT_DIR, "usage", "data");

/**
 * 清除模型名称前缀，如 [pi]、[omp]
 */
export function cleanModelName(name: string): string {
  return name.replace(/^\[(?:pi|omp)\]\s*/i, "").trim();
}

/**
 * 计算单个模型的总 Token 数
 */
export function modelTokens(m: ModelBreakdown): number {
  return (
    (m.inputTokens || 0) +
    (m.outputTokens || 0) +
    (m.cacheReadTokens || 0) +
    (m.cacheCreationTokens || 0)
  );
}

/**
 * 获取日记录的有效 Token 数
 */
export function dayTokens(d: DailyRecord): number {
  if (typeof d.totalTokens === "number" && d.totalTokens > 0) {
    return d.totalTokens;
  }
  return (d.modelBreakdowns || []).reduce((acc, m) => acc + modelTokens(m), 0);
}

/**
 * 计算多日记录的 Token 总数
 */
export function sumTokens(days: DailyRecord[]): number {
  return days.reduce((acc, d) => acc + dayTokens(d), 0);
}

/**
 * 过滤出最近 N 天的记录（基于最后一条记录日期向前推 n - 1 天）
 */
export function filterLastNDays(days: DailyRecord[], n: number): DailyRecord[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Date(sorted[sorted.length - 1].date);
  const cutoff = new Date(latest);
  cutoff.setUTCDate(cutoff.getUTCDate() - (n - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return sorted.filter((d) => d.date >= cutoffStr);
}

/**
 * 模型 Token 贡献排行榜，按清洗后的模型名称归并汇总
 */
export function rankModels(days: DailyRecord[], top = 5): [string, number][] {
  const totals: Record<string, number> = {};
  const displayNames: Record<string, string> = {};

  for (const d of days) {
    for (const m of d.modelBreakdowns || []) {
      const raw = cleanModelName(m.modelName || "unknown");
      const lower = raw.toLowerCase();
      const tok = modelTokens(m);
      totals[lower] = (totals[lower] || 0) + tok;
      if (!displayNames[lower]) {
        displayNames[lower] = raw;
      }
    }
  }

  return Object.entries(totals)
    .map(([k, v]) => [displayNames[k] || k, v] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
}

function formatNumberString(s: string): string {
  if (s.includes(".")) {
    const [whole, frac] = s.split(".");
    return `${Number(whole).toLocaleString("en-US")}.${frac}`;
  }
  return Number(s).toLocaleString("en-US");
}

/**
 * 格式化 Token 数量：自动切换 M (百万) / B (十亿) 档位
 */
export function fmtTokens(n: number): string {
  const abs = Math.abs(Number(n) || 0);
  const m = abs / 1_000_000;

  if (m >= 1000) {
    const b = m / 1000;
    const body = b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2);
    return `${formatNumberString(body)}B`;
  }

  let body: string;
  if (m >= 100) body = m.toFixed(0);
  else if (m >= 1) body = m.toFixed(1);
  else body = m.toFixed(2);

  return `${formatNumberString(body)}M`;
}

/**
 * 计算当前连续打卡与历史最长连续打卡天数
 */
export function calculateStreaks(dailyTokens: Record<string, number>): StreakStats {
  const dates = Object.keys(dailyTokens).sort();
  if (dates.length === 0) return { currentStreak: 0, maxStreak: 0 };

  let maxStreak = 0;
  let tempStreak = 0;
  let prevDate: Date | null = null;

  for (const dStr of dates) {
    const count = dailyTokens[dStr];
    if (count > 0) {
      const curDate = new Date(`${dStr}T00:00:00Z`);
      if (prevDate) {
        const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / 86400000);
        tempStreak = diffDays === 1 ? tempStreak + 1 : 1;
      } else {
        tempStreak = 1;
      }
      prevDate = curDate;
      if (tempStreak > maxStreak) maxStreak = tempStreak;
    }
  }

  const latestActiveStr = [...dates].reverse().find((d) => dailyTokens[d] > 0);
  let currentStreak = 0;

  if (latestActiveStr) {
    const latestDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    const activeDate = new Date(`${latestActiveStr}T00:00:00Z`);
    const daysSinceActive = Math.round((latestDate.getTime() - activeDate.getTime()) / 86400000);

    if (daysSinceActive <= 1) {
      let checkDate = new Date(activeDate);
      while (true) {
        const iso = checkDate.toISOString().slice(0, 10);
        if ((dailyTokens[iso] || 0) > 0) {
          currentStreak++;
          checkDate.setUTCDate(checkDate.getUTCDate() - 1);
        } else {
          break;
        }
      }
    }
  }

  return { currentStreak, maxStreak };
}

/**
 * 归一化解析单日原始 JSON 数据，兼容不同客户端字段结构
 */
export function normalizeDay(raw: Record<string, unknown>): DailyRecord {
  const dateVal = raw.date;
  if (!dateVal || typeof dateVal !== "string") {
    throw new UsageError(`Record missing 'date': ${JSON.stringify(raw)}`);
  }

  const inputTokens = Number(raw.inputTokens) || 0;
  const outputTokens = Number(raw.outputTokens) || 0;
  const cacheReadTokens = Number(raw.cacheReadTokens) || 0;
  const cacheCreationTokens = Number(raw.cacheCreationTokens) || 0;
  const totalCost = Number(raw.totalCost ?? raw.cost) || 0;

  const modelBreakdowns: ModelBreakdown[] = [];

  if (Array.isArray(raw.modelBreakdowns)) {
    for (const m of raw.modelBreakdowns) {
      if (m && typeof m === "object") {
        const mObj = m as Record<string, unknown>;
        modelBreakdowns.push({
          modelName: String(mObj.modelName || ""),
          inputTokens: Number(mObj.inputTokens) || 0,
          outputTokens: Number(mObj.outputTokens) || 0,
          cacheReadTokens: Number(mObj.cacheReadTokens) || 0,
          cacheCreationTokens: Number(mObj.cacheCreationTokens) || 0,
          cost: Number(mObj.cost) || 0,
        });
      }
    }
  } else if (raw.models && typeof raw.models === "object") {
    if (Array.isArray(raw.models)) {
      for (const name of raw.models) {
        modelBreakdowns.push({
          modelName: String(name),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0,
        });
      }
    } else {
      for (const [name, stats] of Object.entries(raw.models as Record<string, Record<string, unknown>>)) {
        modelBreakdowns.push({
          modelName: name,
          inputTokens: Number(stats?.inputTokens) || 0,
          outputTokens: Number(stats?.outputTokens) || 0,
          cacheReadTokens: Number(stats?.cacheReadTokens) || 0,
          cacheCreationTokens: Number(stats?.cacheCreationTokens) || 0,
          cost: Number(stats?.cost) || 0,
        });
      }
    }
  }

  let totalTokens = Number(raw.totalTokens) || 0;
  if (totalTokens === 0) {
    const sumBreakdowns = modelBreakdowns.reduce((acc, m) => acc + modelTokens(m), 0);
    const sumDay = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    totalTokens = Math.max(sumBreakdowns, sumDay);
  }

  const modelsUsed = Array.isArray(raw.modelsUsed)
    ? raw.modelsUsed.map(String)
    : modelBreakdowns.map((m) => m.modelName).filter(Boolean);

  return {
    date: dateVal,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    totalCost,
    modelBreakdowns,
    modelsUsed,
  };
}

/**
 * 深度合并多节点同日用量记录（跨机器导出合并）
 */
export function mergeDailyRecords(days: DailyRecord[]): DailyRecord[] {
  interface AggTarget {
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    totalCost: number;
    models: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        cost: number;
      }
    >;
  }

  const byDate: Record<string, AggTarget> = {};

  for (const d of days) {
    const dt = d.date;
    if (!byDate[dt]) {
      byDate[dt] = {
        date: dt,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: {},
      };
    }

    const t = byDate[dt];
    t.inputTokens += d.inputTokens;
    t.outputTokens += d.outputTokens;
    t.cacheReadTokens += d.cacheReadTokens;
    t.cacheCreationTokens += d.cacheCreationTokens;
    t.totalTokens += dayTokens(d);
    t.totalCost += d.totalCost;

    for (const m of d.modelBreakdowns || []) {
      const mName = m.modelName || "";
      if (!t.models[mName]) {
        t.models[mName] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0,
        };
      }
      const mTarget = t.models[mName];
      mTarget.inputTokens += m.inputTokens || 0;
      mTarget.outputTokens += m.outputTokens || 0;
      mTarget.cacheReadTokens += m.cacheReadTokens || 0;
      mTarget.cacheCreationTokens += m.cacheCreationTokens || 0;
      mTarget.cost += m.cost || 0;
    }
  }

  const merged: DailyRecord[] = [];
  for (const dt of Object.keys(byDate).sort()) {
    const item = byDate[dt];
    const breakdowns: ModelBreakdown[] = [];

    for (const [mName, mStats] of Object.entries(item.models)) {
      breakdowns.push({
        modelName: mName,
        inputTokens: mStats.inputTokens,
        outputTokens: mStats.outputTokens,
        cacheReadTokens: mStats.cacheReadTokens,
        cacheCreationTokens: mStats.cacheCreationTokens,
        cost: mStats.cost,
      });
    }

    breakdowns.sort((a, b) => modelTokens(b) - modelTokens(a));

    merged.push({
      date: dt,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      modelBreakdowns: breakdowns,
      modelsUsed: breakdowns.map((b) => b.modelName),
    });
  }

  return merged;
}

/**
 * 从磁盘读取指定客户端的日用量数据（支持单机或按机名分片）
 */
export function loadClientDays(client: Client, dataDir: string = DEFAULT_DATA_DIR): DailyRecord[] {
  if (!existsSync(dataDir)) {
    throw new UsageError(`数据目录不存在: ${dataDir}`);
  }

  const files: string[] = [];

  if (client === "omp" || client === "pi") {
    const matched = readdirSync(dataDir)
      .filter((f) => f.startsWith(`${client}-`) && f.endsWith(".json"))
      .sort();
    files.push(...matched.map((f) => join(dataDir, f)));
    const fallback = join(dataDir, `${client}.json`);
    if (existsSync(fallback) && !files.includes(fallback)) {
      files.push(fallback);
    }
    if (files.length === 0) {
      throw new UsageError(`没有 ${dataDir}/${client}-*.json, 先 export --client ${client}`);
    }
  } else {
    const f = join(dataDir, `${client}.json`);
    if (!existsSync(f)) {
      throw new UsageError(`没有 ${dataDir}/${client}.json, 先 export --client ${client}`);
    }
    files.push(f);
  }

  const days: DailyRecord[] = [];
  for (const f of files) {
    try {
      const content = readFileSync(f, "utf-8");
      const data = JSON.parse(content);
      const rawDaily = Array.isArray(data.daily) ? data.daily : [];
      for (const raw of rawDaily) {
        days.push(normalizeDay(raw));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`解析 ${f} 失败: ${msg}`);
    }
  }

  return mergeDailyRecords(days);
}

/**
 * 加载全量客户端数据集
 */
export function loadUsageDataset(dataDir: string = DEFAULT_DATA_DIR): Record<Client, DailyRecord[]> {
  const result = {} as Record<Client, DailyRecord[]>;
  for (const c of CLIENTS) {
    try {
      result[c] = loadClientDays(c, dataDir);
    } catch {
      result[c] = [];
    }
  }
  return result;
}

// 别名兼容
export const loadAllClientDays = loadUsageDataset;

/**
 * 聚合全客户端不可变指标（深模块核心接口）
 */
export function aggregateUsage(clientDays: Record<Client, DailyRecord[]>): AggregateUsage | null {
  const dailyTokens: Record<string, number> = {};
  const clientDailyTokens: Record<string, Partial<Record<Client, number>>> = {};

  for (const c of CLIENTS) {
    for (const d of clientDays[c] || []) {
      if (!d.date) continue;
      const tok = dayTokens(d);
      dailyTokens[d.date] = (dailyTokens[d.date] || 0) + tok;
      if (!clientDailyTokens[d.date]) {
        clientDailyTokens[d.date] = {};
      }
      clientDailyTokens[d.date][c] = (clientDailyTokens[d.date][c] || 0) + tok;
    }
  }

  const allDates = Object.keys(dailyTokens).sort();
  if (allDates.length === 0) return null;

  const latestDate = new Date(`${allDates[allDates.length - 1]}T00:00:00Z`);
  const wOffset = latestDate.getUTCDay();
  const startDate = new Date(latestDate);
  startDate.setUTCDate(latestDate.getUTCDate() - (52 * 7 + wOffset));

  const totalTokens = Object.values(dailyTokens).reduce((a, b) => a + b, 0);
  const activeDays = Object.values(dailyTokens).filter((v) => v > 0).length;
  const { currentStreak, maxStreak } = calculateStreaks(dailyTokens);

  return {
    dailyTokens,
    clientDailyTokens,
    allDates,
    startDate,
    latestDate,
    startDateStr: startDate.toISOString().slice(0, 10),
    latestDateStr: latestDate.toISOString().slice(0, 10),
    totalTokens,
    activeDays,
    currentStreak,
    maxStreak,
  };
}

// 别名兼容
export const getAggregateUsage = aggregateUsage;
