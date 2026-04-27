# Memory Node 生命周期与状态更新设计

> English version: [MEMORY_NODE_LIFECYCLE.md](./MEMORY_NODE_LIFECYCLE.md)

> **状态说明（2026-04 更新）**：本文较长，部分小节描述了早期 `negative_experiences` 表与 Memory Node 双写的过渡架构（如 `failure-negexp-${id}` 强绑定、`syncFailureStatusesFromNegExp`、`reopenFailureForNegExp` 等）。该过渡层已被移除：失败节点直接以 `memory_nodes(kind='failure')` 单一存储，`negative_experiences` 表已删除。当前的入口是 `MemoryNodeStore.createFailureNode / findFailuresByAnchors / resolveFailureNodesByTarget` + `LifecycleResolver.reopenFailure`，详见 `docs/PRIOR_FAILURE_REFERENCE.zh-CN.md`。下文中保留这些早期描述作为设计史料。

## 1. 定位

Memory Node 是系统从历史会话中编译出来的可复用工程记忆。它不是原始日志，也不是完整 wiki，而是 prompt 检索阶段优先召回的稳定对象。

本文定义这些 node / mode 的职责、生成时机、状态变化和更新方式：

- `task`
- `constraint`
- `decision`
- `failure`
- `fix_attempt`
- `summary` / `summary_anchor`
- `relation`

当前实现状态：

```text
已实现：
  task / constraint Memory Node 显式写入
  prompt retrieval 可控两跳 relation stitch
  prompt retrieval intent-aware relation whitelist / chain template
  memory_nodes / memory_tags
  memory_relations
  memory_lifecycle_events
  memory_pending_updates
  attempt_spans
  failure resolved -> lifecycle event
  decision explicit supersede -> relation + lifecycle event
  summary_anchor -> derivedFromSummary relation
  LifecycleResolver 强/弱定位
  succeeded fix_attempt -> resolve failure 或 pending_update
  succeeded fix_attempt -> negative_experience resolved 反写
  Edit/Write/MultiEdit -> validation command -> fix_attempt tracker
  pending_update admin/apply/dismiss 工具
  reopen_failure / stale_summary / stale_node
  multi-command validation / partial fix_attempt outcome
  decision conflict detection + conflictsWith relation
  stale maintenance
  lifecycle debug/admin 查询工具
  task / constraint explicit supersede
  task / constraint lifecycle resolve / supersede admin
```

核心原则：

```text
Raw Message / Summary DAG 是证据层。
Memory Node 是召回层。
Memory Tag 是索引层。
Relation / Lifecycle Event 是状态变化和证据链。
```

Memory Node 的原始内容和 evidence 应尽量不可变。后续变化主要通过 `status`、`metadata.lifecycle`、tags 和 relation edges 表达。

## 2. 通用字段和状态

当前实现中的 `memory_nodes` 已包含：

```text
nodeId
kind
status
confidence
conversationId
sessionId
source
sourceId
summaryId
content
metadata
supersedesNodeId
createdAt
updatedAt
lastUsedAt
useCount
```

当前已落地的 `status`：

```text
active
resolved
superseded
stale
```

后续可以扩展的逻辑状态：

```text
candidate
pending_update
```

其中 `candidate` 表示低置信候选，默认不进入 prompt 注入；`pending_update` 表示系统发现可能的状态更新，但无法高置信定位目标 node，需等待更强证据或人工确认。

当前已实现 `memory_pending_updates`：当 `LifecycleResolver` 在成功验证后发现多个可能的 active failure 时，不会直接改任何 node，而是写入 pending update。

通用状态机：

```text
candidate -> active
active -> resolved
active -> superseded
active -> stale
resolved -> stale
resolved -> active        // 仅 failure 复发时允许 reopen
superseded -> stale
```

更新时必须同步：

```text
memory_nodes.status
memory_tags status:*
memory_nodes.updatedAt
metadata.lifecycle / metadata.outcome
memory_lifecycle_events
```

检索默认策略：

```text
默认注入：
  active task
  active constraint
  active decision
  active failure
  高相关 resolved failure
  active summary_anchor
  有明确 outcome 的 fix_attempt

默认排除：
  stale
  superseded
  candidate
  pending_update
```

## 3. 更新原则

### 3.1 不覆盖历史事实

旧 decision 被替代时，不把旧 node 原地改写成新 decision；应创建新 node，并把旧 node 标记为 `superseded`。

