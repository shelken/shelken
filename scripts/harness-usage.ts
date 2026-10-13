#!/usr/bin/env bun
/**
 * 多 Harness 编码助手用量：ccusage 导出 → ~/.session-stats/<client>/{daily,sessions}.json（增量冻结），渲染 assets/usage/*.svg，同步 README。
 *
 * 用法:
 *   bun scripts/harness-usage.ts export [--client omp|pi|claude|codex|opencode|all]
 *   bun scripts/harness-usage.ts render
 *   bun scripts/harness-usage.ts sync [--client all] [--commit] [--push]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  aggregateUsage,
  SESSION_STATS_DIR,
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
  aggregateUsage,
  type TextOptions,
  escapeXml,
  svgText,
  buildClientSvg,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const ASSETS_DIR = join(ROOT, "assets");
export const CARDS_DIR = join(ASSETS_DIR, "usage");

export const README_PATH = join(ROOT, "README.md");

export const START_MARKER = "<!-- HARNESS-USAGE:START -->";
export const END_MARKER = "<!-- HARNESS-USAGE:END -->";

export const USAGE_ASSETS_BRANCH = "assets";
export const USAGE_ASSETS_RAW_BASE =
  "https://raw.githubusercontent.com/shelken/shelken/assets/assets/usage";

export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export function ensureDirs(): void {
  mkdirSync(SESSION_STATS_DIR, { recursive: true });
  for (const c of CLIENTS) {
    mkdirSync(join(SESSION_STATS_DIR, c), { recursive: true });
  }
  mkdirSync(CARDS_DIR, { recursive: true });
}

export function patchReadme(rendered: string[] = ["omp", "history"]): void {
  const lines: string[] = [START_MARKER, ""];

  if (existsSync(join(CARDS_DIR, "vibe-snake.svg"))) {
    const url = `${USAGE_ASSETS_RAW_BASE}/vibe-snake.svg`;
    lines.push(`<a href="${url}"><img class="usage-card" width="100%" src="${url}" alt="Vibe Activity" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "harness.svg"))) {
    const url = `${USAGE_ASSETS_RAW_BASE}/harness.svg`;
    lines.push(`<a href="${url}"><img class="usage-card" width="100%" src="${url}" alt="Harness" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "omp.svg")) && rendered.includes("omp")) {
    const url = `${USAGE_ASSETS_RAW_BASE}/omp.svg`;
    lines.push(`<a href="${url}"><img class="usage-card" width="100%" src="${url}" alt="OMP" /></a>`, "");
  }
  if (existsSync(join(CARDS_DIR, "history.svg")) && rendered.includes("history")) {
    const url = `${USAGE_ASSETS_RAW_BASE}/history.svg`;
    lines.push(`<a href="${url}"><img class="usage-card" width="100%" src="${url}" alt="History" /></a>`, "");
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
  const days = allClientDays || loadUsageDataset();
  return renderHistorySvg(days);
}

/**
 * 向后兼容导出的 buildHarnessSvg：入参缺省时自动计算聚合
 */
export function buildHarnessSvg(
  clientDays?: Record<Client, DailyRecord[]>,
  injectedAgg?: AggregateUsage | null
): string {
  const days = clientDays || loadUsageDataset();
  const agg = injectedAgg !== undefined ? injectedAgg : aggregateUsage(days);
  if (!agg) return "";
  return renderHarnessSvg(days, agg);
}

export function ccusageCmd(client: Client, sub: "daily" | "session"): string[] {
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
    return [...base, "pi", sub, "--pi-path", sessionsDir, "--json", "--offline"];
  }

  return [...base, client, sub, "--json", "--offline"];
}

export async function runCcusage(
  client: Client,
  sub: "daily" | "session"
): Promise<Record<string, unknown>> {
  const cmd = ccusageCmd(client, sub);
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (code !== 0) {
    throw new UsageError(`ccusage ${client} ${sub} 失败（退出码 ${code}）\n${stderr || stdout}`);
  }

  if (!stdout) {
    throw new UsageError(`ccusage ${client} ${sub} 输出为空`);
  }

  try {
    const data = JSON.parse(stdout);
    const key = sub === "daily" ? "daily" : "sessions";
    if (!data || !Array.isArray(data[key])) {
      throw new UsageError(`ccusage ${client} ${sub}: ${key}[] 缺失`);
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`ccusage ${client} ${sub} JSON 无效: ${err}`);
  }
}

export function dataPath(client: Client, file: "daily" | "sessions"): string {
  return join(SESSION_STATS_DIR, client, `${file}.json`);
}

function readStoredJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `存档损坏，拒绝覆盖以免丢历史: ${path}\n${msg}\n修复或恢复该文件后重试（可从备份还原，勿直接删除）`
    );
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * 存档是唯一副本：tmp+rename 原子替换，避免写中断留下截断文件。
 * 唯一 tmp 名，防定时任务与手工 sync 并发时互相搬走对方的临时文件。
 */
