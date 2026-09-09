#!/usr/bin/env bun
/**
 * 多 Harness 用量：ccusage 导出 JSON，渲染 usage/*.svg，挂到 README。
 *
 * 用法:
 *   bun scripts/harness-usage.ts export [--client omp|pi|claude|codex|opencode|all] [--name mio]
 *   bun scripts/harness-usage.ts render
 *   bun scripts/harness-usage.ts sync [--client all] [--name mio] [--commit] [--push]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVibeSnake } from "./vibe-snake";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const USAGE_DIR = join(ROOT, "usage");
export const DATA_DIR = join(USAGE_DIR, "data");
export const README_PATH = join(ROOT, "README.md");

export const START_MARKER = "<!-- HARNESS-USAGE:START -->";
export const END_MARKER = "<!-- HARNESS-USAGE:END -->";

export const CLIENTS = ["omp", "pi", "claude", "codex", "opencode"] as const;
export type Client = (typeof CLIENTS)[number];

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

export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(USAGE_DIR, { recursive: true });
}

export function cleanModelName(name: string): string {
  return name.replace(/^\[(?:pi|omp)\]\s*/i, "").trim();
}

export function modelTokens(m: ModelBreakdown): number {
  return (
    (m.inputTokens || 0) +
    (m.outputTokens || 0) +
    (m.cacheReadTokens || 0) +
    (m.cacheCreationTokens || 0)
  );
}

export function dayTokens(d: DailyRecord): number {
  if (typeof d.totalTokens === "number" && d.totalTokens > 0) {
    return d.totalTokens;
  }
  return (d.modelBreakdowns || []).reduce((acc, m) => acc + modelTokens(m), 0);
}

export function sumTokens(days: DailyRecord[]): number {
  return days.reduce((acc, d) => acc + dayTokens(d), 0);
}

