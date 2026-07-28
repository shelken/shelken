# shelken profile — 常用命令
# 用法: just <recipe>   |   just --list

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()
python := "python3"

# 默认：列出全部 recipe
default:
	@just --list

# ── 用量 ──────────────────────────────────────────────

# 导出全部客户端 JSON → usage/data/
export-usage client="all" name="mac":
	{{ python }} {{ root }}/scripts/pi_usage.py export --client {{ client }} --name {{ name }}

# 仅导出 Pi
export-pi name="mac":
	just export-usage client=pi name={{ name }}

# 仅导出 Claude / Codex / OpenCode
export-claude:
	just export-usage client=claude

export-codex:
	just export-usage client=codex

export-opencode:
	just export-usage client=opencode

# 渲染 usage/*.svg + 更新 README PI-USAGE 块
render-usage:
	{{ python }} {{ root }}/scripts/pi_usage.py render

# 导出 + 渲染（全客户端）
sync-usage client="all" name="mac":
	{{ python }} {{ root }}/scripts/pi_usage.py sync --client {{ client }} --name {{ name }}

# 根目录旧 mac-cc.json / pi-usage.svg 迁入 usage/
migrate-usage:
	{{ python }} {{ root }}/scripts/pi_usage.py migrate

# ── 预览 ──────────────────────────────────────────────

# GitHub API 预览 README（默认 :6450，Ctrl-C 停）
preview port="6450":
	{{ python }} {{ root }}/scripts/gh_preview.py --port {{ port }}

# 只写 .readme-preview.html，不启 HTTP
preview-once:
	{{ python }} {{ root }}/scripts/gh_preview.py --once

# 预览并打开浏览器
preview-open port="6450":
	{{ python }} {{ root }}/scripts/gh_preview.py --port {{ port }} --open

# ── 仓库 ──────────────────────────────────────────────

# 状态
status:
	git -C {{ root }} status -sb

# 看 diff
diff:
	git -C {{ root }} diff --stat
	git -C {{ root }} diff

# 提交（需自行传 message）
commit msg:
	git -C {{ root }} add -A
	git -C {{ root }} commit -m "{{ msg }}"

# 提交用量卡更新
commit-usage:
	git -C {{ root }} add usage README.md
	git -C {{ root }} status -sb
	git -C {{ root }} diff --staged --quiet && echo "无变更" || \
		git -C {{ root }} commit -m "chore: update usage cards"

# ── 一键 ──────────────────────────────────────────────

# 全量同步用量并预览
all: sync-usage
	@echo "→ just preview"