失败被修复时，不删除 failure node；应标记为 `resolved`，并记录 resolution。

summary_anchor 失去价值时，不删除 summary；只把 anchor node 标记为 `stale` 或 `superseded`。

### 3.2 强证据优先

状态更新的目标定位按以下优先级：

```text
1. direct nodeId
2. source + sourceId
3. explicit relation edge
4. attempt span / task span
5. exact signature + file + command
6. current conversation recent target
7. tag/query semantic score
8. no update
```

前 4 项是强定位，适合自动更新。后 4 项是弱定位，只应在置信度足够高、且候选之间差距明显时自动更新。

推荐阈值：

```text
confidence >= 0.85  自动更新
0.60 - 0.85         写 pending_update，不直接改 node
confidence < 0.60   不更新
多个候选接近        不更新
```

当前实现中，`LifecycleResolver` 已采用这个原则：

```text
单一强匹配 active failure:
  自动 active -> resolved

多个相近 active failure:
  写 memory_pending_updates
  不修改 memory_nodes
```

### 3.3 Relation 优于事后猜测

更准确的系统不是在状态变化时重新搜索“应该更新谁”，而是在创建 node 时就建立未来更新需要的锚点：

```text
failure      -> sourceId = negexpId
decision     -> sourceId = messageId 或 decisionId
fix_attempt  -> sourceId = attemptId
summary      -> summaryId = leaf-* / cond-*
relation     -> fromNodeId + toNodeId + relationType
```

这样后续更新可以沿 source 或 relation 直接定位。

### 3.4 task / constraint 是当前状态锚点

`task` 和 `constraint` 与 `decision` 不完全相同：

- `task` 回答“当前要做成什么”
- `constraint` 回答“什么不能被改坏、哪些边界必须保持”
- `decision` 回答“为什么选择这条实现路径”

对长会话 coding 来说，`task / constraint` 是最直接的连续性锚点，所以它们应默认进入 prompt 检索主链。

当前实现中的推荐生成时机：

```text
codememory_mark_requirement(kind=task)
codememory_mark_requirement(kind=constraint)
codememory_mark_requirement(..., supersedesNodeId=oldNodeId)
高置信 requirement/constraint 提取器（后续阶段）
```

当前建议状态变化：

```text
task:
  active -> resolved
  active -> superseded
  active -> stale

constraint:
  active -> resolved
  active -> superseded
  active -> stale
```

默认情况下，task / constraint 不应因为时间流逝自动删除；只有当目标完成、要求被替代，或已明显失去上下文价值时才更新状态。

当前已实现的显式更新路径：

```text
codememory_mark_requirement(..., supersedesNodeId=oldNodeId)
  -> create new active task/constraint node
  -> relation(newNode, oldNode, supersedes)
  -> oldNode.status = superseded
  -> lifecycle event supersede_task / supersede_constraint

codememory_memory_lifecycle action=resolve_node
  -> task / constraint status = resolved
  -> lifecycle event resolve_task / resolve_constraint

codememory_memory_lifecycle action=supersede_node
  -> task / constraint / decision 走统一 supersede 路径
```

## 4. Decision Mode

### 4.1 定义

`decision` 表示未来应该遵守的工程约束、实现选择或设计取舍。

典型内容：

```text
采用 X，不采用 Y。
以后这个模块统一走 Z。
不要再使用旧方案 A。
为了兼容 B，保留 C。
```

普通建议不是 decision。比如“可以考虑用 zod”只能作为 candidate，不能直接 active。

### 4.2 生成时机

高置信入口：

```text
codememory_mark_decision 显式调用
用户明确说“决定/采用/不要再/以后都/改成”
assistant 明确记录 Decision / Rationale
```

生成规则：

```text
kind = decision
status = active
confidence = explicit tool 1.0，规则识别 0.7-0.9
source = codememory_mark_decision / message_classifier
sourceId = messageId / decisionId
tags = kind:decision + status:active + file/topic/symbol/package
```

### 4.3 状态变化

```text
candidate -> active
active -> superseded
active -> stale
superseded -> stale
```

decision 不应仅因时间自动过期。只有以下情况才更新：

- 新 decision 明确替代旧 decision。
- 用户明确废弃旧 decision。
- 关联文件/模块已经不存在，且该 decision 不再适用。
- 维护任务发现同 topic/file 下存在冲突 decision，并经过确认。

### 4.4 更新方式

