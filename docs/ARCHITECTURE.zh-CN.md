# CodeMemory — Architecture

> English version: [ARCHITECTURE.md](./ARCHITECTURE.md)

> 本文是 CodeMemory 的系统设计走读，覆盖：摄入路径、daemon 生命周期、scorer 规则、memory store schema、检索 pipeline、compaction DAG、lifecycle resolver、prior-failure pipeline，以及它们之间的数据流。
>
> 与本文配套的更窄边界文档：
> - 检索 pipeline 细节：`MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.zh-CN.md`、`MEMORY_RETRIEVAL_REFERENCE.zh-CN.md`
> - 节点生命周期：`MEMORY_NODE_LIFECYCLE.zh-CN.md`
> - 失败记忆：`PRIOR_FAILURE_REFERENCE.zh-CN.md`
> - 工具表面：`TOOL_SURFACE_REFERENCE.zh-CN.md`

---

## 1. 设计目标

CodeMemory 不是一个通用 RAG 工具，而是一个面向「Claude Code 编码 session」的窄域记忆系统。设计上始终围绕三类场景优化：

1. **长 session** —— 让稳定需求/约束在 sliding-window 截断之后仍然可见。
2. **复杂重构** —— 保留「为什么是现在这个设计」的决策轨迹，包括被否决的备选。
3. **多轮调试** —— 在再次踏入坑之前给出 prior failure 提醒。

由此推出几条贯穿全文的设计原则：

- **本地优先。** 所有数据落 `~/.claude/codememory.db`，不依赖远端服务，离线可用。
- **不阻塞 Agent。** 任何 hook / lookup 失败都不能挡住工具调用；必须有 fallback 路径。
- **写入路径单写者。** `memory_nodes` 由 daemon 单写，避免并发写竞争。
- **检索路径多源、可降级。** Memory-first → Path A 失败查找 → Path B keyword fallback；任一环节失败可继续。
- **召回宁少不噪。** 每个层都设有置信度下限和反洪水机制（confidence floor、debounce、explored-target degradation）。

---

## 2. 高层组件

```
                ┌──────────────────────────────────────────┐
                │            Claude Code CLI                │
                │ (hooks, tools, skills, slash commands)    │
                └──────────────┬───────────────────────────┘
                               │
              hook scripts (bash)             tool calls (TS)
                               │                 │
                ┌──────────────▼─────────────────▼─────────┐
                │         Per-session daemon (TS)          │
                │                                          │
                │  ┌────────────┐   ┌────────────────────┐ │
                │  │ JSONL      │   │ unix socket server │ │
                │  │ watcher    │   │ /retrieval/onPrompt │ │
                │  │            │   │ /failure/lookup     │ │
                │  └─────┬──────┘   │ /compact            │ │
                │        │          │ /mark/*             │ │
                │  ┌─────▼──────┐   └──────────┬──────────┘ │
                │  │ Scorer     │              │            │
                │  │ (S/M/L/N)  │              │            │
                │  └─────┬──────┘              │            │
                │        │                     │            │
                │  ┌─────▼─────────────────────▼─────────┐  │
                │  │ ConversationStore / SummaryStore /  │  │
                │  │ MemoryNodeStore / NegExpExtractor / │  │
                │  │ AsyncCompactor / RetrievalEngine    │  │
                │  └──────────────────┬──────────────────┘  │
                │                     │                     │
                └─────────────────────┼─────────────────────┘
                                      ▼
                        ~/.claude/codememory.db (SQLite WAL)
```

`src/plugin/index.ts` 的 `createCodeMemoryPlugin()` 把所有 store 与 engine 一起组装并对外暴露。`src/hooks/daemon.ts` 是这些组件的运行时宿主。

---

## 3. Session 生命周期与 daemon

CodeMemory 把 daemon 的生命周期与 Claude Code 的 session 严格对齐：

```text
SessionStart  ──► hooks/scripts/session-start.sh
                  └─► nohup node dist/hooks/daemon.js start <sessionId> <cwd>
                       └─► 写 ~/.claude/codememory-runtime/<sid>.pid / .sock
                       └─► 启动 JSONL watcher，重放未读完的 session

UserPromptSubmit ─► hooks/scripts/user-prompt-submit.sh
                    └─► curl --unix-socket … /retrieval/onPrompt
                         └─► 命中 daemon hot path，注入 markdown

PreToolUse       ─► hooks/scripts/pre-tool-use.sh
                    └─► curl --unix-socket … /failure/lookup
                         └─► 命中 daemon hot path
                         └─► 失败时回落到 dist/failure-lookup-cli.js（cold path）

PreCompact       ─► hooks/scripts/pre-compact.sh
                    └─► curl --unix-socket … /compact

SessionEnd       ─► hooks/scripts/session-end.sh
                    └─► node dist/hooks/daemon.js stop <sessionId>
                         └─► 清理 .pid / .sock，flush compaction
```