function writeStoredJson(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function localToday(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 日数据仅覆盖当天:历史日的 session 可能已删除,重扫值不完整,以已存为准。
 */
export function mergeDailyScans(
  stored: Record<string, unknown>[],
  scanned: Record<string, unknown>[],
  today = localToday()
): Record<string, unknown>[] {
  const byDate = new Map<string, Record<string, unknown>>();
  for (const d of stored) {
    if (typeof d.date === "string") byDate.set(d.date, d);
  }
  for (const d of scanned) {
    const date = d.date;
    if (typeof date !== "string") continue;
    if (date === today || !byDate.has(date)) byDate.set(date, d);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * session 按 sessionId upsert:活跃 session 刷新,已删 session 保留。
 */
export function mergeSessionScans(
  stored: Record<string, unknown>[],
  scanned: Record<string, unknown>[]
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of stored) {
    if (typeof s.sessionId === "string") byId.set(s.sessionId, s);
  }
  for (const s of scanned) {
    if (typeof s.sessionId === "string") byId.set(s.sessionId, s);
  }
  return [...byId.values()].sort((a, b) => String(a.lastActivity).localeCompare(String(b.lastActivity)));
}

export async function exportClient(client: Client): Promise<string | null> {
  ensureDirs();
  const dailyData = await runCcusage(client, "daily");
  const sessionData = await runCcusage(client, "session");

  const daily = Array.isArray(dailyData.daily) ? dailyData.daily : [];
  const sessions = Array.isArray(sessionData.sessions) ? sessionData.sessions : [];
  const dailyOut = dataPath(client, "daily");
  const sessionsOut = dataPath(client, "sessions");

  if (daily.length === 0 && sessions.length === 0) {
    console.warn(`[WARN] ${client}: 扫描为空，跳过写入`);
    return null;
  }

  const storedDaily = readStoredJson(dailyOut);
  const storedSessions = readStoredJson(sessionsOut);
  const mergedDaily = mergeDailyScans(
    Array.isArray(storedDaily?.daily) ? (storedDaily.daily as Record<string, unknown>[]) : [],
    daily
  );
  const mergedSessions = mergeSessionScans(
    Array.isArray(storedSessions?.sessions) ? (storedSessions.sessions as Record<string, unknown>[]) : [],
    sessions
  );

  writeStoredJson(dailyOut, { daily: mergedDaily });
  writeStoredJson(sessionsOut, { sessions: mergedSessions });

  const total = mergedDaily.reduce((acc, d) => acc + (Number(d.totalTokens) || 0), 0);
  console.log(
    `✓ ${client}: days=${mergedDaily.length} sessions=${mergedSessions.length} totalTokens=${total.toLocaleString("en-US")}`
  );
  return dailyOut;
}

export async function exportAll(): Promise<string[]> {
  const results = await Promise.all(CLIENTS.map((c) => exportClient(c)));
  return results.filter((p): p is string => Boolean(p));
}

/**
 * 线性用量渲染管道
 */
export async function render(): Promise<string[]> {
  ensureDirs();
  const allClientDays = loadUsageDataset();
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

export async function pushUsageAssets(options?: {
  branch?: string;
  remote?: string;
  commitOnly?: boolean;
  msg?: string;
}): Promise<string> {
  const branch = options?.branch || USAGE_ASSETS_BRANCH;
  const remote = options?.remote || "origin";
  const commitOnly = options?.commitOnly ?? false;
  const msg = options?.msg || "chore: sync usage cards";

  const tmpIndex = join(
    tmpdir(),
    `git_index_assets_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );

  const runGitEnv = async (args: string[], env: Record<string, string>, okCodes = [0]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
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
  };

  try {
    await runGitEnv(["add", "-f", "--", "assets/usage"], { GIT_INDEX_FILE: tmpIndex });
    const treeSha = await runGitEnv(["write-tree"], { GIT_INDEX_FILE: tmpIndex });
    const commitSha = await runGitEnv(["commit-tree", treeSha, "-m", msg], { GIT_INDEX_FILE: tmpIndex });

    await runGit(["update-ref", `refs/heads/${branch}`, commitSha]);

    if (!commitOnly) {
      await runGit(["push", remote, `${commitSha}:refs/heads/${branch}`, "--force"]);
      console.log(`✓ pushed assets/usage to orphan branch "${branch}" (commit ${commitSha.slice(0, 7)})`);
    } else {
      console.log(`✓ committed assets/usage to orphan branch "${branch}" (commit ${commitSha.slice(0, 7)})`);
    }

    return commitSha;
  } finally {
    if (existsSync(tmpIndex)) {
      rmSync(tmpIndex, { force: true });
    }
  }
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
  bun scripts/harness-usage.ts export [--client omp|pi|claude|codex|opencode|all]
  bun scripts/harness-usage.ts render
  bun scripts/harness-usage.ts sync [--client all] [--commit] [--push]
`);
    return;
  }

  try {
    if (cmd === "export") {
      const client = parseOption(args, "--client", "all");
      if (client !== "all" && !CLIENTS.includes(client as Client)) {
        die(`未知 client: ${client}`);
      }

      if (client === "all") {
        await exportAll();
      } else {
        await exportClient(client as Client);
      }
    } else if (cmd === "render") {
      await render();
    } else if (cmd === "sync") {
      const isPush = args.includes("--push");
      const isCommit = args.includes("--commit") || isPush;
      const client = parseOption(args, "--client", "all");
      if (client !== "all" && !CLIENTS.includes(client as Client)) {
        die(`未知 client: ${client}`);
      }

      if (isPush) {
        await gitPull();
      }
      if (client === "all") {
        await exportAll();
      } else {
        await exportClient(client as Client);
      }
      await render();

      if (isCommit || isPush) {
        await pushUsageAssets({
          branch: USAGE_ASSETS_BRANCH,
          commitOnly: !isPush,
          msg: `chore: update usage cards (${client})`,
        });

        const hasReadmeDiff = await runGit(["status", "--porcelain", "--", README_PATH]);
        if (hasReadmeDiff) {
          await gitCommit([README_PATH], `docs: update usage card references in README`);
          if (isPush) {
            await gitPush();
          }
        }
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
