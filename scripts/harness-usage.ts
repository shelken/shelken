#!/usr/bin/env bun
/**
 * 多 Harness 用量：ccusage 导出 JSON，渲染 usage/*.svg，挂到 README。
 *
 * 用法:
 *   bun scripts/harness_usage.ts export [--client omp|pi|claude|codex|opencode|all] [--name mio]
 *   bun scripts/harness_usage.ts render
 *   bun scripts/harness_usage.ts sync [--client all] [--name mio] [--commit] [--push]
 *   bun scripts/harness_usage.ts migrate
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const USAGE_DIR = join(ROOT, "usage");
export const DATA_DIR = join(USAGE_DIR, "data");
export const README_PATH = join(ROOT, "README.md");

export const START_MARKER = "<!-- HARNESS-USAGE:START -->";
export const END_MARKER = "<!-- HARNESS-USAGE:END -->";
export const LEGACY_STARTS = ["<!-- AGENT-USAGE:START -->", "<!-- PI-USAGE:START -->"];
export const LEGACY_ENDS = ["<!-- AGENT-USAGE:END -->", "<!-- PI-USAGE:END -->"];

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
  for (const d of days) {
    for (const m of d.modelBreakdowns || []) {
      const name = cleanModelName(m.modelName || "unknown");
      totals[name] = (totals[name] || 0) + modelTokens(m);
    }
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
}

export function fmtTokens(n: number): string {
  const abs = Math.abs(Number(n) || 0);
  const m = abs / 1_000_000;

  if (m >= 1000) {
    const b = m / 1000;
    const body = b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2);
    if (body.includes(".")) {
      const [whole, frac] = body.split(".", 2);
      return `${parseInt(whole, 10).toLocaleString("en-US")}.${frac}B`;
    }
    return `${parseInt(body, 10).toLocaleString("en-US")}B`;
  }

  const body = m >= 100 ? m.toFixed(0) : m >= 1 ? m.toFixed(1) : m.toFixed(2);
  if (body.includes(".")) {
    const [whole, frac] = body.split(".", 2);
    return `${parseInt(whole, 10).toLocaleString("en-US")}.${frac}M`;
  }
  return `${parseInt(body, 10).toLocaleString("en-US")}M`;
}

export function calculateStreaks(dailyTokens: Record<string, number>): StreakStats {
  const dates = Object.keys(dailyTokens).sort();
  if (dates.length === 0) return { currentStreak: 0, maxStreak: 0 };

  const firstDate = new Date(`${dates[0]}T00:00:00Z`);
  const latestDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);

  let maxStreak = 0;
  let tempStreak = 0;
  for (let d = new Date(firstDate); d <= latestDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if ((dailyTokens[iso] || 0) > 0) {
      tempStreak++;
      if (tempStreak > maxStreak) maxStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  let currentStreak = 0;
  for (let d = new Date(latestDate); d >= firstDate; d.setUTCDate(d.getUTCDate() - 1)) {
    const iso = d.toISOString().slice(0, 10);
    if ((dailyTokens[iso] || 0) > 0) {
      currentStreak++;
    } else {
      break;
    }
  }

  return { currentStreak, maxStreak };
}

export function normalizeDay(raw: Record<string, unknown>): DailyRecord {
  const dateVal = raw.date;
  if (!dateVal || typeof dateVal !== "string") {
    throw new UsageError(`Record missing 'date': ${JSON.stringify(raw)}`);
  }

  const rawBreakdowns = raw.modelBreakdowns;
  if (Array.isArray(rawBreakdowns) && rawBreakdowns.length > 0) {
    const breakdowns: ModelBreakdown[] = rawBreakdowns.map((item) => {
      const m = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        modelName: typeof m.modelName === "string" ? m.modelName : "unknown",
        inputTokens: Number(m.inputTokens || 0),
        outputTokens: Number(m.outputTokens || 0),
        cacheReadTokens: Number(m.cacheReadTokens || 0),
        cacheCreationTokens: Number(m.cacheCreationTokens || 0),
        cost: Number(m.cost || 0),
      };
    });

    const totalTokens =
      typeof raw.totalTokens === "number"
        ? raw.totalTokens
        : breakdowns.reduce((acc, m) => acc + modelTokens(m), 0);

    const modelsUsed = Array.isArray(raw.modelsUsed)
      ? (raw.modelsUsed as string[])
      : breakdowns.map((b) => b.modelName);

    return {
      date: dateVal,
      inputTokens: Number(raw.inputTokens || 0),
      outputTokens: Number(raw.outputTokens || 0),
      cacheReadTokens: Number(raw.cacheReadTokens || 0),
      cacheCreationTokens: Number(raw.cacheCreationTokens || 0),
      totalTokens,
      totalCost: Number(raw.totalCost || raw.cost || 0),
      modelBreakdowns: breakdowns,
      modelsUsed,
    };
  }

  // Codex format: models = { [modelName]: { inputTokens, ... } }
  const rawModels = raw.models;
  if (rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)) {
    const breakdowns: ModelBreakdown[] = Object.entries(rawModels as Record<string, unknown>).map(
      ([name, val]) => {
        const m = val && typeof val === "object" ? (val as Record<string, unknown>) : {};
        return {
          modelName: name,
          inputTokens: Number(m.inputTokens || 0),
          outputTokens: Number(m.outputTokens || 0),
          cacheReadTokens: Number(m.cacheReadTokens || 0),
          cacheCreationTokens: Number(m.cacheCreationTokens || 0),
          cost: Number(m.cost || m.costUSD || 0),
        };
      }
    );

    const totalTokens =
      typeof raw.totalTokens === "number"
        ? raw.totalTokens
        : breakdowns.reduce((acc, m) => acc + modelTokens(m), 0);

    return {
      date: dateVal,
      inputTokens: Number(raw.inputTokens || 0),
      outputTokens: Number(raw.outputTokens || 0),
      cacheReadTokens: Number(raw.cacheReadTokens || 0),
      cacheCreationTokens: Number(raw.cacheCreationTokens || 0),
      totalTokens,
      totalCost: Number(raw.totalCost || raw.cost || 0),
      modelBreakdowns: breakdowns,
      modelsUsed: breakdowns.map((b) => b.modelName),
    };
  }

  const inp = Number(raw.inputTokens || 0);
  const out = Number(raw.outputTokens || 0);
  const cr = Number(raw.cacheReadTokens || 0);
  const cw = Number(raw.cacheCreationTokens || 0);
  const totalTokens = typeof raw.totalTokens === "number" ? raw.totalTokens : inp + out + cr + cw;

  return {
    date: dateVal,
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cr,
    cacheCreationTokens: cw,
    totalTokens,
    totalCost: Number(raw.totalCost || raw.cost || 0),
    modelBreakdowns: [],
    modelsUsed: [],
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
    models: Record<string, ModelBreakdown>;
  }

  const byDate: Record<string, AggTarget> = {};

  for (const d of days) {
    if (!byDate[d.date]) {
      byDate[d.date] = {
        date: d.date,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: {},
      };
    }
    const target = byDate[d.date];
    target.inputTokens += d.inputTokens;
    target.outputTokens += d.outputTokens;
    target.cacheReadTokens += d.cacheReadTokens;
    target.cacheCreationTokens += d.cacheCreationTokens;
    target.totalTokens += d.totalTokens;
    target.totalCost += d.totalCost;

    for (const m of d.modelBreakdowns) {
      if (!target.models[m.modelName]) {
        target.models[m.modelName] = {
          modelName: m.modelName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: 0,
        };
      }
      const mt = target.models[m.modelName];
      mt.inputTokens += m.inputTokens;
      mt.outputTokens += m.outputTokens;
      mt.cacheReadTokens += m.cacheReadTokens;
      mt.cacheCreationTokens += m.cacheCreationTokens;
      mt.cost += m.cost;
    }
  }

  const sortedDates = Object.keys(byDate).sort();
  return sortedDates.map((dt) => {
    const item = byDate[dt];
    const breakdowns = Object.values(item.models).sort((a, b) => modelTokens(b) - modelTokens(a));
    return {
      date: item.date,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      modelBreakdowns: breakdowns,
      modelsUsed: breakdowns.map((b) => b.modelName),
    };
  });
}

export function loadClientDays(client: Client): DailyRecord[] {
  ensureDirs();
  const files: string[] = [];

  if (client === "omp") {
    const matched = readdirSync(DATA_DIR)
      .filter((f) => f.startsWith("omp-") && f.endsWith(".json"))
      .sort();
    files.push(...matched.map((f) => join(DATA_DIR, f)));
    const fallback = join(DATA_DIR, "omp.json");
    if (existsSync(fallback) && !files.includes(fallback)) {
      files.push(fallback);
    }
    if (files.length === 0) {
      throw new UsageError(`没有 usage/data/omp-*.json，先 export --client omp`);
    }
  } else if (client === "pi") {
    const matched = readdirSync(DATA_DIR)
      .filter((f) => f.startsWith("pi-") && f.endsWith(".json"))
      .sort();
    files.push(...matched.map((f) => join(DATA_DIR, f)));
    const fallback = join(DATA_DIR, "pi.json");
    if (existsSync(fallback) && !files.includes(fallback)) {
      files.push(fallback);
    }
    if (files.length === 0) {
      throw new UsageError(`没有 usage/data/pi-*.json，先 export --client pi`);
    }
  } else {
    const f = join(DATA_DIR, `${client}.json`);
    if (!existsSync(f)) {
      throw new UsageError(`没有 usage/data/${client}.json，先 export --client ${client}`);
    }
    files.push(f);
  }

  const days: DailyRecord[] = [];
  for (const f of files) {
    const content = readFileSync(f, "utf-8");
    const parsed = JSON.parse(content) as { daily?: unknown[] };
    if (!Array.isArray(parsed.daily)) {
      throw new UsageError(`${f}: missing daily[]`);
    }
    for (const item of parsed.daily) {
      if (item && typeof item === "object") {
        days.push(normalizeDay(item as Record<string, unknown>));
      }
    }
  }
  return mergeDailyRecords(days);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildClientSvg(days: DailyRecord[], client: Client): string {
  const title = TITLE[client];
  const A = ACCENT[client];
  const d7 = filterLastNDays(days, 7);
  const d40 = filterLastNDays(days, 40);
  const total = sumTokens(days);
  const t7 = sumTokens(d7);
  const t40 = sumTokens(d40);

  const modelTotals: Record<string, number> = {};
  const displayNames: Record<string, string> = {};

  for (const d of days) {
    for (const m of d.modelBreakdowns || []) {
      const raw = cleanModelName(m.modelName || "?");
      const lower = raw.toLowerCase();
      const tok = modelTokens(m);
      modelTotals[lower] = (modelTotals[lower] || 0) + tok;
      if (!displayNames[lower] || (raw === raw.toLowerCase() && displayNames[lower] !== raw)) {
        displayNames[lower] = raw;
      }
    }
  }

  const sortedModels = Object.entries(modelTotals)
    .map(([k, v]) => [displayNames[k] || k, v] as [string, number])
    .sort((a, b) => b[1] - a[1]);

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

  const BG = "#181926";
  const STROKE = "#363a4f";
  const USER = "#b8c0e0";
  const LBL = "#a5adcb";
  const SUB = "#a5adcb";
  const FOOT = "#6e738d";
  const BAR_BG = "#24273a";
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,sans-serif";

  const W = 846;
  const H = 225;

  const svgText = (
    x: number,
    y: number,
    body: string,
    opts: { fill: string; size: number; weight?: string; anchor?: string; spacing?: string }
  ) => {
    let attrs = `x="${x}" y="${y}" fill="${opts.fill}" font-size="${opts.size}" font-weight="${opts.weight || "400"}" font-family="${FONT}"`;
    if (opts.anchor) attrs += ` text-anchor="${opts.anchor}"`;
    if (opts.spacing) attrs += ` letter-spacing="${opts.spacing}"`;
    return `<text ${attrs}>${escapeXml(body)}</text>`;
  };

  const parts: string[] = [
    `<rect width="${W - 1}" height="${H - 1}" x="0.5" y="0.5" rx="6" fill="${BG}" stroke="${STROKE}" stroke-width="1"/>`,
    svgText(30, 36, title, { fill: A, size: 17, weight: "700" }),
    svgText(W - 30, 35, "@shelken", { fill: USER, size: 13, weight: "600", anchor: "end" }),
    svgText(W - 30, 50, dateStr, { fill: FOOT, size: 11, anchor: "end" }),
    `<line x1="250" y1="62" x2="250" y2="202" stroke="${STROKE}" stroke-width="1"/>`,
    `<line x1="510" y1="62" x2="510" y2="202" stroke="${STROKE}" stroke-width="1"/>`,
    // Col 1: ALL-TIME (30 ~ 230)
    svgText(30, 74, "ALL-TIME", { fill: FOOT, size: 10, weight: "700", spacing: "1.2" }),
    svgText(30, 112, fmtTokens(total), { fill: A, size: 38, weight: "800" }),
    svgText(30, 132, `tokens · ${cachePct}% cache-hit`, { fill: SUB, size: 12 }),
    `<line x1="30" y1="144" x2="230" y2="144" stroke="${STROKE}" stroke-dasharray="3 3"/>`,
    svgText(30, 163, "Active days", { fill: LBL, size: 12 }),
    svgText(230, 163, String(activeDays), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 182, "Avg / day", { fill: LBL, size: 12 }),
    svgText(230, 182, fmtTokens(avgDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 201, "Peak day", { fill: LBL, size: 12 }),
    svgText(230, 201, fmtTokens(peakDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 2: TOKEN MIX & PERIOD (275 ~ 490)
    svgText(275, 74, "TOKEN MIX & PERIOD", { fill: FOOT, size: 10, weight: "700", spacing: "1.2" }),
    svgText(275, 96, "Output", { fill: LBL, size: 12 }),
    svgText(490, 96, fmtTokens(out), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 113, "Input", { fill: LBL, size: 12 }),
    svgText(490, 113, fmtTokens(inp), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 130, "Cache read", { fill: LBL, size: 12 }),
    svgText(490, 130, fmtTokens(cr), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 147, "Cache write", { fill: LBL, size: 12 }),
    svgText(490, 147, fmtTokens(cw), { fill: A, size: 12, weight: "700", anchor: "end" }),
    `<line x1="275" y1="157" x2="490" y2="157" stroke="${STROKE}" stroke-dasharray="3 3"/>`,
    svgText(275, 179, "Recent 7d", { fill: LBL, size: 12 }),
    svgText(490, 179, fmtTokens(t7), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 199, "Recent 40d", { fill: LBL, size: 12 }),
    svgText(490, 199, fmtTokens(t40), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 3: TOP MODELS (535 ~ 816)
    svgText(535, 74, "TOP MODELS", { fill: FOOT, size: 10, weight: "700", spacing: "1.2" }),
  ];

  const topModels = sortedModels.slice(0, 4);
  const maxModelTokens = topModels[0]?.[1] || 1;

  if (topModels.length === 0) {
    parts.push(svgText(535, 120, "No model breakdown available", { fill: FOOT, size: 12 }));
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
        svgText(535, yPos, displayName, { fill: USER, size: 12, weight: "500" }),
        `<rect x="${barX}" y="${yPos - 8}" width="${barW}" height="6" rx="3" fill="${BAR_BG}"/>`,
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

export function buildHarnessSvg(injectedClientDays?: Partial<Record<Client, DailyRecord[]>>): string {
  const dailyTokens: Record<string, number> = {};
  const clientDailyTokens: Record<string, Record<Client, number>> = {};

  for (const c of CLIENTS) {
    let days: DailyRecord[] = [];
    try {
      days = injectedClientDays?.[c] ?? loadClientDays(c);
    } catch {
      continue;
    }
    for (const d of days) {
      if (!d.date) continue;
      const tok = dayTokens(d);
      dailyTokens[d.date] = (dailyTokens[d.date] || 0) + tok;
      if (!clientDailyTokens[d.date]) {
        clientDailyTokens[d.date] = {} as Record<Client, number>;
      }
      clientDailyTokens[d.date][c] = (clientDailyTokens[d.date][c] || 0) + tok;
    }
  }

  const allDates = Object.keys(dailyTokens).sort();
  if (allDates.length === 0) return "";

  const latestDate = new Date(`${allDates[allDates.length - 1]}T00:00:00Z`);
  const wOffset = latestDate.getUTCDay();
  const startDate = new Date(latestDate);
  startDate.setUTCDate(latestDate.getUTCDate() - (52 * 7 + wOffset));

  const totalTokens = Object.values(dailyTokens).reduce((a, b) => a + b, 0);
  const activeDays = Object.values(dailyTokens).filter((v) => v > 0).length;
  const { currentStreak, maxStreak } = calculateStreaks(dailyTokens);

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
  const startDateStr = startDate.toISOString().slice(0, 10);
  const latestDateStr = latestDate.toISOString().slice(0, 10);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg width="846" height="215" viewBox="0 0 846 215" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(cardTitle)}">`,
    '  <rect width="845" height="214" x="0.5" y="0.5" rx="6" fill="#181926" stroke="#363a4f" stroke-width="1"/>',
    `  <text x="30" y="33" fill="#c6a0f6" font-size="16" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${cardTitle}</text>`,
    '  <text x="816" y="32" fill="#b8c0e0" font-size="13" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif" text-anchor="end">@shelken</text>',
    `  <text x="816" y="47" fill="#6e738d" font-size="11" font-weight="400" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" text-anchor="end">${startDateStr} · ${latestDateStr}</text>`,
    '  <text x="30" y="52" font-size="12" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">',
    `    <tspan fill="#cad3f5" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="#6e738d"> tokens · </tspan>`,
    `    <tspan fill="#cad3f5" font-weight="700">${activeDays}</tspan><tspan fill="#6e738d"> active days · </tspan>`,
    `    <tspan fill="#c6a0f6" font-weight="700">${currentStreak}d</tspan><tspan fill="#6e738d"> streak (max ${maxStreak}d)</tspan>`,
    "  </text>",
  ];

  for (const [w, m] of monthsLabels) {
    const x = 52 + w * 14;
    lines.push(
      `  <text x="${x}" y="70" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${m}</text>`
    );
  }

  lines.push(
    '  <text x="30" y="99" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Mon</text>',
    '  <text x="30" y="127" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Wed</text>',
    '  <text x="30" y="155" fill="#6e738d" font-size="10" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Fri</text>'
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
        `  <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="#24273a"><title>${iso}: Inactive</title></rect>`
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

  lines.push(
    '  <text x="30" y="198" fill="#6e738d" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Harness:</text>',
    '  <circle cx="102" cy="194" r="4.5" fill="#c6a0f6"/>',
    '  <text x="112" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">OMP</text>',
    '  <circle cx="160" cy="194" r="4.5" fill="#f5bde6"/>',
    '  <text x="170" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Pi</text>',
    '  <circle cx="200" cy="194" r="4.5" fill="#f5a97f"/>',
    '  <text x="210" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Claude</text>',
    '  <circle cx="265" cy="194" r="4.5" fill="#8aadf4"/>',
    '  <text x="275" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Codex</text>',
    '  <circle cx="330" cy="194" r="4.5" fill="#8bd5ca"/>',
    '  <text x="340" y="198" fill="#cad3f5" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">OpenCode</text>',
    '  <text x="636" y="198" fill="#6e738d" font-size="11" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">Intensity:</text>',
    '  <text x="690" y="198" fill="#6e738d" font-size="10" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">&lt; 0.5×</text>',
    '  <rect x="726" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.35"/>',
    '  <rect x="740" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.60"/>',
    '  <rect x="754" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.85"/>',
    '  <rect x="768" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="1.0"/>',
    '  <text x="784" y="198" fill="#6e738d" font-size="10" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">&gt; 2× avg</text>',
    "</svg>\n"
  );

  return lines.join("\n");
}

export async function renderVibeSnake(): Promise<string | null> {
  const script = join(ROOT, "scripts", "vibe-snake.ts");
  if (!existsSync(script)) return null;

  const proc = Bun.spawn(["bun", script], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    console.warn(`⚠ render_vibe_snake 失败: ${err.trim()}`);
    return null;
  }
  const outPath = join(USAGE_DIR, "vibe-snake.svg");
  if (existsSync(outPath)) {
    console.log(`✓ usage/vibe-snake.svg`);
    return outPath;
  }
  return null;
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
  let i = -1;
  let j = -1;

  if (text.includes(START_MARKER) && text.includes(END_MARKER)) {
    i = text.indexOf(START_MARKER);
    j = text.indexOf(END_MARKER) + END_MARKER.length;
  } else {
    for (let idx = 0; idx < LEGACY_STARTS.length; idx++) {
      const lStart = LEGACY_STARTS[idx];
      const lEnd = LEGACY_ENDS[idx];
      if (text.includes(lStart) && text.includes(lEnd)) {
        i = text.indexOf(lStart);
        j = text.indexOf(lEnd) + lEnd.length;
        break;
      }
    }
  }

  if (i === -1 || j === -1) {
    throw new UsageError(`README.md 缺少 ${START_MARKER} / ${END_MARKER}`);
  }

  writeFileSync(README_PATH, text.slice(0, i) + block + text.slice(j), "utf-8");
}

export function ccusageCmd(client: Client): string[] {
  const hasCcusage = Bun.which("ccusage");
  const base = hasCcusage ? ["ccusage"] : ["bunx", "ccusage"];

  if (client === "omp") {
    const ompDir =
      process.env.OMP_SESSIONS_DIR || join(homedir(), ".omp", "agent", "sessions");
    if (!existsSync(ompDir)) {
      throw new UsageError(`OMP 会话目录不存在: ${ompDir}`);
    }
    return [...base, "pi", "daily", "--pi-path", ompDir, "--json", "--offline"];
  }

  return [...base, client, "daily", "--json", "--offline"];
}

export async function runCcusage(client: Client): Promise<{ daily: unknown[] }> {
  const cmd = ccusageCmd(client);
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new UsageError(`ccusage ${client} 失败: ${stderr.trim()}`);
  }
  const raw = (await new Response(proc.stdout).text()).trim();
  if (!raw) {
    throw new UsageError(`ccusage ${client} 输出为空`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`ccusage ${client} JSON 无效: ${msg}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).daily)) {
    throw new UsageError(`ccusage ${client}: daily[] 缺失`);
  }
  return data as { daily: unknown[] };
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
  const daily = data.daily || [];
  const out = dataPath(client, name);
  if (daily.length === 0) {
    console.warn(`⚠ ${client}: daily 为空，跳过写入 ${out}`);
    return null;
  }
  writeFileSync(out, JSON.stringify(data, null, 2) + "\n", "utf-8");
  const total = daily.reduce((acc: number, d) => {
    const val = d && typeof d === "object" ? Number((d as Record<string, unknown>).totalTokens) || 0 : 0;
    return acc + val;
  }, 0);
  console.log(`✓ usage/data/${client}-${name}.json  days=${daily.length}  totalTokens=${total.toLocaleString()}`);
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
  const rendered: Client[] = [];

  await renderVibeSnake();

  const harnessSvg = buildHarnessSvg();
  if (harnessSvg) {
    writeFileSync(join(USAGE_DIR, "harness.svg"), harnessSvg, "utf-8");
    console.log("✓ usage/harness.svg");
  }

  for (const c of CLIENTS) {
    let days: DailyRecord[];
    try {
      days = loadClientDays(c);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠ skip ${c}: ${msg}`);
      continue;
    }
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

export function migrateLegacy(): void {
  ensureDirs();
  const legacyJson = join(ROOT, "mac-cc.json");
  if (existsSync(legacyJson)) {
    const dest = join(DATA_DIR, "pi-mio.json");
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(legacyJson, "utf-8"), "utf-8");
      console.log(`✓ migrate mac-cc.json → usage/data/pi-mio.json`);
    }
    unlinkSync(legacyJson);
    console.log(`✓ removed mac-cc.json`);
  }

  const legacySvg = join(ROOT, "pi-usage.svg");
  if (existsSync(legacySvg)) {
    unlinkSync(legacySvg);
    console.log(`✓ removed pi-usage.svg`);
  }
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

export async function gitCommit(paths: string[], message: string): Promise<void> {
  const rels = paths.filter((p) => existsSync(p)).map((p) => p.replace(ROOT + "/", ""));
  if (rels.length === 0) return;

  await runGit(["add", "--", ...rels]);
  const diffProc = Bun.spawn(["git", "diff", "--staged", "--quiet"], { cwd: ROOT });
  const diffCode = await diffProc.exited;
  if (diffCode === 0) {
    console.log("无变更，跳过 commit");
    return;
  }
  await runGit(["commit", "-m", message]);
  console.log("✓ committed");
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
  bun scripts/harness-usage.ts migrate
`);
    return;
  }

  try {
    if (cmd === "migrate") {
      migrateLegacy();
    } else if (cmd === "export") {
      const client = parseOption(args, "--client", "all");
      const name = parseOption(args, "--name", "mio");
      if (client !== "all" && !CLIENTS.includes(client as Client)) {
        die(`未知 client: ${client}`);
      }

      migrateLegacy();
      if (client === "all") {
        await exportAll(name);
      } else {
        await exportClient(client as Client, name);
      }
    } else if (cmd === "render") {
      migrateLegacy();
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
      migrateLegacy();
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
  main();
}