要点：

- **per-session** 而非 per-process —— 不同 session 之间互不影响；崩溃不会污染他人。
- **socket 优先 + CLI 冷启动 fallback** —— 即使 daemon 进程死了，hook 仍能用 `dist/failure-lookup-cli.js` 完成本次 PreToolUse 查询，只是慢一点（150–300ms）。
- **崩溃残留** —— 崩溃后的 stale `.pid` / `.sock` 可能需要手工清理；`session-start.sh` 的逻辑会尝试探活并清理。

---

## 4. 双路径摄入

CodeMemory 同时跑两条摄入路径，喂同一个 store：

### 4.1 Hook 路径

`hooks/scripts/*.sh` 在 Claude Code 关键事件（SessionStart / UserPromptSubmit / PreToolUse / PreCompact / SessionEnd）触发 bash 脚本。Hook 拿到的事件 payload 是结构化的，**实时性好**，但不是所有事件都有 hook —— 典型的「模型回复内容」就没有。

### 4.2 JSONL watcher 路径

`src/jsonl-watcher.ts` tail `~/.claude/projects/<project>/<sessionId>.jsonl`，按 append 顺序解析每个事件。它能捕获：

- 模型回复（hook 没覆盖）
- session 中途启动 CodeMemory 时的历史回放
- 跨 session 的 prior failure 沉淀

两条路径的写入会被去重（按 `messageId`），并由 scorer 统一打分。

---

## 5. Scorer：S/M/L/N 四级

`src/filter/scorer.ts` + `src/filter/rules-coding.ts` 是整个系统的「闸门」。每条消息走完 scorer 才决定它怎么落库：

| Tier | 含义 | 存储 | 例子 |
|---|---|---|---|
| **S** | skeleton | 完整文本 + parts | 用户 prompt、模型 decision、错误片段、`[DECISION]` 行 |
| **M** | mutation 元数据 | 仅元数据，无 payload | Edit / Write / Bash 执行结果 |
| **L** | 轻量 fact | 仅 fact 字段 | Read / Glob / Grep 等探索性工具 |
| **N** | noise | 直接丢弃 | sidechain / subagent 内部消息、重复探索 |

`ScorerSessionState.exploredTargets` 记录最近 N 次窗口内访问过的目标，防止 L 级别的探索消息无限刷库 —— 重复访问会从 L 退化到 N。

> 设计含义：**改 scorer 等于改全系统的语义。** 例如把 Read 调成 M 而不是 L，会让 compaction、retrieval、prior-failure 全部产生连锁变化。

---

## 6. Store 层

### 6.1 ConversationStore (`src/store/conversation-store.ts`)

按 `conversationId` / `sessionId` / `sessionKey` 三层主键管理 conversation 与 messages。`message_parts` 表存每条消息的 typed 分段（text / tool_use / tool_result）。S 级消息保留全文；M / L 仅保留元数据。

### 6.2 SummaryStore (`src/store/summary-store.ts`)

`summaries` 表存所有摘要节点（leaf 与 condensed），`summary_parents` 是邻接表存 DAG 边。`leaf-*` ID 标识 leaf，`cond-*` 标识 condensed 节点。

### 6.3 MemoryNodeStore (`src/store/memory-store.ts`)

工程记忆的核心 store，承担：

- 写入：`createTask` / `createConstraint` / `createDecision` / `createFailureNode` / `createFixAttempt` / `createSummary`
- 索引：`memory_tags`（kind / file / command / symbol / signature / topic 等）
- 关系：`memory_relations`（`relatedTo` / `supersedes` / `resolves` / `attemptedFixFor` / `causedBy` / `derivedFromSummary` / `evidenceOf` / `conflictsWith`）
- 生命周期：`memory_lifecycle_events`、`memory_pending_updates`，状态机 `active → resolved / superseded / stale`
- 失败查询：`findFailuresByAnchors`、`resolveFailureNodesByTarget`、`autoResolveStaleFailureNodes`

`memory_nodes` 上有一个 UNIQUE `sourceToolUseId` 列，承担 mark-skill 的幂等性 —— 重试相同请求会落到同一个节点上。