新 decision 替代旧 decision 时：

```text
new decision:
  status = active
  relation: supersedes -> old decision
  metadata.lifecycle.supersedesReason = ...
  supersedesNodeId = oldNodeId

old decision:
  status = superseded
  tag status:active -> status:superseded
  lifecycle event: active -> superseded
  metadata.lifecycle.supersededAt = ...
  metadata.lifecycle.supersededBy = newNodeId
```

当前已实现的强锚点路径：

```text
codememory_mark_decision(..., supersedesNodeId=oldNodeId)
  -> create new active decision node
  -> relation(newDecision, oldDecision, supersedes)
  -> oldDecision.status = superseded
  -> oldDecision status tag = status:superseded
  -> lifecycle event supersede_decision
```

默认 prompt retrieval 只注入 `active decision`。只有用户问历史演变时，才展示 `superseded decision`。

## 5. Failure Mode

### 5.1 定义

`failure` 表示之前发生过、未来需要避免重复的失败。

典型内容：

```text
某个文件修改后测试失败。
某条命令曾因特定错误失败。
某个 symbol / API 曾触发 runtime error。
某个修复方案导致 regression。
```

### 5.2 生成时机

高置信入口：

```text
tool result exit_code != 0
测试失败
TypeScript / lint / runtime error
stack trace
NegExp extractor 命中
```

生成规则：

```text
kind = failure
status = active
source = negative_experience
sourceId = negexpId
evidence = negexpId / messageId
tags = kind:failure + status:active + file/command/symbol/signature/topic
```

当前项目中 `failure-negexp-${id}` 是一个好的强锚点，因为后续 NegExp resolved 事件可以直接定位对应 Memory Node。

### 5.3 状态变化

```text
active -> resolved
resolved -> active      // 同类问题复发时 reopen
active -> stale
resolved -> stale
```

触发 `active -> resolved`：

```text
NegExp autoResolveStale
用户说“好了/修好了/成功了”
后续测试通过
fix_attempt outcome=succeeded
```

触发 `resolved -> active`：

```text
同 signature / file / command / symbol 的失败再次出现
```

触发 `resolved -> stale`：

```text
长期未复现
关联文件或模块已删除
useCount 长期为 0
已有更准确的 failure / decision / fix_attempt 覆盖它
```

### 5.4 更新方式

最准确路径：

```text
negative_experiences.id -> failure-negexp-${id}
```

例如：

```text
negative_experience 42 resolved
  -> memory node failure-negexp-42 status = resolved
  -> status tag 替换为 status:resolved
  -> metadata.resolution = ...
  -> lifecycle event resolve_failure
```

当前已实现路径：

```text
memoryStore.syncFailureStatusesFromNegExp()
  -> negative_experiences.id
  -> failure-negexp-${id}
  -> updateNodeStatus(toStatus=resolved, eventType=resolve_failure)
  -> status tag + lifecycle event 同步写入
```

当前也已实现反向同步路径：

```text
fix_attempt succeeded
  -> LifecycleResolver resolve single strong failure
  -> failure Memory Node status = resolved
  -> 如果 failure.metadata.negexpId 存在：
       negative_experiences.resolved = 1
       negative_experiences.resolution = resolution reason
```

如果没有 NegExp id，则用弱定位：

```text
kind=failure
status=active
same file / command / symbol / signature
same current conversation 优先
recent updatedAt 优先
```

弱定位必须满足高置信才自动更新；否则写 pending_update 或不更新。

## 6. Fix Attempt Mode

### 6.1 定义

`fix_attempt` 表示一次修复尝试及其结果。它的价值在于告诉未来模型：

```text
这个修法试过，失败了，别重复。
这个修法试过，成功了，可以优先参考。
这个修法只部分有效，需要注意边界。
```

`fix_attempt` 通常不是由单条消息决定，而是由事件序列生成：

```text
failure 出现
  -> Edit / Write / Patch 修改文件
  -> 重新运行测试或命令
  -> 成功 / 失败 / 未验证
```

### 6.2 生成时机

高价值入口：

```text
failure 后发生 edit/patch
用户或 assistant 明确提出“尝试修复”
修改后运行验证命令
修复尝试导致新的 failure
```

推荐引入 attempt span：

```text
attemptId
conversationId
startedAtSeq
endedAtSeq
touchedFiles
commandsRun
relatedFailureNodeIds
status
outcome
```

