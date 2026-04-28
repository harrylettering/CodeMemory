# CodeMemory for Claude Code

[English](./README.md) | [简体中文](./README.zh-CN.md)

<p align="center">
  <strong>面向 Claude Code 的持久化工程记忆。</strong>
</p>

<p align="center">
  把决策、约束、失败记录和压缩摘要存进本地 SQLite，再在长会话、复杂重构和多轮调试中把真正相关的上下文带回来。
</p>

<p align="center">
  <a href="https://github.com/harrylettering/CodeMemory/stargazers">Star on GitHub</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#功能亮点">功能亮点</a>
  ·
  <a href="#配置">配置</a>
  ·
  <a href="#工具入口">工具</a>
  ·
  <a href="#开发">开发</a>
</p>

<p align="center">
  <a href="https://github.com/harrylettering/CodeMemory/stargazers"><img src="https://img.shields.io/github/stars/harrylettering/CodeMemory?style=flat-square" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin-black" alt="Claude Code Plugin" />
  <img src="https://img.shields.io/badge/SQLite-Local%20First-003B57" alt="SQLite Local First" />
  <img src="https://img.shields.io/badge/Persistent-Memory-1f6feb" alt="Persistent Memory" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

CodeMemory 是一个 local-first 的 Claude Code 插件，它把单个 session 内的临时上下文转成可持久化、可检索的工程记忆。它会把对话、摘要、决策、约束、失败和修复尝试落到 SQLite 中，再把真正相关的上下文注回到用户 prompt 和高风险工具调用前。

CodeMemory 是一个刻意收窄边界的系统，不是通用 RAG。它主要针对 Claude Code 的长会话、复杂重构和多轮调试场景，让 Agent 记住之前做过什么、为什么这么做、哪里已经踩过坑。

- Claude Code 插件名：`codememory-plugin`
- npm 运行时包名：`codememory-for-claude`

## 为什么需要 CodeMemory

CodeMemory 主要解决三类编码场景里的持续记忆问题：

1. **长 session**：在上下文窗口被截断后，核心需求和约束仍然能继续被看见。
2. **复杂重构**：保留设计理由、被否决方案和当前实现的决策轨迹。
3. **多轮调试**：在再次尝试前召回之前失败过的文件、命令和修复路径。

## 功能亮点

- **本地优先**：所有数据都保存在 `~/.claude/codememory.db`，不依赖外部服务。
- **Prompt 级检索**：每次用户提问都可以自动召回相关的 task、constraint、decision 和 failure。
- **失败预警**：在 `Edit`、`Write`、`Bash` 前检查这个目标之前是否失败过。
- **DAG 压缩**：长历史不会简单丢弃，而是压成 leaf summary 和 condensed summary。
- **结构化记忆节点**：`task`、`constraint`、`decision`、`failure`、`fix_attempt`、`summary` 都有 tag、relation 和生命周期状态。
- **快速运行路径**：每个 session 启一个 daemon，通过 Unix socket 提供热路径查找，并保留 CLI 冷启动兜底。
- **可调试、可追踪**：hooks、tools、slash commands 都围绕同一套运行模型组织。

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

## 安装后会发生什么

安装完成后，CodeMemory 大部分时候会自动运行：

1. `SessionStart` 初始化数据库并启动每 session 的 daemon。
2. daemon tail 当前 session 的 JSONL，因此既能 ingest hook 事件，也能 ingest 模型回复。
3. 每次 `UserPromptSubmit` 都可能触发 memory-first retrieval，把相关上下文注入 prompt。
4. 每次 `PreToolUse` 都会检查当前文件、命令或 symbol 是否存在 prior failure。
5. 随着历史增长，M/L-tier 消息会被异步压缩进 summary DAG，并提升为可复用的 memory node。

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

完整环境变量参考见 [docs/CONFIGURATION.zh-CN.md](./docs/CONFIGURATION.zh-CN.md)。

## 工具入口

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

## 文档

- [README.md](./README.md)：English README
- [docs/CONFIGURATION.zh-CN.md](./docs/CONFIGURATION.zh-CN.md)：完整环境变量参考
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)：English configuration reference

## 开发

### 仓库结构

| 路径 | 作用 |
|---|---|
| `src/` | 核心运行时：检索、压缩、store、hook runtime 和插件激活逻辑。 |
| `hooks/` | Claude Code 的 hook 定义和 shell 入口脚本。 |
| `commands/` | `/codememory-status`、`/codememory-watch` 等 slash command 描述。 |
| `skills/` | 用于标记 decision、task、constraint 的 Skills。 |
| `docs/` | 面向使用者的中英文配置参考。 |
| `test/` | 检索、生命周期、失败查找、压缩和工具的自动化测试。 |
| `benchmark/` | 查找路径的延迟基准测试。 |

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

## License

MIT.