### 6.4 NegExpExtractor (`src/negexp/extractor.ts`)

虽然 `negative_experiences` 表已经被并入 `memory_nodes`，但 extractor 模块仍然保留并被复用，它专门负责把「原始报错文本」解析成结构化字段（type / signature / filePath / command / symbol / location / attemptedFix）。这一层的存在让失败记忆始终有干净的索引列。

---

## 7. 检索 pipeline

`src/retrieval.ts::RetrievalEngine.retrieveForPrompt` 是每次 UserPromptSubmit 的入口。流程分为：

```
prompt
 │
 ├─► PivotExtractor: filePaths, bashBins, identifiers
 │
 ├─► FastPlanner (deterministic)
 │     intent ∈ { recall_decision_rationale,
 │                modify_and_avoid_prior_failure,
 │                continuation, generic }
 │     wantedKinds, tagQueries, hopBudget
 │
 ├─► (optional) LLM Query Planner   ─ 仅当 fast plan 召回弱 + 历史性 prompt
 │
 ├─► Memory-first lookup            ─ memory_tags 命中 + 评分
 │
 ├─► Relation stitching             ─ ≤ 2 hops, intent-aware whitelist
 │
 ├─► Path A: failure lookup          ─ findFailuresByAnchors，confidence ≥ 0.6, 30d 半衰期
 │
 ├─► Path B: keyword fallback        ─ S-tier conversation_messages，[DECISION] 单独成桶
 │
 ├─► DAG backfill                    ─ 必要时把对应 summary 节点带回
 │
 └─► markdown 注入 (additionalContext)
```

设计取舍：

- **fast 优先，LLM planner 兜底** —— 避免每条 prompt 都走 LLM。
- **置信度下限 + 半衰期** —— 不把弱相关结果硬塞给模型；过老的失败让位给新证据。
- **意图感知裁枝** —— 「修代码并避坑」不需要把哲学性 rationale 全拉出来；「为什么这样设计」才需要。
- **空 markdown == 跳过** —— retrieval 永远不报错；不召回就不注入。

---

## 8. Compaction DAG

`src/compaction/compactor.ts::AsyncCompactor` 增量构建摘要 DAG：

```
M/L messages (older than freshTailCount)
  │
  ├─ 按 token 阈值切批
  │
  ├─ 每批送 claude --print（compactionModel）
  │     └─► leaf summary node (leaf-*)
  │
  ├─ 同一 parent 累计 ≥ leafMinFanout 个 leaf
  │     └─► condensed summary node (cond-*) at depth=1
  │
  └─ 高价值摘要 → 同步写入 memory_nodes(kind='summary')
```

要点：

- **freshTailCount** 保护最近 N 条消息永远不被压。
- **incrementalMaxDepth=1** —— 默认只 condense 一层，避免过度抽象。
- **LLM fallback** —— `CODEMEMORY_COMPACTION_DISABLE_LLM=true` 时使用截断 fallback；offline / test 环境必备。
- **summary ↔ memory_node 双写**让检索能把高价值 summary 与 task / decision 放在同一通道一起召回。

`codememory_compact` 工具让模型主动 force-compact；`PreCompact` 与 `SessionEnd` 也会冲一次。

---

## 9. Memory node lifecycle

每个 memory node 都有一个状态机：

```
        ┌────────┐                ┌──────────┐
        │ active │ ─ resolves ──► │ resolved │
        └───┬────┘                └────┬─────┘
            │                          │
            │ supersedes               │ reopen
            ▼                          │
       ┌────────────┐                  │
       │ superseded │                  │
       └────────────┘                  │
            ▲                          │
            │                          │
        ┌────┴────────────────────────┘
        │ stale (auto, 长期未复发)
        ▼
     ┌───────┐
     │ stale │
     └───────┘
```

`LifecycleResolver`（见 `MEMORY_NODE_LIFECYCLE.zh-CN.md`）的职责：

- **reopenFailure** —— 同一 anchor 再次失败，把已 resolved 的失败节点重新打开。
- **resolveFailuresForSucceededAttempt** —— `attempt_spans` 中 Edit/Write→validate 配对成功后，关闭关联失败节点。
- **markSummaryStale** —— summary 引用的源消息被改写后，把 summary 标记 stale。
- **autoResolveStaleFailureNodes** —— 长期未复发的失败节点定期 resolve。

`memory_pending_updates` 用来承载「我不太确定要不要 resolve」的歧义场景，等人或后续证据敲定。

---

## 10. Prior-failure pipeline

prior-failure 是 CodeMemory 最具体的产品价值。从原始 error 到模型 warning 的全链路：

