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
import type { z } from "zod";

import {
  CLIENTS,
  type Client,
  isClient,
  HISTORICAL_CLIENTS,
  PRIMARY_CLIENTS,
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
  filterLastMonths,
  rankModels,
  rankTopModels,
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

import {
  type ArchiveDay,
  type ArchiveSession,
  type DailyFile,
  type SessionsFile,
  DailyFileSchema,
  SessionsFileSchema,
  parseJsonText,
} from "./usage/schema";

import { renderVibeSnake } from "./vibe-snake";

// 向后兼容统一导出
export {
  CLIENTS,
  type Client,
  isClient,
  HISTORICAL_CLIENTS,
  PRIMARY_CLIENTS,
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
  filterLastMonths,
  rankModels,
  rankTopModels,
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

export function patchReadme(rendered: string[] = [...PRIMARY_CLIENTS, "history"]): void {
  const lines: string[] = [START_MARKER, ""];

  const cards: [slug: string, alt: string][] = [
    ["vibe-snake", "Vibe Activity"],
    ["harness", "Harness"],
    ...PRIMARY_CLIENTS.map((c): [string, string] => [c, TITLE[c]]),
    ["history", "History"],
  ];

  const alwaysShown = new Set(["vibe-snake", "harness"]);

  for (const [slug, alt] of cards) {
    if (!existsSync(join(CARDS_DIR, `${slug}.svg`))) continue;

    if (!alwaysShown.has(slug) && !rendered.includes(slug)) continue;
    const url = `${USAGE_ASSETS_RAW_BASE}/${slug}.svg`;
    lines.push(`<a href="${url}"><img class="usage-card" width="100%" src="${url}" alt="${alt}" /></a>`, "");
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
  const base = ["mise", "exec", "--", "ccusage"];

  if (client === "omp") {
    const home = homedir();

    const candidateDirs = [
      process.env.PI_CODING_AGENT_DIR,
      process.env.OMP_AGENT_DIR,
      join(home, ".omp", "agent"),
    ].flatMap((d) => (d ? [d] : []));

    const agentDir = candidateDirs.find((d) => existsSync(d)) || join(home, ".omp", "agent");
    const sessionsDir = join(agentDir, "sessions");

    return [...base, "pi", sub, "--pi-path", sessionsDir, "--json", "--offline"];
  }

  return [...base, client, sub, "--json", "--offline"];
}

async function ccusageText(client: Client, sub: "daily" | "session"): Promise<string> {
  const proc = Bun.spawn(ccusageCmd(client, sub), {
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

  return stdout;
}

function parseScan<S extends z.ZodType>(
  client: Client,
  sub: "daily" | "session",
  schema: S,
  text: string
): z.infer<S> {
  try {
    return parseJsonText(schema, text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`ccusage ${client} ${sub} 输出无效: ${msg}`);
  }
}

export async function scanDaily(client: Client): Promise<ArchiveDay[]> {
  return parseScan(client, "daily", DailyFileSchema, await ccusageText(client, "daily")).daily;
}

export async function scanSessions(client: Client): Promise<ArchiveSession[]> {
  return parseScan(client, "session", SessionsFileSchema, await ccusageText(client, "session")).sessions;
}

export function dataPath(client: Client, file: "daily" | "sessions"): string {
  return join(SESSION_STATS_DIR, client, `${file}.json`);
}

function readStoredFile<S extends z.ZodType>(path: string, schema: S): z.infer<S> | null {
  if (!existsSync(path)) return null;

  try {
    return parseJsonText(schema, readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `存档损坏，拒绝覆盖以免丢历史: ${path}\n${msg}\n修复或恢复该文件后重试（可从备份还原，勿直接删除）`
    );
  }
}

/**
 * tmp+rename 原子替换，避免写中断留下截断文件。
 * 唯一 tmp 名，防定时任务与手工 sync 并发时互相搬走对方的临时文件。
 */
function writeStoredJson(path: string, data: DailyFile | SessionsFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

interface TokenFields {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  totalTokens?: number | null;
}

function tokenSum(rec: TokenFields): number {
  const parts =
    (rec.inputTokens ?? 0) +
    (rec.outputTokens ?? 0) +
    (rec.cacheReadTokens ?? 0) +
    (rec.cacheCreationTokens ?? 0);

  return parts || rec.totalTokens || 0;
}

/**
 * 存档与扫描条目的键必须唯一：重复即中止，
 * 不允许合并 Map 静默折叠掉唯一副本里的历史记录。
 * 键缺失或类型非法已由 schema 在读入时拦截。
 */
export function assertUniqueKeys(
  file: "daily" | "sessions",
  source: string,
  keys: string[],
  keyName: "date" | "sessionId"
): void {
  const seen = new Set<string>();

  const dupes = keys.filter((k) => {
    const dup = seen.has(k);
    seen.add(k);

    return dup;
  });

  if (dupes.length > 0) {
    throw new UsageError(
      `${source} 的 ${file} 有 ${dupes.length} 条重复 ${keyName}（如 ${dupes[0]}），` +
        `合并会静默折叠丢数据；如需导入多源存档，请先用 mergeDailyRecords 求和归并`
    );
  }
}

function readStoredDaily(path: string): ArchiveDay[] {
  const daily = readStoredFile(path, DailyFileSchema)?.daily ?? [];
  assertUniqueKeys("daily", `存档 ${path}`, daily.map((d) => d.date), "date");

  return daily;
}

function readStoredSessions(path: string): ArchiveSession[] {
  const sessions = readStoredFile(path, SessionsFileSchema)?.sessions ?? [];
  assertUniqueKeys("sessions", `存档 ${path}`, sessions.map((s) => s.sessionId), "sessionId");

  return sessions;
}

/**
 * 单调合并：token 只增不减。
 * session 清理后重扫值变小 → 保留存档较大值；
 * 但当天跑完后的次日扫描（定时任务 00:04 / 12:04）必须能补全当天缺的半天，
 * 因此不能按「是否今天」判定，否则历史日会永久冻结在 12:04 的部分快照。
 */
export function mergeDailyScans(stored: ArchiveDay[], scanned: ArchiveDay[]): ArchiveDay[] {
  const byDate = new Map<string, ArchiveDay>();

  for (const d of stored) byDate.set(d.date, d);

  for (const d of scanned) {
    const prev = byDate.get(d.date);

    if (!prev || tokenSum(d) >= tokenSum(prev)) byDate.set(d.date, d);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * session 同样单调：活跃 session 增长即刷新，已删/截断的保留存档值。
 */
export function mergeSessionScans(stored: ArchiveSession[], scanned: ArchiveSession[]): ArchiveSession[] {
  const byId = new Map<string, ArchiveSession>();

  for (const s of stored) byId.set(s.sessionId, s);

  for (const s of scanned) {
    const prev = byId.get(s.sessionId);

    if (!prev || tokenSum(s) >= tokenSum(prev)) byId.set(s.sessionId, s);
  }

  return [...byId.values()].sort((a, b) => (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""));
}

export async function exportClient(client: Client): Promise<string | null> {
  ensureDirs();
  const daily = await scanDaily(client);
  const sessions = await scanSessions(client);

  const dailyOut = dataPath(client, "daily");
  const sessionsOut = dataPath(client, "sessions");

  assertUniqueKeys("daily", `ccusage ${client} 扫描`, daily.map((d) => d.date), "date");
  assertUniqueKeys("sessions", `ccusage ${client} 扫描`, sessions.map((s) => s.sessionId), "sessionId");

  if (daily.length === 0 && sessions.length === 0) {
    console.warn(`[WARN] ${client}: 扫描为空，跳过写入`);

    return null;
  }

  const mergedDaily = mergeDailyScans(readStoredDaily(dailyOut), daily);
  const mergedSessions = mergeSessionScans(readStoredSessions(sessionsOut), sessions);

  writeStoredJson(dailyOut, { daily: mergedDaily });
  writeStoredJson(sessionsOut, { sessions: mergedSessions });

  const total = mergedDaily.reduce((acc, d) => acc + (d.totalTokens ?? 0), 0);
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

  // 主力客户端：各出一张单客户端卡片
  for (const client of PRIMARY_CLIENTS) {
    const days = allClientDays[client] || [];

    if (days.length === 0) continue;
    writeFileSync(join(CARDS_DIR, `${client}.svg`), buildClientSvg(days, client), "utf-8");
    rendered.push(client);
    console.log(`✓ assets/usage/${client}.svg  days=${days.length}  total=${fmtTokens(sumTokens(days))}`);
  }

  // 历史生态 1×3 归档卡片 (codex, opencode, claude)
  const historySvg = renderHistorySvg(allClientDays);
  writeFileSync(join(CARDS_DIR, "history.svg"), historySvg, "utf-8");
  rendered.push("history");
  console.log("✓ assets/usage/history.svg (1×3 历史归档)");

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

function parseClientOption(args: string[]): Client | "all" {
  const value = parseOption(args, "--client", "all");

  if (value === "all" || isClient(value)) return value;

  return die(`未知 client: ${value}`);
}

async function exportSelected(client: Client | "all"): Promise<void> {
  if (client === "all") {
    await exportAll();
  } else {
    await exportClient(client);
  }
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
      await exportSelected(parseClientOption(args));
    } else if (cmd === "render") {
      await render();
    } else if (cmd === "sync") {
      const isPush = args.includes("--push");
      const isCommit = args.includes("--commit") || isPush;
      const client = parseClientOption(args);

      if (isPush) {
        await gitPull();
      }

      await exportSelected(client);

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