export function filterLastNDays(days: DailyRecord[], n: number): DailyRecord[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Date(sorted[sorted.length - 1].date);
  const cutoff = new Date(latest);
  cutoff.setUTCDate(cutoff.getUTCDate() - (n - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return sorted.filter((d) => d.date >= cutoffStr);
}

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

function formatNumberString(s: string): string {
  if (s.includes(".")) {
    const [whole, frac] = s.split(".");
    return `${Number(whole).toLocaleString("en-US")}.${frac}`;
  }
  return Number(s).toLocaleString("en-US");
}

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

export function normalizeDay(raw: Record<string, unknown>): DailyRecord {
  const dateVal = raw.date;
  if (!dateVal || typeof dateVal !== "string") {
    throw new UsageError(`Record missing 'date': ${JSON.stringify(raw)}`);
  }

  const inputTokens = Number(raw.inputTokens) || 0;
  const outputTokens = Number(raw.outputTokens) || 0;
  const cacheReadTokens = Number(raw.cacheReadTokens) || 0;
  const cacheCreationTokens = Number(raw.cacheCreationTokens) || 0;
  const totalCost = Number(raw.totalCost || raw.cost) || 0;

  let modelBreakdowns: ModelBreakdown[] = [];

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

export function loadClientDays(client: Client): DailyRecord[] {
  ensureDirs();
  const files: string[] = [];

  if (client === "omp" || client === "pi") {
    const matched = readdirSync(DATA_DIR)
      .filter((f) => f.startsWith(`${client}-`) && f.endsWith(".json"))
      .sort();
    files.push(...matched.map((f) => join(DATA_DIR, f)));
    const fallback = join(DATA_DIR, `${client}.json`);
    if (existsSync(fallback) && !files.includes(fallback)) {
      files.push(fallback);
    }
    if (files.length === 0) {
      throw new UsageError(`没有 usage/data/${client}-*.json,先 export --client ${client}`);
    }
  } else {
    const f = join(DATA_DIR, `${client}.json`);
    if (!existsSync(f)) {
      throw new UsageError(`没有 usage/data/${client}.json,先 export --client ${client}`);
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

export function loadAllClientDays(): Record<Client, DailyRecord[]> {
  const result = {} as Record<Client, DailyRecord[]>;
  for (const c of CLIENTS) {
    try {
      result[c] = loadClientDays(c);
    } catch {
      result[c] = [];
    }
  }
  return result;
}

export function getAggregateUsage(clientDays: Record<Client, DailyRecord[]>): AggregateUsage | null {
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

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function svgText(
  x: number,
  y: number,
  body: string,
  opts: { fill: string; size: number; weight?: string; anchor?: string; spacing?: string; font?: string }
): string {
  let attrs = `x="${x}" y="${y}" fill="${opts.fill}" font-size="${opts.size}"`;
  if (opts.weight !== undefined) {
    if (opts.weight) attrs += ` font-weight="${opts.weight}"`;
  } else {
    attrs += ` font-weight="400"`;
  }
  attrs += ` font-family="${opts.font || PALETTE.font}"`;
  if (opts.anchor) attrs += ` text-anchor="${opts.anchor}"`;
  if (opts.spacing) attrs += ` letter-spacing="${opts.spacing}"`;
  return `<text ${attrs}>${escapeXml(body)}</text>`;
}

export function buildClientSvg(days: DailyRecord[], client: Client): string {
  const title = TITLE[client];
  const A = ACCENT[client];
  const d7 = filterLastNDays(days, 7);
  const d40 = filterLastNDays(days, 40);
  const total = sumTokens(days);
  const t7 = sumTokens(d7);
  const t40 = sumTokens(d40);

  const topModels = rankModels(days, 4);

  const dates = days.map((d) => d.date).sort();
  const fr = dates[0] || "—";
  const to = dates[dates.length - 1] || "—";
  const dateStr = fr === to ? fr : `${fr} · ${to}`;

  const nDays = days.length || 1;
  const activeDays = days.filter((d) => dayTokens(d) > 0).length;
  const avgDay = Math.floor(total / nDays);
  const peakDay = Math.max(...days.map((d) => dayTokens(d)), 0);

  const inp = days.reduce((a, d) => a + d.inputTokens, 0);
  const out = days.reduce((a, d) => a + d.outputTokens, 0);
  const cr = days.reduce((a, d) => a + d.cacheReadTokens, 0);
  const cw = days.reduce((a, d) => a + d.cacheCreationTokens, 0);
  const denom = inp + cr;
  const cachePct = denom > 0 ? Math.round((100 * cr) / denom) : 0;

  const W = 846;
  const H = 225;

  const parts: string[] = [
    `<rect width="${W - 1}" height="${H - 1}" x="0.5" y="0.5" rx="6" fill="${PALETTE.bg}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    svgText(30, 36, title, { fill: A, size: 17, weight: "700" }),
    svgText(W - 30, 35, "@shelken", { fill: PALETTE.user, size: 13, weight: "600", anchor: "end" }),
    svgText(W - 30, 50, dateStr, { fill: PALETTE.foot, size: 11, anchor: "end" }),
    `<line x1="250" y1="62" x2="250" y2="202" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `<line x1="510" y1="62" x2="510" y2="202" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    // Col 1: ALL-TIME (30 ~ 230)
    svgText(30, 74, "ALL-TIME", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
    svgText(30, 112, fmtTokens(total), { fill: A, size: 38, weight: "800" }),
    svgText(30, 132, `tokens · ${cachePct}% cache-hit`, { fill: PALETTE.sub, size: 12 }),
    `<line x1="30" y1="144" x2="230" y2="144" stroke="${PALETTE.stroke}" stroke-dasharray="3 3"/>`,
    svgText(30, 163, "Active days", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 163, String(activeDays), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 182, "Avg / day", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 182, fmtTokens(avgDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 201, "Peak day", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 201, fmtTokens(peakDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 2: TOKEN MIX & PERIOD (275 ~ 490)
    svgText(275, 74, "TOKEN MIX & PERIOD", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
    svgText(275, 96, "Output", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 96, fmtTokens(out), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 113, "Input", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 113, fmtTokens(inp), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 130, "Cache read", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 130, fmtTokens(cr), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 147, "Cache write", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 147, fmtTokens(cw), { fill: A, size: 12, weight: "700", anchor: "end" }),
    `<line x1="275" y1="157" x2="490" y2="157" stroke="${PALETTE.stroke}" stroke-dasharray="3 3"/>`,
    svgText(275, 179, "Recent 7d", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 179, fmtTokens(t7), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 199, "Recent 40d", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 199, fmtTokens(t40), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 3: TOP MODELS (535 ~ 816)
    svgText(535, 74, "TOP MODELS", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
  ];

  const maxModelTokens = topModels[0]?.[1] || 1;

  if (topModels.length === 0) {
    parts.push(svgText(535, 120, "No model breakdown available", { fill: PALETTE.foot, size: 12 }));
  } else {
    const barX = 718;
    const barW = 42;
    const spacingY = topModels.length === 4 ? 26 : topModels.length === 3 ? 32 : 36;
    let yPos = topModels.length === 4 ? 97 : topModels.length === 3 ? 102 : 108;

    for (const [name, tok] of topModels) {
      const displayName = name.length <= 25 ? name : `${name.slice(0, 24)}…`;
      const ratio = maxModelTokens > 0 ? tok / maxModelTokens : 0;
      const fillW = Math.max(2, Math.floor(barW * ratio));

      parts.push(
        svgText(535, yPos, displayName, { fill: PALETTE.user, size: 12, weight: "500" }),
        `<rect x="${barX}" y="${yPos - 8}" width="${barW}" height="6" rx="3" fill="${PALETTE.barBg}"/>`,
        `<rect x="${barX}" y="${yPos - 8}" width="${fillW}" height="6" rx="3" fill="${A}"/>`,
        svgText(816, yPos, fmtTokens(tok), { fill: A, size: 12, weight: "700", anchor: "end" })
      );
      yPos += spacingY;
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}">\n` +
    parts.join("\n") +
    "\n</svg>\n"
  );
}

export function buildHarnessSvg(
  clientDays?: Record<Client, DailyRecord[]>,
  injectedAgg?: AggregateUsage | null
): string {
  const allDays = clientDays || loadAllClientDays();
  const agg = injectedAgg !== undefined ? injectedAgg : getAggregateUsage(allDays);
  if (!agg) return "";

  const {
    dailyTokens,
    clientDailyTokens,
    startDate,
    latestDate,
    startDateStr,
    latestDateStr,
    totalTokens,
    activeDays,
    currentStreak,
    maxStreak,
  } = agg;

  const monthsLabels: [number, string][] = [];
  const monthsSeen: Record<string, number> = {};
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let wIdx = 0;
  for (let cur = new Date(startDate); cur <= latestDate; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dW = cur.getUTCDay();
    if (cur.getUTCDate() === 1 || cur.getTime() === startDate.getTime()) {
      const mStr = monthNames[cur.getUTCMonth()];
      if (monthsSeen[mStr] === undefined || wIdx - monthsSeen[mStr] >= 3) {
        monthsLabels.push([wIdx, mStr]);
        monthsSeen[mStr] = wIdx;
      }
    }
    if (dW === 6) {
      wIdx++;
    }
  }

  const cardTitle = "Harness";
  const harnessFont = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg width="846" height="215" viewBox="0 0 846 215" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(cardTitle)}">`,
    `  <rect width="845" height="214" x="0.5" y="0.5" rx="6" fill="${PALETTE.bg}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `  ${svgText(30, 33, cardTitle, { fill: "#c6a0f6", size: 16, weight: "700", font: harnessFont })}`,
    `  ${svgText(816, 32, "@shelken", { fill: PALETTE.user, size: 13, weight: "600", anchor: "end", font: harnessFont })}`,
    `  ${svgText(816, 47, `${startDateStr} · ${latestDateStr}`, { fill: PALETTE.foot, size: 11, anchor: "end", font: harnessFont, weight: "400" })}`,
    `  <text x="30" y="52" font-size="12" font-family="${harnessFont}">`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="${PALETTE.foot}"> tokens · </tspan>`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${activeDays}</tspan><tspan fill="${PALETTE.foot}"> active days · </tspan>`,
    `    <tspan fill="#c6a0f6" font-weight="700">${currentStreak}d</tspan><tspan fill="${PALETTE.foot}"> streak (max ${maxStreak}d)</tspan>`,
    "  </text>",
  ];

  for (const [w, m] of monthsLabels) {
    const x = 52 + w * 14;
    lines.push(`  ${svgText(x, 70, m, { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`);
  }

  lines.push(
    `  ${svgText(30, 99, "Mon", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`,
    `  ${svgText(30, 127, "Wed", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`,
    `  ${svgText(30, 155, "Fri", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`
  );

  const avgTokens = activeDays > 0 ? totalTokens / activeDays : 1;
  wIdx = 0;

  for (let cur = new Date(startDate); cur <= latestDate; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dW = cur.getUTCDay();
    const iso = cur.toISOString().slice(0, 10);
    const tok = dailyTokens[iso] || 0;
    const x = 52 + wIdx * 14;
    const y = 78 + dW * 14;

    if (tok <= 0) {
      lines.push(
        `  <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${PALETTE.barBg}"><title>${iso}: Inactive</title></rect>`
      );
    } else {
      const ratio = tok / avgTokens;
      let tierName: string;
      let opacity: number;

      if (ratio < 0.4) {
        tierName = "Light (< 0.5× avg)";
        opacity = 0.35;
      } else if (ratio < 1.0) {
        tierName = "Moderate (~1× avg)";
        opacity = 0.6;
      } else if (ratio < 1.8) {
        tierName = "Elevated (~1.5× avg)";
        opacity = 0.85;
      } else {
        tierName = "Peak (> 2× avg)";
        opacity = 1.0;
      }

      const clientMap = clientDailyTokens[iso] || {};
      const topClient =
        (Object.entries(clientMap).sort((a, b) => b[1] - a[1])[0]?.[0] as Client) || "omp";
      const clientLabel = TITLE[topClient] || topClient;
      const tip = `${iso}: ${tierName} · ${clientLabel}`;
      const baseColor = ACCENT[topClient] || "#c6a0f6";

      lines.push(
        `  <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${baseColor}" fill-opacity="${opacity}"><title>${escapeXml(tip)}</title></rect>`
      );
    }

    if (dW === 6) {
      wIdx++;
    }
  }

  const legends: [Client, string, number][] = [
    ["omp", "OMP", 102],
    ["pi", "Pi", 160],
    ["claude", "Claude", 200],
    ["codex", "Codex", 265],
    ["opencode", "OpenCode", 330],
  ];

  lines.push(`  ${svgText(30, 198, "Harness:", { fill: PALETTE.foot, size: 11, font: harnessFont, weight: "" })}`);
  for (const [c, label, cx] of legends) {
    lines.push(
      `  <circle cx="${cx}" cy="194" r="4.5" fill="${ACCENT[c]}"/>`,
      `  ${svgText(cx + 10, 198, label, { fill: PALETTE.text, size: 11, font: harnessFont, weight: "" })}`
    );
  }

  lines.push(
    `  ${svgText(636, 198, "Intensity:", { fill: PALETTE.foot, size: 11, font: harnessFont, weight: "" })}`,
    `  ${svgText(690, 198, "< 0.5×", { fill: PALETTE.foot, size: 10, font: harnessFont, weight: "" })}`,
    '  <rect x="726" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.35"/>',
    '  <rect x="740" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.60"/>',
    '  <rect x="754" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.85"/>',
    '  <rect x="768" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="1.0"/>',
    `  ${svgText(784, 198, "> 2× avg", { fill: PALETTE.foot, size: 10, font: harnessFont, weight: "" })}`,
    "</svg>\n"
  );

  return lines.join("\n");
}

export function patchReadme(rendered: Client[]): void {
  const lines: string[] = [START_MARKER, ""];

  if (existsSync(join(USAGE_DIR, "vibe-snake.svg"))) {
    const rel = "./usage/vibe-snake.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="Vibe Activity" /></a>`, "");
  }
  if (existsSync(join(USAGE_DIR, "harness.svg"))) {
    const rel = "./usage/harness.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="Harness" /></a>`, "");
  }

  for (const c of CLIENTS) {
    if (!rendered.includes(c)) continue;
    const rel = `./usage/${c}.svg`;
    const label = TITLE[c];
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="${label}" /></a>`, "");
  }

  lines.push(END_MARKER);
  const block = lines.join("\n");

  const text = readFileSync(README_PATH, "utf-8");
  const i = text.indexOf(START_MARKER);
  const j = text.indexOf(END_MARKER);

  if (i === -1 || j === -1) {
    throw new UsageError(`README.md 缺少 ${START_MARKER} / ${END_MARKER}`);
  }

  writeFileSync(README_PATH, text.slice(0, i) + block + text.slice(j + END_MARKER.length), "utf-8");
}

export function ccusageCmd(client: Client): string[] {
  const hasCcusage = Bun.which("ccusage");
  const base = hasCcusage ? ["ccusage"] : ["bunx", "ccusage"];

  if (client === "omp") {
    const home = homedir();
    const candidateDirs = [
      process.env.PI_CODING_AGENT_DIR,
      process.env.OMP_AGENT_DIR,
      join(home, ".omp", "agent"),
    ].filter(Boolean) as string[];

    const agentDir = candidateDirs.find((d) => existsSync(d)) || join(home, ".omp", "agent");
    return [...base, "omp", "daily", "--agent-dir", agentDir, "--json"];
  }

  return [...base, client, "daily", "--json"];
}

export async function runCcusage(client: Client): Promise<Record<string, unknown>> {
  const cmd = ccusageCmd(client);
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (code !== 0) {
    throw new UsageError(`ccusage ${client} 失败（退出码 ${code}）\n${stderr || stdout}`);
  }

  if (!stdout) {
    throw new UsageError(`ccusage ${client} 输出为空`);
  }

  try {
    const data = JSON.parse(stdout);
    if (!data || !Array.isArray(data.daily)) {
      throw new UsageError(`ccusage ${client}: daily[] 缺失`);
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`ccusage ${client} JSON 无效: ${err}`);
  }
}

export function dataPath(client: Client, name?: string): string {
  if (client === "omp" || client === "pi") {
    const device = name || "mio";
    if (!/^[A-Za-z0-9_-]+$/.test(device)) {
      throw new UsageError(`非法 name: ${device}`);
    }
    return join(DATA_DIR, `${client}-${device}.json`);
  }
  return join(DATA_DIR, `${client}.json`);
}

export async function exportClient(client: Client, name = "mio"): Promise<string | null> {
  ensureDirs();
  const data = await runCcusage(client);
  const daily = Array.isArray(data.daily) ? data.daily : [];
  const out = dataPath(client, name);

  if (daily.length === 0) {
    console.warn(`[WARN] ${client}: daily 为空，跳过写入 ${out}`);
    return null;
  }

  writeFileSync(out, JSON.stringify(data, null, 2) + "\n", "utf-8");
  const total = daily.reduce((acc, d) => acc + (Number(d.totalTokens) || 0), 0);
  const relOut = out.startsWith(ROOT) ? out.slice(ROOT.length + 1) : out;
  console.log(`✓ ${relOut}  days=${daily.length}  totalTokens=${total.toLocaleString("en-US")}`);
  return out;
}

export async function exportAll(name = "mio"): Promise<string[]> {
  const paths: string[] = [];
  for (const c of CLIENTS) {
    const p = await exportClient(c, name);
    if (p) paths.push(p);
  }
  return paths;
}

export async function render(): Promise<Client[]> {
  ensureDirs();
  const allClientDays = loadAllClientDays();
  const agg = getAggregateUsage(allClientDays);

  await renderVibeSnake({ agg });

  const harnessSvg = buildHarnessSvg(allClientDays, agg);
  if (harnessSvg) {
    writeFileSync(join(USAGE_DIR, "harness.svg"), harnessSvg, "utf-8");
    console.log("✓ usage/harness.svg");
  }

  const rendered: Client[] = [];
  for (const c of CLIENTS) {
    const days = allClientDays[c] || [];
    if (days.length === 0) {
      console.warn(`⚠ skip ${c}: no days`);
      continue;
    }

    const outPath = join(USAGE_DIR, `${c}.svg`);
    writeFileSync(outPath, buildClientSvg(days, c), "utf-8");
    rendered.push(c);
    console.log(`✓ usage/${c}.svg  days=${days.length}  total=${fmtTokens(sumTokens(days))}`);
  }

  if (rendered.length === 0) {
    throw new UsageError("没有可渲染的客户端数据");
  }

  patchReadme(rendered);
  console.log(`✓ README  cards=${rendered.join(",")}`);
  return rendered;
}

export async function runGit(args: string[], okCodes = [0]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (!okCodes.includes(code)) {
    throw new UsageError(`Git 命令失败（退出码 ${code}）\n命令: git ${args.join(" ")}\n${stderr || stdout}`);
  }
  return stdout;
}

export async function gitPull(): Promise<void> {
  await runGit(["pull", "--rebase", "--autostash"]);
  console.log("✓ pulled");
}

export async function gitCommit(paths: string[], msg: string): Promise<boolean> {
  const diff = await runGit(["diff", "--cached", "--name-only", "--", ...paths], [0, 1]);
  if (!diff) {
    const status = await runGit(["status", "--porcelain", "--", ...paths]);
    if (!status) {
      console.log("-> 无变更需提交");
      return false;
    }
  }

  await runGit(["add", "--", ...paths]);
  await runGit(["commit", "-m", msg, "--", ...paths]);
  console.log("✓ committed");
  return true;
}

export async function gitPush(): Promise<void> {
  await runGit(["push"]);
  console.log("✓ pushed");
}

function parseOption(args: string[], flag: string, defaultValue?: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    if (defaultValue !== undefined) return defaultValue;
    throw new UsageError(`缺少选项 ${flag}`);
  }
  const val = args[idx + 1];
  if (!val || val.startsWith("-")) {
    throw new UsageError(`选项 ${flag} 缺少有效参数值`);
  }
  return val;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`
多 Harness 编码助手用量导出与 SVG 渲染 (TypeScript / Bun)

用法:
  bun scripts/harness-usage.ts export [--client omp|pi|claude|codex|opencode|all] [--name mio]
  bun scripts/harness-usage.ts render
  bun scripts/harness-usage.ts sync [--client all] [--name mio] [--commit] [--push]
`);
    return;
  }

  try {
    if (cmd === "export") {
      const client = parseOption(args, "--client", "all");
      const name = parseOption(args, "--name", "mio");
      if (client !== "all" && !CLIENTS.includes(client as Client)) {
        die(`未知 client: ${client}`);
      }

      if (client === "all") {
        await exportAll(name);
      } else {
        await exportClient(client as Client, name);
      }
    } else if (cmd === "render") {
      await render();
    } else if (cmd === "sync") {
      const isPush = args.includes("--push");
      const isCommit = args.includes("--commit") || isPush;
      const client = parseOption(args, "--client", "all");
      const name = parseOption(args, "--name", "mio");
      if (client !== "all" && !CLIENTS.includes(client as Client)) {
        die(`未知 client: ${client}`);
      }

      if (isPush) {
        await gitPull();
      }
      if (client === "all") {
        await exportAll(name);
      } else {
        await exportClient(client as Client, name);
      }
      await render();

      if (isCommit) {
        await gitCommit([USAGE_DIR, README_PATH], `chore: update usage cards (${client})`);
      }
      if (isPush) {
        await gitPush();
      }
    } else {
      die(`未知命令: ${cmd}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof UsageError ? err.message : err instanceof Error ? err.stack || err.message : String(err);
    die(msg);
  }
}

if (import.meta.main) {
  await main();
}
