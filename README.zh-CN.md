# CodeMemory for Claude Code

> 面向 Claude Code CLI 的「编码场景持久记忆」插件。
> *English version: [README.md](./README.md)*

CodeMemory 是一个 Claude Code 插件，将 Agent 单 session 内的临时上下文转换成可持久化、可检索的工程记忆。它捕获完整 session JSONL，将每条消息按四级重要性（S / M / L / N）打分，从错误输出中抽取结构化失败记录，并将长历史增量压缩成一棵 summary DAG —— 全部存放在本地 SQLite 中。其结果是：Agent 能记住先前的决策，避免重复犯过的错，并在 compaction 之后依然保留项目上下文。

插件围绕三个编码场景做收敛：

1. **长 session** —— 在 sliding-window 截断之后，仍能稳定看到核心需求与约束。
2. **复杂重构** —— 保留当前代码背后的设计决策与被否决的备选方案。
3. **多轮调试** —— 在重新尝试已坏路径之前，召回先前的失败和修复尝试。

> Claude Code 注册的插件名：`codememory-plugin`。
> npm 运行时包名：`codememory-for-claude`。

---

## 特性

- **DAG 压缩。** 长历史被分组为 leaf 摘要 + 一层 condensed 摘要，替代 Claude Code 默认的有损 sliding-window 压缩。
- **Filter / Score 分层。** 每条消息被打成 S（skeleton — 完整文本）/ M（变更元数据）/ L（轻量 fact）/ N（噪音）。压缩只动 M/L，检索优先 S。
- **Memory Node 模型。** 结构化记忆：`task`、`constraint`、`decision`、`failure`、`fix_attempt`、`summary`，附带 tag、relation 与生命周期状态（`active` / `resolved` / `superseded` / `stale`）。
- **PreToolUse 阶段的失败查找。** 在每次 Edit / Write / Bash 之前，daemon 检查这个文件、命令或 symbol 是否曾经失败过。命中则通过 `additionalContext` 注入 markdown 警告，描述失败、修复尝试以及记录的年龄。
- **UserPromptSubmit 阶段的 Memory-first 检索。** 每条用户 prompt 触发一次确定性 fast plan，把相关的 task、constraint、decision、failure 拉进 prompt。当 fast plan 召回过弱时，可选的 LLM query planner 接管补强。
- **关系链拼接。** Memory node 之间通过 `relatedTo`、`supersedes`、`resolves` 等边相连。检索时可向外走最多两跳，把整条理由链而不只是孤立节点带回来。
- **双路径写入。** Hook 实时捕获事件；JSONL watcher tail `~/.claude/projects/<project>/<session>.jsonl`，捕获那些没有 hook 的事件（典型如模型回复），并能回放先前 session。
- **每 session daemon + 冷启动 fallback。** 后台 daemon 通过 Unix socket 提供约 50ms 的热路径查找；当 daemon 不可用时退化到 150–300ms 的 CLI 冷启动。
- **Skill 驱动的标记入口。** 三个 skill（`codememory-mark-decision`、`codememory-mark-task`、`codememory-mark-constraint`）让模型能显式落库意图，而不污染对话主轨。

---

