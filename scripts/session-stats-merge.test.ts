import { describe, expect, it } from "bun:test";
import {
  mergeDailyScans,
  mergeSessionScans,
  assertArchiveEntries,
} from "../scripts/harness-usage.ts";

// PR #2 审查回归：存档是唯一副本，合并与校验不得静默丢历史
describe("session-stats 存档合并（对抗审查 B1/B2/B4 回归）", () => {
  const tok = (date: string, n: number) => ({
    date,
    inputTokens: n,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: n,
  });

  it("B1 次日凌晨扫描必须补全昨天下午的用量（不按“是否今天”判定）", () => {
    // 昨天 12:04 定时任务存了部分值，今天下午继续产生用量
    const merged = mergeDailyScans([tok("2026-10-13", 100)], [tok("2026-10-13", 200)]);
    expect(merged.length).toBe(1);
    expect(merged[0].totalTokens).toBe(200);
  });

  it("B4 原始日志减少/截断时当天不回退", () => {
    const merged = mergeDailyScans([tok("2026-10-14", 900)], [tok("2026-10-14", 1)]);
    expect(merged[0].totalTokens).toBe(900);
  });

  it("session 删除后历史日保留存档较大值，新日期照常插入并按日期升序", () => {
    const merged = mergeDailyScans(
      [tok("2026-10-12", 500), tok("2026-10-13", 700)],
      [tok("2026-10-12", 10), tok("2026-10-14", 300)]
    );
    expect(merged.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(merged.map((d) => d.totalTokens)).toEqual([500, 700, 300]);
  });

  it("四类 token 全零时按 totalTokens 兜底比较（opencode 缺 cache 字段场景）", () => {
    const stored = [{ date: "2026-10-13", totalTokens: 800 }];
    const scanned = [{ date: "2026-10-13", totalTokens: 50 }];
    expect(mergeDailyScans(stored, scanned)[0].totalTokens).toBe(800);
  });

  it("session 单调 upsert：活跃 session 刷新、已删 session 保留、新 session 插入", () => {
    const s = (id: string, n: number) => ({ sessionId: id, inputTokens: n });
    const merged = mergeSessionScans(
      [s("a", 100), s("gone", 50)],
      [s("a", 300), s("new", 10)]
    );
    const byId = Object.fromEntries(merged.map((x) => [x.sessionId, x.inputTokens]));
    expect(byId).toEqual({ a: 300, gone: 50, new: 10 });
  });

  it("session 回退值不覆盖存档", () => {
    const s = (id: string, n: number) => ({ sessionId: id, inputTokens: n });
    const merged = mergeSessionScans([s("a", 300)], [s("a", 5)]);
    expect(merged[0].inputTokens).toBe(300);
  });

  it("opencode 全量缺 lastActivity 时排序稳定不崩", () => {
    const s = (id: string) => ({ sessionId: id, inputTokens: 1 });
    const merged = mergeSessionScans([s("x"), s("y")], [s("z")]);
    expect(merged.map((x) => x.sessionId)).toEqual(["x", "y", "z"]);
  });

  it("B2 非法键条目报错而非静默丢弃", () => {
    expect(() =>
      assertArchiveEntries("daily", "测试存档", [{ date: 20261012, totalTokens: 900 }], "date")
    ).toThrow(/缺少合法 date/);
    expect(() =>
      assertArchiveEntries("sessions", "测试存档", [{ sessionId: 7 }], "sessionId")
    ).toThrow(/缺少合法 sessionId/);
  });

  it("CodeReviewGpt-B 同日重复键报错而非被 Map 折叠", () => {
    expect(() =>
      assertArchiveEntries(
        "daily",
        "测试存档",
        [tok("2026-09-01", 1000), tok("2026-09-01", 2000)],
        "date"
      )
    ).toThrow(/重复 date/);
  });

  it("合法条目通过校验", () => {
    expect(() =>
      assertArchiveEntries("daily", "测试存档", [tok("2026-09-01", 1), tok("2026-09-02", 2)], "date")
    ).not.toThrow();
  });
});