当前已实现 `attempt_spans` 表和 `FixAttemptTracker`：

```text
Edit / Write / MultiEdit / NotebookEdit
  -> open active attempt span
  -> create/update fix_attempt node outcome=unknown

Bash validation command tool_result
  -> close/update attempt span
  -> outcome=succeeded / failed / partial
  -> update fix_attempt node
```

当前 validation command 识别范围：

```text
test / vitest / jest / pytest
tsc / typecheck
eslint / lint
build
cargo test / go test
```

生成规则：

```text
kind = fix_attempt
status = active
source = fix_attempt_tracker
sourceId = attemptId
metadata.outcome = unknown | failed | succeeded | partial
tags = kind:fix_attempt + status:active + file/command/topic
relation = attemptedFixFor -> failure
```

### 6.3 状态变化

```text
candidate -> active
active -> resolved
active -> superseded
active -> stale
```

同时维护 `metadata.outcome`：

```text
unknown
failed
succeeded
partial
```

状态和 outcome 的关系：

```text
测试通过 / 用户确认有效:
  status = resolved
  outcome = succeeded

测试失败:
  status = active
  outcome = failed

只修好部分问题:
  status = active
  outcome = partial

后续被更好修法替代:
  status = superseded
```

### 6.4 更新方式

最准确路径：

```text
attemptId -> fix_attempt node
```

没有 attemptId 时，可以使用短时间窗口内的事件序列：

```text
recent active failure
same touchedFiles
edit/patch seq range
following command/test result
```

更新示例：

```text
Edit src/auth/login.ts
npm test passed
  -> recent fix_attempt outcome=succeeded
  -> relation resolves -> failure
  -> related failure status=resolved
```

当前实现中，如果成功验证后只有一个强匹配 active failure，`LifecycleResolver` 会自动写：

```text
relation(fix_attempt, failure, resolves)
failure.status = resolved
lifecycle event resolve_failure_after_fix_attempt
```

如果存在多个相近 active failure：

```text
memory_pending_updates.transition = resolve_failure
memory_pending_updates.status = pending
memory_nodes 不变
```

```text
Edit src/auth/login.ts
npm test failed
  -> recent fix_attempt outcome=failed
  -> failure remains active
  -> relation causedBy / attemptedFixFor
```

当前实现中，失败验证会把新 failure 与 fix_attempt 关联：

```text
relation(failure, fix_attempt, causedBy)
fix_attempt.status = active
fix_attempt.metadata.outcome = failed
```

当前也已支持多命令验证：

```text
Edit src/auth/login.ts
npm test passed
npm run build failed
  -> 同一个 attempt 继续收集 validationResults
  -> fix_attempt.outcome = partial
  -> fix_attempt.status = active
  -> 如果之前已因第一条成功命令 resolve failure，则 reopen 该 failure
```

## 7. Summary / Summary Anchor Mode

### 7.1 定义

当前实现中，summary anchor 以 `kind = summary` 保存，并通过 tag / metadata 表达 anchor 类型：

```text
kind = summary
metadata.anchorType = summary_anchor
tag kind:summary_anchor
```

`summary_anchor` 表示 DAG 中值得召回的入口。它不替代 decision / failure / fix_attempt，只负责让检索能定位到 summary DAG 的关键位置。

### 7.2 生成时机

入口：

```text
compaction 生成 leaf / condensed summary
```

只有高价值 summary 才生成 summary anchor。高价值信号包括：

```text
decision / decided / chose / rejected
root cause / fixed / failed
决定 / 选择 / 放弃 / 根因 / 修复 / 失败 / 问题在于
```

生成规则：

```text
kind = summary
status = active
source = summary_dag
sourceId = summaryId
summaryId = leaf-* / cond-*
metadata.anchorType = summary_anchor
tags = kind:summary_anchor + status:active + file/topic/symbol/command
```

当前已实现：

```text
memoryStore.createSummaryNode(summary)
  -> nodeId = summary-${summaryId}
  -> kind = summary
  -> metadata.anchorType = summary_anchor
  -> relation(summary-${summaryId}, summaryId, derivedFromSummary)
```

### 7.3 状态变化

```text
active -> stale
active -> superseded
superseded -> stale
```

触发 stale：

```text
summary 质量低或过泛
召回多次但没有使用价值
被更精确的 decision/failure/fix_attempt 覆盖
关联 DAG 证据失效
```

触发 superseded：

