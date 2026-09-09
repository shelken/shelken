# shelken profile — 常用命令
# 用法: just <recipe>   |   just --list

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()
bun := "bun"
export PATH := root + "/node_modules/.bin:" + env_var("PATH")

# 默认：列出常用 recipe
default:
	@just --list

# ── 用量与卡片 ──────────────────────────────────────────

# 本地同步用量（导出 + 渲染，不提交推送）
sync-usage client="all" name="mio":
	{{ bun }} {{ root }}/scripts/harness-usage.ts sync --client {{ client }} --name {{ name }}

# 自动化同步入口（导出 + 渲染 + 提交推送，供定时任务无感调用）
sync-push client="all" name="mio":
	{{ bun }} {{ root }}/scripts/harness-usage.ts sync --client {{ client }} --name {{ name }} --push

# 仅导出客户端 JSON 数据 → usage/data/
export-usage client="all" name="mio":
	{{ bun }} {{ root }}/scripts/harness-usage.ts export --client {{ client }} --name {{ name }}

# 仅渲染 assets/usage/*.svg + 更新 README
render-usage:
	{{ bun }} {{ root }}/scripts/harness-usage.ts render

# 仅渲染动态贪吃蛇 SVG (assets/usage/vibe-snake.svg)
render-snake:
	{{ bun }} {{ root }}/scripts/vibe-snake.ts

# 合成 Tech stack 横向 badge SVG（assets/badges/*.svg）并更新 README
build-badges:
	{{ bun }} {{ root }}/scripts/build-badges.ts

# ── 预览与测试 ──────────────────────────────────────────

# GitHub API 预览 README（支持 --open, --once, --port 等参数，Ctrl-C 退出）
preview *args:
	{{ bun }} {{ root }}/scripts/gh-preview.ts {{ args }}

# 运行测试 (bun test)
test *args:
	{{ bun }} test {{ args }}
