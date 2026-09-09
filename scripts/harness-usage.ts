#!/usr/bin/env bun
/**
 * 多 Harness 用量：ccusage 导出 JSON，渲染 assets/usage/*.svg，同步到 README。
 *
 * 用法:
 *   bun scripts/harness-usage.ts export [--client omp|pi|claude|codex|opencode|all] [--name mio]
 *   bun scripts/harness-usage.ts render
 *   bun scripts/harness-usage.ts sync [--client all] [--name mio] [--commit] [--push]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLIENTS,
  type Client,
  HISTORICAL_CLIENTS,
  ACCENT,
  TITLE,
  PALETTE,
  USAGE_CONFIG,
  type ModelBreakdown,
  type DailyRecord,
  type StreakStats,
  type AggregateUsage,
  UsageError,
} from "./usage/types";

import {
  cleanModelName,
  modelTokens,
  dayTokens,
  sumTokens,
  filterLastNDays,
  rankModels,
  fmtTokens,
  calculateStreaks,
  normalizeDay,
  mergeDailyRecords,
  loadClientDays,
  loadUsageDataset,
  loadAllClientDays,
  aggregateUsage,
  getAggregateUsage,
} from "./usage/store";

import {
  type TextOptions,
  escapeXml,
  svgText,
  buildClientSvg,
  buildHistorySvg as renderHistorySvg,
  buildHarnessSvg as renderHarnessSvg,
} from "./usage/cards";

import { renderVibeSnake } from "./vibe-snake";

// 向后兼容统一导出
export {
  CLIENTS,
  type Client,
  HISTORICAL_CLIENTS,
  ACCENT,
  TITLE,
  PALETTE,
  USAGE_CONFIG,
  type ModelBreakdown,
  type DailyRecord,
  type StreakStats,
  type AggregateUsage,
  UsageError,
  cleanModelName,
  modelTokens,
  dayTokens,
  sumTokens,
  filterLastNDays,
  rankModels,
  fmtTokens,
  calculateStreaks,
  normalizeDay,
  mergeDailyRecords,
  loadClientDays,
  loadUsageDataset,
  loadAllClientDays,
  aggregateUsage,
  getAggregateUsage,
  type TextOptions,
  escapeXml,
  svgText,
  buildClientSvg,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const ASSETS_DIR = join(ROOT, "assets");
export const CARDS_DIR = join(ASSETS_DIR, "usage");
export const USAGE_DIR = join(ROOT, "usage");
export const DATA_DIR = join(USAGE_DIR, "data");
export const README_PATH = join(ROOT, "README.md");

export const START_MARKER = "<!-- HARNESS-USAGE:START -->";
export const END_MARKER = "<!-- HARNESS-USAGE:END -->";

export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(CARDS_DIR, { recursive: true });
}

export function patchReadme(rendered: string[] = ["omp", "history"]): void {
  const lines: string[] = [START_MARKER, ""];

  if (existsSync(join(CARDS_DIR, "vibe-snake.svg"))) {
    const rel = "./assets/usage/vibe-snake.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="Vibe Activity" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "harness.svg"))) {
    const rel = "./assets/usage/harness.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="Harness" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "omp.svg")) && rendered.includes("omp")) {
    const rel = "./assets/usage/omp.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="OMP" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "history.svg")) && rendered.includes("history")) {
    const rel = "./assets/usage/history.svg";
    lines.push(`<a href="${rel}"><img class="usage-card" width="100%" src="${rel}" alt="History" /></a>`, "");
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

/**
 * 向后兼容导出的 buildHistorySvg：入参缺省时使用当前数据集
 */
export function buildHistorySvg(allClientDays?: Record<Client, DailyRecord[]>): string {
  const days = allClientDays || loadUsageDataset(DATA_DIR);
  return renderHistorySvg(days);
}

/**
 * 向后兼容导出的 buildHarnessSvg：入参缺省时自动计算聚合
 */
export function buildHarnessSvg(
  clientDays?: Record<Client, DailyRecord[]>,
  injectedAgg?: AggregateUsage | null
): string {
  const days = clientDays || loadUsageDataset(DATA_DIR);
  const agg = injectedAgg !== undefined ? injectedAgg : aggregateUsage(days);
  if (!agg) return "";
  return renderHarnessSvg(days, agg);
}

export function ccusageCmd(client: Client): string[] {
  const localBin = join(ROOT, "node_modules", ".bin", "ccusage");
  const hasLocal = existsSync(localBin);
  const hasGlobal = Bun.which("ccusage");
  const base = hasLocal ? [localBin] : hasGlobal ? ["ccusage"] : ["bunx", "ccusage"];
  if (client === "omp") {
    const home = homedir();
    const candidateDirs = [
      process.env.PI_CODING_AGENT_DIR,
      process.env.OMP_AGENT_DIR,
      join(home, ".omp", "agent"),
    ].filter(Boolean) as string[];

    const agentDir = candidateDirs.find((d) => existsSync(d)) || join(home, ".omp", "agent");
    const sessionsDir = join(agentDir, "sessions");
    return [...base, "pi", "daily", "--pi-path", sessionsDir, "--json", "--offline"];
  }

  return [...base, client, "daily", "--json", "--offline"];
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
  const results = await Promise.all(CLIENTS.map((c) => exportClient(c, name)));
  return results.filter((p): p is string => Boolean(p));
}

/**
 * 线性用量渲染管道
 */
export async function render(): Promise<string[]> {
  ensureDirs();
  const allClientDays = loadUsageDataset(DATA_DIR);
  const agg = aggregateUsage(allClientDays);

  await renderVibeSnake({ agg });

  const harnessSvg = agg ? renderHarnessSvg(allClientDays, agg) : "";
  if (harnessSvg) {
    writeFileSync(join(CARDS_DIR, "harness.svg"), harnessSvg, "utf-8");
    console.log("✓ assets/usage/harness.svg");
  }

  const rendered: string[] = [];

  // 主力客户端 (omp)
  const ompDays = allClientDays.omp || [];
  if (ompDays.length > 0) {
    const outPath = join(CARDS_DIR, "omp.svg");
    writeFileSync(outPath, buildClientSvg(ompDays, "omp"), "utf-8");
    rendered.push("omp");
    console.log(`✓ assets/usage/omp.svg  days=${ompDays.length}  total=${fmtTokens(sumTokens(ompDays))}`);
  }

  // 历史 4 大生态 2×2 归档卡片 (pi, codex, opencode, claude)
  const historySvg = renderHistorySvg(allClientDays);
  writeFileSync(join(CARDS_DIR, "history.svg"), historySvg, "utf-8");
  rendered.push("history");
  console.log("✓ assets/usage/history.svg (2×2 历史归档)");

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
        await gitCommit([CARDS_DIR, README_PATH], `chore: update usage cards (${client})`);
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
