---
name: harness-usage-sync
description: >
  Sync local harness token usage (OMP + Pi + Claude Code + Codex + OpenCode) into
  usage/*.svg under the profile repo. Use when updating vibe/usage cards,
  model ranks, or re-exporting ccusage JSON.
---

# Harness usage sync（OMP + Pi + 历史三客户端）

Entrypoint: `scripts/harness_usage.py`

目录：

```
usage/
  data/omp-{device}.json  # omp 可多机
  data/pi-{device}.json   # pi 可多机
  data/claude.json
  data/codex.json
  data/opencode.json
  omp.svg / pi.svg / claude.svg / codex.svg / opencode.svg
```

## Steps

1. **Export all**

   ```bash
   python3 scripts/harness_usage.py export --client all --name mio
   # 或 just export-usage
   ```

   **Done when:** `usage/data/` 下对应 JSON 有非空 `daily[]`。

2. **Render** SVG + README

   ```bash
   python3 scripts/harness_usage.py render
   # 或 sync：export + render
   python3 scripts/harness_usage.py sync --client all
   ```

   **Done when:**
   - `usage/omp.svg` 标题「最近Vibe统计 · OMP」
   - `usage/pi.svg` 标题「历史 · Pi」
   - `usage/{claude,codex,opencode}.svg` 标题「历史 · …」
   - 全部 / 7d / 40d + 模型排行；**无费用**
   - README `HARNESS-USAGE` 嵌入五个 `./usage/*.svg`

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
