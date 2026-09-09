---
name: harness-usage-sync
description: >
  Sync local harness token usage (OMP + Pi + Claude Code + Codex + OpenCode) into
  usage/*.svg under the profile repo. Use when updating vibe/usage cards,
  model ranks, or re-exporting ccusage JSON.
---

# Harness usage sync（OMP + Pi + 历史三客户端）

Entrypoint: `scripts/harness-usage.ts`
目录：

```
usage/
  data/omp-{device}.json  # omp 可多机
  data/pi-{device}.json   # pi 可多机
  data/claude.json
  data/codex.json
  data/opencode.json
  vibe-snake.svg / harness.svg
  omp.svg / history.svg
```

## Steps

1. **Export all**

   ```bash
   bun scripts/harness-usage.ts export --client all --name mio
   # 或 just export-usage
   ```

   **Done when:** `usage/data/` 下对应 JSON 有非空 `daily[]`。

2. **Render** SVG + README

   ```bash
   bun scripts/harness-usage.ts render
   # 或 sync：export + render
   bun scripts/harness-usage.ts sync --client all
   ```

   **Done when:**
   - `usage/vibe-snake.svg` 动态贪吃蛇
   - `usage/harness.svg` 全周期 Harness 图谱
  - `usage/omp.svg` 当前主力客户端卡片
  - `usage/history.svg` 2×2 历史 4 大生态归档卡片（Pi, Codex, OpenCode, Claude Code）
  - 全部 + 模型排行；**无费用**
  - README `HARNESS-USAGE` 嵌入上述 4 张 `./usage/*.svg`
3. **Preview**（GitHub API，非 grip）

   ```bash
   just preview
   # http://127.0.0.1:6450/.readme-preview.html
   ```

## Reference

- Token = input + output + cache
- Codex JSON 用 `models` 映射为 `modelBreakdowns`
- OMP / Pi 多机：不同 `--name` → `{client}-{name}.json`，render 深度合并同日数据
- 强调色 Macchiato：omp mauve / pi pink / claude peach / codex blue / opencode teal
