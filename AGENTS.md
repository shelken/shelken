# shelken

GitHub 个人主页 README：用脚本生成用量卡片、技术栈徽章与博客文章列表。

## 布局

- `scripts/`: 脚本
- `GLOSSARY.md`: 领域模型与架构契约
- `justfile`: 常用命令
- `config/`: 静态配置 (如技术栈 tech-stack.yaml)
- `assets/`: 生成的 SVG（`usage/` 不进主分支，见规范）

## 偏好指引

- `主题色调`(Catppuccin Macchiato) 
- `技术栈` 从 resume repo 中发现
- 最近活跃项目
- 文章列表每日CI自动
- `scripts/` 的脚本如果没有特殊情况, 语言一律默认使用typescript

## 约束

- 禁 `任何个人隐私/私有库` 出现; 所有被Index的内容必须均为公开可见
- 每日细致数据使用范围映射(离散档位), 不公开
- 所有readme中的svg卡片必须统一视觉与设计, 做出UI变更时和用户确定变更范围
- 高频用量卡片等构建产物（assets/usage/*.svg）统一推送至孤儿分支（assets），禁止直接提交进主分支以防止仓库历史膨胀
