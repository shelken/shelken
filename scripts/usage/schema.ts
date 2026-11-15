import { z } from "zod";

/**
 * ccusage 扫描输出与 ~/.session-stats 存档的线上格式。
 * 条目用 looseObject 保留未知字段，存档写回时不丢 ccusage 新增的信息。
 */

const tokenCount = z.number().nullish();

const tokenFields = {
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  totalTokens: tokenCount,
};

const ModelStatsSchema = z.looseObject({
  modelName: z.string().nullish(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cost: tokenCount,
});

export const ArchiveDaySchema = z.looseObject({
  date: z.string().min(1),
  ...tokenFields,
  totalCost: tokenCount,
  cost: tokenCount,
  modelBreakdowns: z.array(ModelStatsSchema).nullish(),
  // 旧版 ccusage：模型名数组，或「模型名 → 统计」字典
  models: z.union([z.array(z.string()), z.record(z.string(), ModelStatsSchema.nullish())]).nullish(),
  modelsUsed: z.array(z.string()).nullish(),
});

export const ArchiveSessionSchema = z.looseObject({
  sessionId: z.string().min(1),
  ...tokenFields,
  lastActivity: z.string().nullish(),
});

export const DailyFileSchema = z.object({ daily: z.array(ArchiveDaySchema) });
export const SessionsFileSchema = z.object({ sessions: z.array(ArchiveSessionSchema) });

export type ModelStats = z.infer<typeof ModelStatsSchema>;

export type ArchiveDay = z.infer<typeof ArchiveDaySchema>;

export type ArchiveSession = z.infer<typeof ArchiveSessionSchema>;

export type DailyFile = z.infer<typeof DailyFileSchema>;

export type SessionsFile = z.infer<typeof SessionsFileSchema>;

/**
 * 解析 JSON 文本并按 schema 校验；失败时抛出带原因的 Error，由调用方补充上下文。
 */
export function parseJsonText<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  const result = schema.safeParse(JSON.parse(text));

  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }

  return result.data;
}