```text
更高层 condensed summary 覆盖旧 summary
新的 summary anchor 更准确地代表同一主题
```

### 7.4 更新方式

最准确路径：

```text
summaryId -> summary-${summaryId}
```

更新示例：

```text
summary leaf-1 被新的 cond-1 覆盖
  -> summary-leaf-1 status=superseded
  -> relation supersededBy -> summary-cond-1
```

默认检索可以召回 active summary_anchor，并在 token 预算允许时轻量展开一层 DAG evidence。默认不展开 raw messages。

## 8. Relation Mode

### 8.1 定义

`relation` 不应作为普通内容 node。它更适合做 node 之间的边，用来表达替代、修复、冲突和证据链。

当前已实现表：

```sql
CREATE TABLE IF NOT EXISTS memory_relations (
  relationId INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  relationType TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidenceMessageId INTEGER,
  evidenceSummaryId TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fromNodeId, toNodeId, relationType)
);
```

常用 relation types：

```text
supersedes
supersededBy
resolves
attemptedFixFor
causedBy
derivedFromSummary
evidenceOf
conflictsWith
relatedTo
```

当前 store 接口：

```ts
addRelation(input)
getRelationsForNode(nodeId, direction)
supersedeDecision(input)
```

### 8.2 生成时机

```text
新 decision 替代旧 decision
fix_attempt 修复 failure
fix_attempt 导致 failure
summary_anchor 来自 summary
两个 active decision 可能冲突
failure 和 summary_anchor 描述同一根因
```

### 8.3 更新方式

relation 更新的关键是定位两端节点：

```text
fromNodeId
toNodeId
relationType
confidence
evidence
```

示例：

```text
new decision supersedes old decision
  -> relation(newDecision, oldDecision, supersedes)
  -> oldDecision.status = superseded
```

```text
fix_attempt succeeded
  -> relation(fixAttempt, failure, resolves)
  -> failure.status = resolved
```

```text
fix_attempt failed
  -> relation(failure, fixAttempt, causedBy)
  -> fixAttempt.metadata.outcome = failed
```

```text
summary_anchor created
  -> relation(summaryNode, summaryId, derivedFromSummary)
```

decision 之间的取代关系优先依赖调用者显式传入 `supersedesNodeId`：

```text
new decision with supersedesNodeId
  -> supersedeDecision(oldNodeId, newNodeId)
  -> oldDecision.status = superseded

codememory_memory_lifecycle action=supersede_decision
  -> 显式 oldNodeId/newNodeId
  -> 调用 supersedeDecision
```

当 `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM=true` 且调用者未提供 `supersedesNodeId` 时，
daemon 会用 haiku 作为 judge 兜底：仅在同一 conversation 内挑出最近的 active
decisions，让模型逐条判定 `KEEP / SUPERSEDED_BY_NEW`，对返回 SUPERSEDED 的
节点调用 `supersedeDecision`。跨会话/跨 conversation 永远不自动处理 — 这是
设计决定，不是 bug：上下文不可见，自动 supersede 风险不对称（漏 vs. 误)。

## 9. Lifecycle Event Log

为了避免静默错误更新，当前已实现 append-only lifecycle log：

```sql
CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
  eventId INTEGER PRIMARY KEY AUTOINCREMENT,
  nodeId TEXT NOT NULL,
  fromStatus TEXT,
  toStatus TEXT NOT NULL,
  eventType TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  reason TEXT,
  evidenceMessageId INTEGER,
  evidenceSummaryId TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

当前 store 接口：

```ts
addLifecycleEvent(input)
getLifecycleEvents(nodeId)
updateNodeStatus(input)
```

所有状态变化都写入事件：

```text
failure active -> resolved
decision active -> superseded
summary active -> stale
fix_attempt active -> resolved
```

好处：

- 可审计。
- 可回滚。
- 能分析哪些规则误更新。
- 后续可训练或调优 lifecycle resolver。

当前已接入的 lifecycle event：

```text
resolve_failure
  来源：negative_experience resolved
  目标：failure-negexp-${id}

supersede_decision
  来源：显式 supersedesNodeId
  目标：old decision node
