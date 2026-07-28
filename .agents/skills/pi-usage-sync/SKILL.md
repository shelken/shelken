---
name: pi-usage-sync
description: >
  Sync local agent token usage (Pi + Claude Code + Codex + OpenCode) into
  usage/*.svg under the profile repo. Use when updating vibe/usage cards,
  model ranks, or re-exporting ccusage JSON.
---

# Usage sync（Pi + 历史三客户端）

Entrypoint: `scripts/pi_usage.py`

目录：

```
usage/
  data/pi-{device}.json   # pi 可多机
  data/claude.json
  data/codex.json
  data/opencode.json
  pi.svg / claude.svg / codex.svg / opencode.svg
```

## Steps

1. **Export all**

   ```bash
   python3 scripts/pi_usage.py export --client all --name mac
   # 或 mise run export-usage
   ```

   **Done when:** `usage/data/` 下对应 JSON 有非空 `daily[]`。

2. **Render** SVG + README

   ```bash
   python3 scripts/pi_usage.py render
   # 或 sync：export + render
   python3 scripts/pi_usage.py sync --client all
   ```

   **Done when:**
   - `usage/pi.svg` 标题「最近Vibe统计 · Pi」
   - `usage/{claude,codex,opencode}.svg` 标题「历史 · …」
   - 全部 / 7d / 40d + 模型排行；**无费用**
   - README `PI-USAGE` 嵌入四个 `./usage/*.svg`

3. **Preview**（GitHub API，非 grip）

   ```bash
   mise run preview-readme
   # http://127.0.0.1:6450/.readme-preview.html
   ```

## Reference

- Token = input + output + cache
- Codex JSON 用 `models` 映射为 `modelBreakdowns`
- Pi 多机：不同 `--name` → `pi-{name}.json`，render 合并
- 强调色 Macchiato：pi pink / claude peach / codex blue / opencode teal
- Detail: `docs/user-guide/01-pi-usage-sync.md`