```
1. JSONL / tool result 中的错误文本
   ↓
2. NegExpExtractor.extractFromErrorMessage
   ↓
3. signature normalization (signature.ts)
   ↓
4. MemoryNodeStore.createFailureNode
     - kind='failure'
     - metadata: type / signature / raw / filePath / command / symbol / location / attemptedFix / seq
     - tags: kind / file / command / symbol / signature
     - lifecycle: active
   ↓
5. PreToolUse 触发
   ↓
6. lookupForPreToolUse:
     - daemon hot path /failure/lookup
     - cold fallback: dist/failure-lookup-cli.js
   ↓
7. findFailuresByAnchors (file/command/symbol pivots)
   ↓
8. scoreMatch: confidence ≥ 0.6, 30 天半衰期
   ↓
9. 反洪水 debounce: 同 nodeId 60s 内不重复注入
   ↓
10. additionalContext markdown 注入
```

`memory-store` 的失败查找会同时利用 tag 索引与 metadata 字段，因此可以做到 file / command / symbol / signature 多维交叉。

---

## 11. Mark skill 路径

`codememory-mark-decision` / `codememory-mark-task` / `codememory-mark-constraint` 是「让模型显式落库意图」的入口。流程：

```
Skill body 调用 → hooks/scripts/codememory-mark.sh <endpoint> <json>
                  └─► 发现当前活跃 daemon socket
                  └─► curl --unix-socket … /mark/decision (or /mark/requirement)
                       └─► daemon 派发到 CodeMemoryMarkDecisionTool / CodeMemoryMarkRequirementTool
                       └─► MemoryNodeStore 写入（sourceToolUseId 幂等）
                       └─► JSONL watcher 在识别到 mark skill 的 tool_use 时
                           落 S-tier conversation_messages 行
```

为什么走 socket 而不是直接当工具？因为：

- 让 daemon 成为唯一写入者，避免并发竞争；
- 把 mark 行为对 chat thread 的污染降到最低（skill body 极简）；
- 复用 hook 已有的认证与 sessionId 解析。

---

## 12. 配置与可观察

所有配置集中在 `src/db/config.ts::resolveCodeMemoryConfig`，每个 knob 都有 `CODEMEMORY_*` 环境变量。可观察手段：

- `codememory_memory_pending` / `codememory_memory_lifecycle`（debug 工具）—— 看 pending 与状态变迁。
- `codememory_describe` / `codememory_grep` / `codememory_expand`（debug 工具）—— 手工查节点。
- `/codememory-status` / `/codememory-watch` —— 看 daemon 与 JSONL watcher 当前状态。
- `npm run benchmark:ci` —— prior-failure lookup p95 延迟闸门（>200ms 失败）。

---

## 13. 失败模式与边界

CodeMemory 的边界：

- **不是通用 RAG。** 不索引代码内容、不索引仓库 doc。只关心 conversation 中的工程记忆。
- **不替代版本控制。** 不要把 CodeMemory 当 commit log 用 —— 它会衰减、会 supersede。
- **不强制可信。** 检索结果是建议而非事实；模型仍要自己核对。
- **不跨用户共享。** 数据库是 per-user 的本地 SQLite。
- **离线 / 测试需 `CODEMEMORY_COMPACTION_DISABLE_LLM=true`** —— 否则 compactor 会 spawn `claude --print` 失败。

常见失败模式与系统的应对：

| 场景 | 系统表现 |
|---|---|
| Daemon 崩溃 | hook 走 cold path CLI fallback；session-start 下一次自检并重启 |
| 同一错误重复 | debounce 60s + confidence 衰减，避免反复注入 |
| LLM compaction 失败 | 截断 fallback；不阻塞写入 |
| Stale `.sock` / `.pid` | session-start 探活清理 |
| Pivot 抽不到 anchor | 检索回落到 Path B keyword fallback；空 markdown 即跳过 |

---

## 14. 进一步阅读

- 检索更细的链：`MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.zh-CN.md`、`MEMORY_RETRIEVAL_REFERENCE.zh-CN.md`
- 节点状态机与 lifecycle resolver：`MEMORY_NODE_LIFECYCLE.zh-CN.md`
- 失败记忆字段、API、PreToolUse 流程：`PRIOR_FAILURE_REFERENCE.zh-CN.md`
- 工具 / skill / 命令暴露表面：`TOOL_SURFACE_REFERENCE.zh-CN.md`
- 项目级使用说明：根目录 `README.zh-CN.md` / `README.md`