```

## 10. Lifecycle Resolver

当前已实现 `LifecycleResolver`，用于统一处理状态更新目标定位。第一版重点覆盖 `succeeded fix_attempt -> resolve active failure`。

```ts
interface LifecycleResolution {
  transition:
    | "resolve_failure"
    | "reopen_failure"
    | "supersede_decision"
    | "close_fix_attempt"
    | "stale_summary"
    | "stale_node";
  targetNodeIds: string[];
  confidence: number;
  reason: string;
  evidenceMessageId?: number;
  evidenceSummaryId?: string;
}
```

处理流程：

```text
event
  -> identify transition type
  -> resolve target node by strong anchors
  -> if strong target found: apply status update
  -> if weak target: write pending_update
  -> if ambiguous: do nothing
  -> write lifecycle event
```

强定位规则：

```text
failure:
  negexpId -> failure-negexp-${id}

decision:
  explicit new decision + old nodeId
  or same file/topic with explicit supersede language

fix_attempt:
  attemptId -> fix_attempt node

summary_anchor:
  summaryId -> summary-${summaryId}

relation:
  fromNodeId + toNodeId + relationType
```

弱定位规则：

```text
same file / command / symbol / signature
same current conversation
recent updatedAt
high tag overlap
high content/queryVariant match
```

弱定位只有在最高分明显高于第二名时才自动更新。

当前已落地的强定位路径不依赖弱定位：

```text
failure:
  negative_experience.id -> failure-negexp-${id}

decision:
  codememory_mark_decision.supersedesNodeId -> old decision node

summary_anchor:
  summary.summaryId -> summary-${summaryId}
```

当前 resolver 已实现：

```text
resolveFailuresForSucceededAttempt(...)
  -> findActiveFailuresByAnchors(files, commands)
  -> 单一强匹配：updateNodeStatus(resolved) + relation resolves
  -> 多候选/弱匹配：addPendingUpdate(...)

reopenFailureForNegExp(...)
  -> 新 failure 复发时查找 resolved/stale failure
  -> 单一强匹配：active + lifecycle reopen_failure
  -> 多候选/弱匹配：pending_update(reopen_failure)
  -> 如果旧 failure 来自 NegExp，同步 negative_experiences.resolved = 0

markSummaryStale(...) / markNodeStale(...)
  -> direct nodeId
  -> updateNodeStatus(stale)
  -> lifecycle event stale_summary / stale_node
