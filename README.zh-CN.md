# CodeMemory for Claude Code

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](#前置条件)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)](#开发)
[![SQLite](https://img.shields.io/badge/SQLite-local--first-003B57?logo=sqlite&logoColor=white)](#架构总览)

> 面向 Claude Code CLI 的编码场景持久记忆插件。  
> English version: [README.md](./README.md)

CodeMemory 是一个 local-first 的 Claude Code 插件，它把单个 session 内的临时上下文转成可持久化、可检索的工程记忆。它会把对话、摘要、决策、约束、失败和修复尝试落到 SQLite 中，再把真正相关的上下文注回到用户 prompt 和高风险工具调用前。

CodeMemory 是一个刻意收窄边界的系统，不是通用 RAG。它主要针对 Claude Code 的长会话、复杂重构和多轮调试场景，让 Agent 记住之前做过什么、为什么这么做、哪里已经踩过坑。

> Claude Code 注册插件名：`codememory-plugin`  
> npm 运行时包名：`codememory-for-claude`

## 目录

- [为什么需要 CodeMemory](#为什么需要-codememory)
- [快速开始](#快速开始)
- [默认工作流](#默认工作流)
- [架构总览](#架构总览)
- [仓库结构](#仓库结构)
- [配置](#配置)
- [工具、Skill 与命令](#工具skill-与命令)
- [技术总览](#技术总览)
- [开发](#开发)
- [排障](#排障)
- [参考文档](#参考文档)
- [License](#license)

## 为什么需要 CodeMemory

CodeMemory 主要解决三类编码场景里的持续记忆问题：

1. **长 session**：在上下文窗口被截断后，核心需求和约束仍然能继续被看见。
2. **复杂重构**：保留设计理由、被否决方案和当前实现的决策轨迹。
3. **多轮调试**：在再次尝试前召回之前失败过的文件、命令和修复路径。

## 核心亮点

- **本地优先**：所有数据都保存在 `~/.claude/codememory.db`，不依赖外部服务。
- **Prompt 级检索**：每次用户提问都可以自动召回相关的 task、constraint、decision 和 failure。
- **失败预警**：在 `Edit`、`Write`、`Bash` 前检查这个目标之前是否失败过。
- **DAG 压缩**：长历史不会简单丢弃，而是压成 leaf summary 和 condensed summary。
- **结构化记忆节点**：`task`、`constraint`、`decision`、`failure`、`fix_attempt`、`summary` 都有 tag、relation 和生命周期状态。
- **快速运行路径**：每个 session 启一个 daemon，通过 Unix socket 提供热路径查找，并保留 CLI 冷启动兜底。
- **可调试、可追踪**：hooks、tools、slash commands 和文档都围绕同一套运行模型组织。

## 快速开始

### 前置条件

- Node.js 18 或更高版本
- Claude Code CLI
- `PATH` 中可用的 `jq` 与 `curl`

### 安装

```bash
git clone https://github.com/harrylettering/CodeMemory.git
cd CodeMemory
npm install
npm run build
chmod +x hooks/scripts/*.sh
```

### 链接到 Claude Code 插件目录

```bash
mkdir -p ~/.claude/plugins
ln -sf "$(pwd)" ~/.claude/plugins/codememory
```

仓库中已经包含 `.claude-plugin/plugin.json` 和 `hooks/hooks.json`，因此直接把仓库根目录链接为插件目录即可。

重启 Claude Code。下一次 `SessionStart` 时，CodeMemory 会初始化数据库、启动 per-session daemon，并开始监听当前 session 的 transcript。

## 默认工作流

安装完成后，CodeMemory 大部分时候会自动运行：

1. `SessionStart` 初始化数据库并启动每 session 的 daemon。
2. daemon tail 当前 session 的 JSONL，因此既能 ingest hook 事件，也能 ingest 模型回复。
3. 每次 `UserPromptSubmit` 都可能触发 memory-first retrieval，把相关上下文注入 prompt。
4. 每次 `PreToolUse` 都会检查当前文件、命令或 symbol 是否存在 prior failure。
5. 随着历史增长，M/L-tier 消息会被异步压缩进 summary DAG，并提升为可复用的 memory node。

## 架构总览

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Claude Code session                          │
│                                                                       │
│  SessionStart ──► session-start.sh ──► daemon (per-session)           │
│                                          ├─ JSONL watcher             │
│                                          ├─ scorer (S/M/L/N)          │
│                                          ├─ AsyncCompactor            │
│                                          └─ unix socket               │
│                                                                       │
│  UserPromptSubmit ─► /retrieval/onPrompt ─► retrieval engine          │
│  PreToolUse       ─► /failure/lookup     ─► prior-failure warning     │
│  PreCompact       ─► /compact            ─► AsyncCompactor            │
│  SessionEnd       ─► daemon stop                                      │
│                                                                       │
│  Skills (mark-decision/task/constraint) ──► daemon /mark/*            │
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

完整设计走读建议从 [docs/ARCHITECTURE.zh-CN.md](./docs/ARCHITECTURE.zh-CN.md) 开始。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `src/` | 核心运行时：检索、压缩、store、hook runtime 和插件激活逻辑。 |
| `hooks/` | Claude Code 的 hook 定义和 shell 入口脚本。 |
| `commands/` | `/codememory-status`、`/codememory-watch` 等 slash command 描述。 |
| `skills/` | 用于标记 decision、task、constraint 的 Skills。 |
| `docs/` | 更深入的架构与子系统参考文档。 |
| `test/` | 检索、生命周期、失败查找、压缩和工具的自动化测试。 |
| `benchmark/` | 查找路径的延迟基准测试。 |

## 配置

所有配置通过 `CODEMEMORY_*` 环境变量传入，在 [`src/db/config.ts`](./src/db/config.ts) 中解析。最常用的几条：

每个模型环境变量都独立配置；如果没有显式设置，都会默认使用 `claude-haiku-4-5-20251001`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | 全局总开关。 |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite 数据库路径。 |
| `CODEMEMORY_WORKSPACE_ROOT` | daemon 启动时的 `cwd` | 用于跨仓库归一化 file tag 的根路径。 |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | 是否向模型暴露 grep/describe/expand/lifecycle 管理工具。 |
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | 是否启用异步 compaction。 |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | 触发 compaction 的未压缩 M/L token 阈值。 |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | 永远不参与压缩的最近消息条数。 |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | 跳过 `claude --print`，改用截断 fallback。离线 / CI 必须开启。 |
| `CODEMEMORY_EXPANSION_MODEL` | `claude-haiku-4-5-20251001` | `codememory_expand` 与 `codememory_expand_query` 使用的模型。 |
| `CODEMEMORY_QUERY_PLANNER_MODEL` | `claude-haiku-4-5-20251001` | 可选 query planner 使用的模型。 |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | compaction 使用的模型。 |
| `CODEMEMORY_AUTO_SUPERSEDE_MODEL` | `claude-haiku-4-5-20251001` | 可选 auto-supersede judge 使用的模型。 |
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | fast-path 检索过弱时，启用可选 LLM planner。 |
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | 在单个 conversation 内自动检测隐式 decision supersede。 |
| `CODEMEMORY_EXPLORED_TARGET_WINDOW_MS` | `1800000`（30 分钟）| 同一 Read/Grep/Glob 目标在此窗口内重复探索会从 L 衰减到 N。 |

完整参考（DAG 形状、expansion sub-agent、auto-supersede 调参等）见 [docs/CONFIGURATION.zh-CN.md](./docs/CONFIGURATION.zh-CN.md)。

## 工具、Skill 与命令

### 默认可被模型调用的工具

| 工具 | 用途 |
|---|---|
| `codememory_check_prior_failures` | 查询某个文件、命令或 symbol 是否失败过。 |
| `codememory_mark_decision` | 把技术决策持久化成 `decision` 节点。 |
| `codememory_mark_requirement` | 把硬约束或稳定需求持久化。 |
| `codememory_compact` | 主动触发当前 conversation 的 compaction。 |

### 调试工具

设置 `CODEMEMORY_DEBUG_TOOLS_ENABLED=true` 后会暴露：

`codememory_grep`、`codememory_describe`、`codememory_expand`、`codememory_expand_query`、`codememory_memory_pending`、`codememory_memory_lifecycle`

### Skills

`codememory-mark-decision`、`codememory-mark-task`、`codememory-mark-constraint`、`codememory-context-skill`、`codememory-summarization-skill`

Mark 类 Skill 会通过 `hooks/scripts/codememory-mark.sh` 发送请求，而 daemon 仍然是 `memory_nodes` 的唯一写入者。

### Slash 命令

`/codememory-status`、`/codememory-grep`、`/codememory-describe`、`/codememory-expand`、`/codememory-expand-query`、`/codememory-watch`

## 技术总览

### 检索流程

1. 从用户 prompt 中抽取 pivot：文件路径、bash 二进制名和标识符。
2. 运行一个确定性的 fast plan，选出意图、目标节点类型和 tag 查询。
3. 优先通过 tag index 查 `memory_nodes`。
4. 沿着 `relatedTo`、`supersedes`、`resolves` 等边拼接相邻的理由链。
5. 对文件、命令和 symbol 运行 prior-failure 查找。
6. 当 memory-node 召回不够时，回落到 S-tier conversation 搜索。
7. 只有在召回足够强时，才通过 `additionalContext` 注入单个 markdown 块。

### Compaction 模型

1. 更早的 M/L-tier 消息达到阈值后会被分组。
2. 每组通过 `claude --print` 生成 leaf summary；若禁用 LLM compaction，则使用截断 fallback。
3. 相关 leaf 会继续向上 condense 成一层 depth-1 summary。
4. 高价值 summary 还会同步提升为 `memory_nodes(kind='summary')` 供后续检索复用。

### 数据模型

| 表 | 作用 |
|---|---|
| `conversations` | 每个 Claude Code session 一行。 |
| `conversation_messages` + `message_parts` | 带 tier 标签的消息及结构化分段。 |
| `summaries` + `summary_parents` | summary DAG 里的 leaf 和 condensed 节点。 |
| `memory_nodes` | 持久化工程记忆。 |
| `memory_tags` | `kind`、`file`、`command`、`symbol` 等索引 tag。 |
| `memory_relations` | `relatedTo`、`resolves`、`supersedes` 等有类型边。 |
| `memory_lifecycle_events` | 状态流转日志。 |
| `memory_pending_updates` | 需要人工确认的生命周期更新。 |
| `attempt_spans` | 用于 fix-attempt 追踪的 Edit/Write 到验证命令配对。 |

## 开发

```bash
npm install
npm run build
npm run build:watch
npm test
npm run test:watch
npm run benchmark
npm run benchmark:ci
```

常用单次命令：

```bash
npx vitest run test/failure-lookup.test.ts
npx vitest run -t "stitched chain"
```

说明：

- 构建会把 `src/` 编译到 `dist/`。
- hook 脚本依赖 `jq` 与 `curl`。
- prompt 级检索依赖 daemon 和编译后的 `dist/`。
- 离线或 CI 环境建议设置 `CODEMEMORY_COMPACTION_DISABLE_LLM=true`。

## 排障

- **没有出现检索或失败预警**：先执行 `npm run build`，然后重启 Claude Code，确保 hooks 和 `dist/` 已生效。
- **daemon 没有启动**：查看 `~/.claude/codememory-logs/session-start.log` 和 `~/.claude/codememory-logs/daemon.log`。
- **离线或 CI 场景 compaction 卡住**：设置 `CODEMEMORY_COMPACTION_DISABLE_LLM=true`。
- **需要查看运行状态**：使用 `/codememory-status`，并检查 `~/.claude/codememory.db`。

## 参考文档

- [docs/ARCHITECTURE.zh-CN.md](./docs/ARCHITECTURE.zh-CN.md)：完整系统设计
- [docs/CONFIGURATION.zh-CN.md](./docs/CONFIGURATION.zh-CN.md)：完整环境变量参考
- [docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.zh-CN.md](./docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.zh-CN.md)：检索 pipeline
- [docs/MEMORY_NODE_LIFECYCLE.zh-CN.md](./docs/MEMORY_NODE_LIFECYCLE.zh-CN.md)：节点状态与生命周期规则
- [docs/MEMORY_RETRIEVAL_REFERENCE.zh-CN.md](./docs/MEMORY_RETRIEVAL_REFERENCE.zh-CN.md)：检索引擎内部实现
- [docs/PRIOR_FAILURE_REFERENCE.zh-CN.md](./docs/PRIOR_FAILURE_REFERENCE.zh-CN.md)：失败捕获与查找
- [docs/TOOL_SURFACE_REFERENCE.zh-CN.md](./docs/TOOL_SURFACE_REFERENCE.zh-CN.md)：工具、Skill 和命令暴露面

## License

MIT.
