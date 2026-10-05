# 领域模型与架构契约 (CONTEXT.md)

本文档显式固化核心架构与领域概念，作为用量管线（Harness Usage）与技术栈徽章（Tech Stack Badges）的代码实现、类型命名与测试基准。

---

## 1. 用量管线 (Usage Pipeline)

### 1.1 客户端模型 (Harness Client)
- **`Client`**: 支持的 AI 编码助手客户端标识，严格限定为：
  - 主力客户端 (Primary): `omp` (Oh My Pi)
  - 历史生态 (Historical): `pi`, `claude` (Claude Code), `codex`, `opencode`
- **常量定义**:
  - `CLIENTS`: 全量客户端元组 `["omp", "pi", "claude", "codex", "opencode"]`
  - `HISTORICAL_CLIENTS`: 归档客户端列表 `["pi", "codex", "opencode", "claude"]`
  - `ACCENT`: 对应 Catppuccin Macchiato 强调色（`omp`: mauve, `pi`: pink, `claude`: peach, `codex`: blue, `opencode`: teal）
  - `TITLE`: 客户端展示名称映射

### 1.2 数据模型 (Usage Data)
- **`ModelBreakdown`**: 单个模型在特定维度的 Token 与花费细分。
  - 包含 `modelName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `cost`。
- **`DailyRecord`**: 单一客户端在单日的用量记录，汇总所有模型的贡献。
  - 包含 `date` (YYYY-MM-DD), `totalTokens`, `totalCost`, `modelBreakdowns`, `modelsUsed`。
- **`StreakStats`**: 连续活跃统计。
  - `currentStreak`: 当前连续打卡天数（截至最后活跃日，容忍当天正在进行中）。
  - `maxStreak`: 历史最长连续打卡天数。
- **`AggregateUsage`**: 跨客户端、跨节点的不可变全量聚合指标。
  - `dailyTokens`: 按日期汇总的全量 Token 字典 `Record<string, number>`。
  - `clientDailyTokens`: 按日期和客户端划分的 Token 字典。
  - `allDates`: 有序日期序列。
  - `startDate`, `latestDate`: 起止时间对象及字符串表示。
  - `totalTokens`: 全周期 Token 总和。
  - `activeDays`: 产生有效 Token 的活跃天数。
  - `currentStreak`, `maxStreak`: 全局打卡指标。

### 1.3 核心引擎 (UsageStore)
- **定位**: 纯内存数据处理引擎，吸收数据源格式差异与数学计算复杂度，与文件系统和视觉呈现完全解耦。
- **核心职责**:
  - **标准化 (`normalizeDay`)**: 吸收多客户端原始 JSON 中的格式差异（如缺省字段、字段命名兼容）。
  - **跨节点合并 (`mergeDailyRecords`)**: 支持多台工作机（如 `mio`, `sakamoto`）导出的同客户端同日数据按模型粒度深度合并与去重。
  - **时序与打卡 (`calculateStreaks`)**: 准确计算连续打卡、断签识别，鲁棒处理跨年与闰年。
  - **排行榜与过滤 (`rankModels`, `filterLastNDays`)**: 模型名称前缀清洗（`cleanModelName`）与 Token 降序排行。
  - **聚合构建 (`aggregateUsage`)**: 纯函数组装生成只读不可变的 `AggregateUsage` 契约对象。
  - **外部适配 (`loadClientDays`, `loadUsageDataset`)**: 边界层文件读取适配器。

### 1.4 视觉适配器 (Card Visualizers & Vibe Snake)
- **`Card Visualizers` (`scripts/usage/cards.ts`)**:
  - 纯函数渲染器：接受不可变数据，输出符合 W3C 标准的 SVG 字符串。
  - 视觉规范：严格使用 Catppuccin Macchiato 主题配色体系与 `USAGE_CONFIG` 布局度量。
  - 卡片族：
    - `buildClientSvg`: 单客户端综合卡片（如 `omp.svg`），展示统计指标、模型排名前 5 与最近 30 天迷你热力走势。
    - `buildHistorySvg`: 2×2 历史生态归档卡片（`history.svg`），按象限排版历史客户端用量。
    - `buildHarnessSvg`: 全周期 GitHub 风格年度热力图（`harness.svg`）。
- **`Vibe Snake` (`scripts/vibe-snake.ts`)**:
  - 动态贪吃蛇动画适配器，单向依赖 `UsageStore`。
  - **沙箱化契约**: 第三方 `generateSnakeAnimation` 运行时对 `globalThis.fetch` 和 `console.log` 的拦截必须封装在严格的 `try ... finally` 沙箱内，在退出时立即还原全局状态，杜绝全局泄漏。

---

## 2. 徽章管线 (Badge Pipeline)

### 2.1 领域模型 (Badge Models)
- **`PalKey`**: Catppuccin Macchiato 色板键名（`pink`, `mauve`, `red`, `peach`, `yellow`, `green`, `teal`, `sky`, `sapphire`, `blue`, `lavender`, `text`, `surface0`）。
- **`BadgeItem`**: 单个技术栈徽章元组 `[label: string, colorKey: PalKey, logo?: string | null]`。
- **`BadgeGroup`**: 逻辑分组，包含 `slug`, `title`, `items: BadgeItem[]`。

### 2.2 资产存储 (BadgeStore, `scripts/badges/store.ts`)
- **双适配器接缝**:
  - 本地磁盘缓存适配器（默认路径 `.cache/badges/`）：根据 Shields URL 的 SHA256 生成确定性文件名，优先读取命中缓存。
  - 远程 Shields.io 抓取适配器：受控并发池（Concurrency Worker Pool），带超时与指数退避重试机制。
- **高杠杆统一接口**:
  - `fetchBadges(items: BadgeItem[], options?: BadgeStoreOptions): Promise<Map<string, string>>`
  - 返回 URL 到 SVG 原始文本的完整映射。若遇到网络或 HTTP 异常，抛出携带具体 URL 的 `BadgeFetchError`。

### 2.3 几何排版引擎 (BadgeLayout, `scripts/badges/layout.ts`)
- **纯同步函数契约**:
  - `composeBadges(items: BadgeItem[], badgeMap: Map<string, string>): string`
  - 内部**零 I/O、零网络请求、零 async/await**。
- **几何与自动折行**:
  - 纯文本解析子徽章尺寸 (`parseSvg`)。
  - 依照 `MAX_ROW_WIDTH = 860`、`GAP = 6`、`HEIGHT = 28` 规则计算流式坐标与行高换行。
- **Fail-Fast 契约**:
  - 若 `badgeMap` 中缺失 `items` 所需的任意徽章 URL，立即抛出 `BadgeMissingError(url)`，绝不静默产出残缺破损的 SVG。
