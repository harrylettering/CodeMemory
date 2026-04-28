# CodeMemory 配置参考

> English version: [CONFIGURATION.md](./CONFIGURATION.md)

所有配置都通过 `CODEMEMORY_` 前缀的环境变量传入。默认值在 [`src/db/config.ts`](../src/db/config.ts) 的 `resolveCodeMemoryConfig` 中解析。README 的 Configuration 段只列出了最常调的旋钮；本文档是完整覆盖面。

每个模型环境变量都是独立的：`CODEMEMORY_EXPANSION_MODEL`、`CODEMEMORY_QUERY_PLANNER_MODEL`、`CODEMEMORY_COMPACTION_MODEL`、`CODEMEMORY_AUTO_SUPERSEDE_MODEL` 在未设置时都会各自默认到 `claude-haiku-4-5-20251001`。

> 旧文档里出现过、但本文未列出的环境变量，已在清理中作为 dead-letter 删除（在 config 中声明但运行时无人消费）。如果你的 shell 中还设置着这些变量，它们现在已经无效，可以移除。

## 核心开关

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | 总开关。设为 `false` 可在不卸载的情况下停用插件。 |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | 暴露 `codememory_grep`、`codememory_describe`、`codememory_expand`、`codememory_expand_query`、`codememory_memory_pending`、`codememory_memory_lifecycle` 给模型。默认关闭以保持工具面较小。 |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite 数据库文件路径。 |
| `CODEMEMORY_WORKSPACE_ROOT` | daemon 启动时的 `process.cwd()` | 用于跨仓库归一化 file tag，使 `/abs/foo.ts` 与 `./foo.ts` 命中同一锚点。注意：是 **daemon 在 SessionStart 时**的 cwd，不是你执行操作那一刻 shell 的 cwd。 |

## Compaction

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | 异步 compaction 总开关。 |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | 未压缩 M/L tier 消息 token 累计达到此值触发 compaction。 |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | 永远不参与压缩的最近消息条数 — 压缩只触碰早于这些消息的部分。 |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | 跳过 `claude --print`，使用截断 fallback。离线 / CI 必须开启。 |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | compaction 使用的模型。 |
| `CODEMEMORY_COMPACTION_MAX_INPUT_CHARS` | `24000` | 每个批次喂给 `claude --print` 的字符上限（约 6k tokens）。同时是 `leafChunkTokens` 的实际上限。 |

## Summary DAG 形状

下列旋钮控制 `AsyncCompactor` 构建的 leaf → condensed 结构。绝大多数用户不需要改。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_LEAF_CHUNK_TOKENS` | `20000`（受 `compactionMaxInputChars / 4` 限制）| 单个 leaf summary 批次的源 token 上限。 |
| `CODEMEMORY_LEAF_TARGET_TOKENS` | `1200` | leaf summary 的目标输出大小。 |
| `CODEMEMORY_CONDENSED_TARGET_TOKENS` | `2000` | depth-1 condensed summary 的目标输出大小。 |
| `CODEMEMORY_CONDENSED_MIN_FANOUT` | `4` | 生成 condensed summary 所需的兄弟 leaf 最小数量。 |
| `CODEMEMORY_INCREMENTAL_MAX_DEPTH` | `1` | 每次 leaf compaction 后增量做几层。默认保持 depth 1 的浅 DAG。 |
| `CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR` | `3` | 输出相对目标 tokens 的硬上限倍数。超过 `target × factor` 的 summary 会被拒绝并重新截断。 |

## Retrieval / 上下文装配

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | 启用可选 LLM query planner，仅在确定性 fast plan 召回偏弱时触发。会在这些 prompt 上多一次 `claude --print` 调用。 |
| `CODEMEMORY_QUERY_PLANNER_MODEL` | `claude-haiku-4-5-20251001` | planner 使用的模型。 |
| `CODEMEMORY_QUERY_PLANNER_TIMEOUT_MS` | `1200` | planner 子进程硬超时。planner 自己 kill 自己，绝不阻塞 prompt 注入。 |
| `CODEMEMORY_QUERY_PLANNER_MAX_TOKENS` | `800` | planner 配置接口里声明的 token 上限（目前用于 contract / 测试，尚未作为 CLI 参数传出）。 |
| `CODEMEMORY_EXPLORED_TARGET_WINDOW_MS` | `1800000`（30 分钟）| 同一 Read/Grep/Glob 目标在此窗口内重复探索会从 L 衰减到 N。超过窗口认为文件可能变了，再读视为新信号。 |
| `CODEMEMORY_MAX_ASSEMBLY_TOKEN_BUDGET` | `0`（= 使用内置默认）| 覆盖 `codememory_expand_query` 用的上下文装配 token 预算。 |

## Sub-agent expansion

`codememory_expand` 与 `codememory_expand_query` 使用。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_EXPANSION_MODEL` | `claude-haiku-4-5-20251001` | expansion 子 agent 的模型。 |
| `CODEMEMORY_EXPANSION_PROVIDER` | `anthropic` | expansion 子 agent 的 provider。 |
| `CODEMEMORY_MAX_EXPAND_TOKENS` | `4000` | `codememory_expand` 的 token 上限。 |
| `CODEMEMORY_DELEGATION_TIMEOUT_MS` | `120000` | 委托 expansion 子进程的超时。 |

## Auto-supersede（decision）

启用后，每次新 decision 被 mark、且未显式带 `supersedesNodeId` 时，会跑一次 haiku 检查**同一 conversation 中**的活跃 decision 是否被新的隐式覆盖，是则自动 supersede。跨 session 永远不自动处理 — 这是设计选择，不同项目的上下文不能可靠互相覆盖。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | LLM-as-judge auto-supersede 总开关。 |
| `CODEMEMORY_AUTO_SUPERSEDE_MODEL` | `claude-haiku-4-5-20251001` | judge 模型。 |
| `CODEMEMORY_AUTO_SUPERSEDE_MAX_CANDIDATES` | `20` | 每次 judge 考虑的活跃 decision 上限。 |
| `CODEMEMORY_AUTO_SUPERSEDE_TIMEOUT_MS` | `8000` | judge 调用硬超时。 |

## 已清理（不再识别）

下列变量历史上声明过但运行时无人消费，本次清理一并移除以避免"调了没用"的误导。如果你的环境里还设着这些，可以放心移除：

`CODEMEMORY_CONTEXT_THRESHOLD`、`CODEMEMORY_FRESH_TAIL_COUNT`（compactor 用的是 `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT`）、`CODEMEMORY_LEAF_MIN_FANOUT`、`CODEMEMORY_CONDENSED_MIN_FANOUT_HARD`、`CODEMEMORY_MAX_ROUNDS`、`CODEMEMORY_TIMEZONE`、`CODEMEMORY_PRUNE_HEARTBEAT_OK`、`CODEMEMORY_CIRCUIT_BREAKER_COOLDOWN_MS`、`CODEMEMORY_CIRCUIT_BREAKER_THRESHOLD`、`CODEMEMORY_MAX_EXPAND_QUERY_TOKENS`、`CODEMEMORY_SUMMARY_MODEL`、`CODEMEMORY_SUMMARY_PROVIDER`、`CODEMEMORY_FILES_PATH`、`CODEMEMORY_IGNORE_SESSION_PATTERNS`、`CODEMEMORY_STATELESS_SESSION_PATTERNS`、`CODEMEMORY_SKIP_STATELESS_SESSIONS`。