## 架构总览

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Claude Code session                             │
│                                                                         │
│  SessionStart ──► session-start.sh ──► daemon (per-session)             │
│                                          ├─ JSONL watcher                │
│                                          ├─ scorer (S/M/L/N)             │
│                                          ├─ AsyncCompactor               │
│                                          └─ unix socket                  │
│                                                                         │
│  UserPromptSubmit ─► /retrieval/onPrompt ─► retrieval engine ─► markdown │
│  PreToolUse       ─► /failure/lookup     ─► prior-failure markdown      │
│  PreCompact       ─► /compact            ─► AsyncCompactor              │
│  SessionEnd       ─► daemon stop                                        │
│                                                                         │
│  Skills (mark-decision/task/constraint) ──► daemon /mark/*               │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                ┌────────────────────────────────────────┐
                │   ~/.claude/codememory.db (SQLite)     │
                │  conversations / messages / summaries  │
                │  memory_nodes / memory_tags / relations│
                │  lifecycle_events / pending_updates    │
                └────────────────────────────────────────┘
```

更深入的设计走读见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

## 安装

### 前置条件

- Node.js ≥ 18
- `jq` 和 `curl` 在 `$PATH`（hook 脚本依赖）
- Claude Code CLI

### 克隆并构建

```bash
git clone <repo-url> coding-agent-memory-system
cd coding-agent-memory-system
npm install
npm run build
chmod +x hooks/scripts/*.sh
```

### 链接到 Claude Code 插件目录

```bash
mkdir -p ~/.claude/plugins
ln -sf "$(pwd)" ~/.claude/plugins/codememory
```

重启 Claude Code 让插件生效。下一次 `SessionStart` 时，daemon 会自动起来，系统消息会确认 `CodeMemory initialized`。

---

## 配置

所有开关都是环境变量；默认值集中在 `src/db/config.ts`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | 总开关。 |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite 文件路径。 |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | 是否对模型暴露 `codememory_grep` / `codememory_describe` / `codememory_expand` / `codememory_memory_*` 等调试工具。 |
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | 是否启用异步 compaction。 |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | 触发 compaction 的未压缩 M/L token 阈值。 |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | 始终免疫压缩的最近消息条数。 |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | 摘要生成所用模型。 |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | 跳过 `claude --print`，使用截断 fallback（离线 / 测试场景必需）。 |
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | 启用 fast plan 召回过弱后的 LLM query planner。 |
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | 用 haiku 判官检测 conversation 内的隐式 decision supersede。 |
| `CODEMEMORY_WORKSPACE_ROOT` | `process.cwd()` | 跨仓库 file 标签归一化的根。 |

完整列表（忽略模式、扩展模型、query planner 超时、explored-target 窗口等）见 `src/db/config.ts`。

---

## 工具与 Skill

### 默认对模型暴露的工具

| 工具 | 用途 |
|---|---|
| `codememory_check_prior_failures` | 在风险编辑前查询「这个文件 / 命令 / symbol 之前是否失败过」。 |
| `codememory_mark_decision` | 把一个有意义的技术决策落成 `decision` memory node。 |
| `codememory_mark_requirement` | 把一个硬约束 / 稳定需求落成 `constraint` memory node。 |
| `codememory_compact` | 主动 force-compact 当前 conversation（达到阈值时也会自动触发）。 |

### 调试工具（`CODEMEMORY_DEBUG_TOOLS_ENABLED=true`）

`codememory_grep`、`codememory_describe`、`codememory_expand`、`codememory_expand_query`、`codememory_memory_pending`、`codememory_memory_lifecycle`。

### Skill

`codememory-mark-decision`、`codememory-mark-task`、`codememory-mark-constraint`、`codememory-context-skill`、`codememory-summarization-skill`。Mark 类 Skill 通过 `hooks/scripts/codememory-mark.sh` 把请求 POST 到 daemon 的 socket，daemon 是 `memory_nodes` 的唯一写入者。

### Slash 命令

`/codememory-status`、`/codememory-grep`、`/codememory-describe`、`/codememory-expand`、`/codememory-expand-query`、`/codememory-watch` —— 详见 `commands/`。

---

## 检索流程

1. **Pivot 抽取。** 从 prompt 中抽取文件路径、bash 二进制名、标识符（`HandleLogin`、`processPayment` …）。
2. **Fast plan。** 一个确定性规划器选定意图（`recall_decision_rationale`、`modify_and_avoid_prior_failure`、`continuation` …）、想要的节点 kind 列表、tag 查询。
3. **Memory-first 查找。** 借助 tag 索引在 `memory_nodes` 上查询，返回带分数的候选集。
4. **Relation 拼接。** 沿着白名单边（`relatedTo`、`supersedes`、`resolves`）最多走两跳；意图感知，例如「modify and avoid failure」会修剪只描述理由的支链。
5. **失败查找（Path A）。** `findFailuresByAnchors` 用 file / command / symbol pivot 命中失败节点；通过置信度下限（`MIN_CONFIDENCE = 0.6`）和 30 天半衰期时间衰减。
6. **Conversation Path B。** 当上面两路不够时，在 S-tier 消息中做关键词检索；`[DECISION]` 前缀行单独成桶。
7. **Markdown 注入。** 通过 `additionalContext` 注入一段 markdown；返回空 markdown 表示「跳过注入」。

当 fast plan 召回过弱、且 prompt 看上去是历史性追问（"why"、"earlier" 等）时，可选 LLM planner 会扩展 plan；失败时回落到 fast plan，并打上 metric 标记。

---

## Compaction 流程

`AsyncCompactor` 增量执行：

1. 比 `compactionFreshTailCount` 更早的 M/L 消息按 `compactionTokenThreshold` token 阈值分批。
2. 每批送给 `claude --print`（默认 `compactionModel = claude-haiku-4-5-20251001`）生成 leaf 摘要。当 `CODEMEMORY_COMPACTION_DISABLE_LLM=true` 或 LLM 调用失败时，回落到截断 fallback。
3. 当同一 parent 下积累到 `leafMinFanout` 个 leaf 时，向上 condense 出一层 depth=1 的摘要。
4. 高价值摘要（含决策、根因语言、失败 trace 的）会同时落成 `kind='summary'` 的 memory node，让检索能把它们与其它工程记忆一同召回。

`codememory_compact` 让模型可以按需触发。`PreCompact` 和 `SessionEnd` 也会冲刷一次。

---

## 数据模型

| 表 | 作用 |
|---|---|
| `conversations` | 每个 session 一行。 |
| `conversation_messages` + `message_parts` | 带 tier 标签的消息及其分段。 |
| `summaries` + `summary_parents` | Compaction DAG 的 leaf 与 condensed 节点。 |
| `memory_nodes` | 工程记忆：`task`、`constraint`、`decision`、`failure`、`fix_attempt`、`summary`。 |
| `memory_tags` | 索引列：`kind`、`file`、`command`、`symbol`、`signature`、`topic` 等。 |
| `memory_relations` | memory node 之间的有类型边（`relatedTo`、`supersedes`、`resolves` …）。 |
| `memory_lifecycle_events` | 状态变迁日志。 |
| `memory_pending_updates` | 需要人工确认的歧义 resolve。 |
| `attempt_spans` | Edit/Write → validate 命令的成对追踪，服务于 fix-attempt 关联。 |

`failure` 节点取代了早期独立的 `negative_experiences` 表 —— 详见 [`docs/PRIOR_FAILURE_REFERENCE.md`](./docs/PRIOR_FAILURE_REFERENCE.md)。

---

## 开发

```bash
npm install
npm run build              # tsc → dist/
npm run build:watch
npm test                   # vitest run --dir test
npm run test:watch
npm run benchmark          # build + node benchmark/lookup-latency.ts
npm run benchmark:ci       # CI 闸门，p95 > 200ms 时非零退出

# 跑单个测试文件
npx vitest run test/failure-lookup.test.ts
# 按名字匹配
npx vitest run -t "stitched chain"
```

构建只编译 `src/`；`test/` 目录用 NodeNext ESM 路径 `.js` 形式 import 编译产物，Vitest 直接运行 TS。Hook 脚本依赖 `jq` 与 `curl`；冷启动 fallback 还要求先 `npm run build` 让 `dist/` 存在。

在离线 / CI 环境下设置 `CODEMEMORY_COMPACTION_DISABLE_LLM=true`，避免 compactor 试图 spawn `claude --print`。

---

## 参考文档

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) —— 完整系统设计。
- [`docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md`](./docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md) —— 检索 pipeline。
- [`docs/MEMORY_NODE_LIFECYCLE.md`](./docs/MEMORY_NODE_LIFECYCLE.md) —— 节点状态、迁移、lifecycle resolver。
- [`docs/MEMORY_RETRIEVAL_REFERENCE.md`](./docs/MEMORY_RETRIEVAL_REFERENCE.md) —— 检索引擎内部。
- [`docs/PRIOR_FAILURE_REFERENCE.md`](./docs/PRIOR_FAILURE_REFERENCE.md) —— 失败捕获、查找与置信度评分。
- [`docs/TOOL_SURFACE_REFERENCE.md`](./docs/TOOL_SURFACE_REFERENCE.md) —— 工具 / skill / 命令的暴露表面。

## License

MIT.
