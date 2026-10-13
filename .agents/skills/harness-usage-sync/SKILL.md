---
name: harness-usage-sync
description: >
  Sync local harness token usage (OMP + Pi + Claude Code + Codex + OpenCode) into
  usage/*.svg under the profile repo. Use when updating vibe/usage cards,
  model ranks, or re-exporting ccusage JSON.
---

# Harness usage sync（OMP + Pi + 历史三客户端）

Entrypoint: `scripts/harness-usage.ts`
数据：`~/.session-stats/`（不在仓库内）

```
~/.session-stats/<client>/
  daily.json      # 日 × 模型 token，渲染消费的事实源
  sessions.json   # session × 模型 token + cost + projectPath，冻结存档
```

产物：`assets/usage/*.svg` 推送至孤儿分支 `assets`，不进 main 历史。

## Steps

1. **Export all**

   ```bash
   bun scripts/harness-usage.ts export --client all
   # 或 just export-usage
   ```

   **Done when:** `~/.session-stats/<client>/` 下 `daily[]` 与 `sessions[]` 非空。

   合并语义（关键，勿改）：
   - `daily.json` 同日单调取大：跨零点后的完整扫描会补全昨日，日志被清理时保留存档值
   - `sessions.json` 按 `sessionId` 单调 upsert，已删 session 保留
   - 写入为 `tmp` + rename 原子替换；存档或扫描条目非法（缺 `date`/`sessionId`、同日重复键）
     直接报错中止，不静默丢条目

2. **Render** SVG + README

   ```bash
   bun scripts/harness-usage.ts render
   # 或 sync：export + render
   bun scripts/harness-usage.ts sync --client all
   ```

   **Done when:**
   - `assets/usage/vibe-snake.svg` 动态贪吃蛇
   - `assets/usage/harness.svg` 全周期 Harness 图谱
   - `assets/usage/omp.svg` 当前主力客户端卡片
   - `assets/usage/history.svg` 2×2 历史 4 大生态归档卡片（Pi, Codex, OpenCode, Claude Code）
   - 全部 + 模型排行；**无费用**
   - README `HARNESS-USAGE` 嵌入上述 4 张卡片（`assets` 分支 raw URL）

3. **Preview**（GitHub API，非 grip）

   ```bash
   just preview
   # http://127.0.0.1:6450/.readme-preview.html
   ```

## Reference

- Token = input + output + cache
- Codex JSON 用 `models` 映射为 `modelBreakdowns`
- 历史数据在 session 删除后只剩 `~/.session-stats/`；session 级分析（按项目、按 session）依赖 `sessions.json`
- 定时任务：`just sync-push`（launchd `task-profile-usage`，0:04 / 12:04）
- 强调色 Macchiato：omp mauve / pi pink / claude peach / codex blue / opencode teal