```

## 10.1 Pending Update

`pending_update` 是低置信 lifecycle 更新的缓冲区。它不改变 `memory_nodes`，只保存候选和理由。

当前已实现表：

```sql
CREATE TABLE IF NOT EXISTS memory_pending_updates (
  pendingId INTEGER PRIMARY KEY AUTOINCREMENT,
  transition TEXT NOT NULL,
  eventType TEXT NOT NULL,
  targetNodeId TEXT,
  targetCandidates TEXT,
  fromStatus TEXT,
  toStatus TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT,
  evidenceMessageId INTEGER,
  evidenceSummaryId TEXT,
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

当前 store 接口：

```ts
addPendingUpdate(input)
getPendingUpdate(pendingId)
getPendingUpdates(status)
applyPendingUpdate({ pendingId, targetNodeId?, reason? })
dismissPendingUpdate({ pendingId, reason? })
```

典型写入场景：

```text
fix_attempt succeeded
  -> 多个 active failure 同时匹配 file/command
  -> 写 pending resolve_failure
  -> 不自动改任何 failure 状态
```

当前 debug/admin 工具：

```text
codememory_memory_pending
  action=list     -> 列出 pending/applied/dismissed 更新
  action=apply    -> 应用到 targetNodeId 或单一候选
  action=dismiss  -> 驳回 pending update
```

该工具只在 `CODEMEMORY_DEBUG_TOOLS_ENABLED=true` 时暴露，避免进入默认 prompt 热路径。

应用 pending update 时会重新校验：

```text
pending.status 必须是 pending
target node 必须存在
如果 fromStatus 存在，target node 当前 status 必须匹配
多候选 pending 必须显式传 targetNodeId
```

应用成功后同步写入：

```text
memory_nodes.status
memory_tags status:*
memory_lifecycle_events
memory_pending_updates.status = applied
```

驳回后：

```text
memory_pending_updates.status = dismissed
metadata.dismissedReason / dismissedAt
memory_nodes 不变
```

## 11. 默认召回与注入影响

状态更新会直接影响 prompt retrieval：

```text
active failure:
  强提醒，优先注入。

resolved failure:
  降权注入，只在强匹配时提示曾经失败过以及解决方式。

active decision:
  作为当前约束注入。

superseded decision:
  默认不注入，除非用户问历史演变。

fix_attempt outcome=failed:
  强价值，提醒模型不要重复同一修法。

fix_attempt outcome=succeeded:
  可作为推荐路径或 resolution evidence。

summary_anchor active:
  作为 DAG 入口注入，可轻量展开一层 evidence。

stale:
  默认不注入。
```

## 11.1 Stale Maintenance

当前已实现 `memoryStore.runStaleMaintenance(...)`，用于把低价值旧节点从默认召回面移出。

默认规则：

```text
active summary:
  长期未使用 -> stale_summary

resolved failure:
  长期未复现且低使用 -> stale_node

resolved fix_attempt:
  长期未使用 -> stale_node

superseded node:
  保留一段时间后 -> stale_node

active decision:
  不因时间自动 stale
```

运行入口：

```text
daemon:
  每小时最多运行一次轻量 stale maintenance

codememory_memory_lifecycle:
  action=stale_maintenance
```

## 11.2 Lifecycle Debug/Admin

当前已实现 `codememory_memory_lifecycle`，仅在 `CODEMEMORY_DEBUG_TOOLS_ENABLED=true` 时暴露。

支持动作：

```text
inspect_node
list_events
list_relations
stale_maintenance
resolve_node
supersede_node
supersede_decision
mark_stale
reopen_failure
```

它与 `codememory_memory_pending` 分工：

```text
codememory_memory_pending:
  管理低置信 pending updates

codememory_memory_lifecycle:
  管理已定位 node 的生命周期审计和纠偏
```

## 12. 分阶段落地建议

### 当前阶段

- 保持现有 `memory_nodes` / `memory_tags`。
- 已新增 `memory_relations` / `memory_lifecycle_events`。
- 已新增 `memory_pending_updates`。
- 已新增 `attempt_spans`。
- 已保证 `failure-negexp-${id}` 强绑定 NegExp。
- 已支持 `failure active -> resolved` 写 lifecycle event。
- 已支持 `codememory_mark_decision` 创建 active decision。
- 已支持显式 `supersedesNodeId` 将旧 decision 标记为 `superseded`。
- 已支持 summary anchor 写 `derivedFromSummary` relation。
- 已实现 `LifecycleResolver.resolveFailuresForSucceededAttempt`。
- 已实现 `FixAttemptTracker` 跟踪 mutation -> validation command。
- 已支持成功验证自动 resolve 单一强匹配 failure，歧义时写 pending update。
- 已支持成功验证 resolve failure 后反写 NegExp resolution。
- 已支持失败验证将新 failure 标记为由 fix_attempt causedBy。
- 已支持 pending update list/apply/dismiss debug/admin 工具。
- 已支持 reopen_failure，包含 NegExp recurrence 反向激活。
- 已支持 stale_summary / stale_node。
- 已支持多命令 validation 和 partial fix_attempt outcome。
- 已支持 decision conflict detection 和 conflictsWith relation。
- 已支持 stale maintenance。
- 已支持 lifecycle debug/admin 查询与纠偏工具。
- 已支持 requirement 显式 supersede 写入。
- 已支持 `resolve_node` / `supersede_node` lifecycle admin 动作。
- 已保证状态变化时同步 `status` 字段和 `status:*` tag。

### 下一阶段

文档中原本的下一阶段已落地：

```text
LifecycleResolver:
  reopen_failure / stale_summary / stale_node

FixAttemptTracker:
  partial outcome / multi-command validation
```

### 后续阶段

文档中原本的后续阶段已落地：

```text
decision conflict detection + supersede admin
stale maintenance
lifecycle debug/admin 查询能力
```

后续只剩优化项，不再是必需落地项：

```text
更细粒度的 conflict scoring
更丰富的 stale policy 配置项
基于长期误报数据调优 lifecycle thresholds
task / constraint 的自动提取
task / constraint 的 stale 启发式自动收敛
```

## 13. 总结

```text
decision 关注是否仍然有效。
failure 关注是否仍需提醒。
fix_attempt 关注尝试结果。
summary_anchor 关注是否仍值得作为 DAG 入口。
relation 负责表达替代、修复、冲突和证据链。
```

状态变化时，系统不应重新猜测 mode，而应通过 `nodeId`、`sourceId`、relation edge、attempt span 和 evidence anchor 定位已有 node。能高置信定位才更新；不能定位时宁可保留历史，也不要误改记忆。
