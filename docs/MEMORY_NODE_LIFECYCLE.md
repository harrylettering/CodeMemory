# Memory Node Lifecycle and Status Update Design

> Chinese version: [MEMORY_NODE_LIFECYCLE.zh-CN.md](./MEMORY_NODE_LIFECYCLE.zh-CN.md)
>
> Status note (updated 2026-04): the Chinese document preserves more of the historical transition from the old `negative_experiences` table to unified `memory_nodes(kind='failure')`. That transition layer has now been removed. The current entrypoints are `MemoryNodeStore.createFailureNode`, `findFailuresByAnchors`, `resolveFailureNodesByTarget`, and `LifecycleResolver.reopenFailure`. See [PRIOR_FAILURE_REFERENCE.md](./PRIOR_FAILURE_REFERENCE.md) for the active failure model.

## 1. Positioning

Memory Nodes are reusable engineering-memory objects compiled from historical sessions. They are not raw logs and not a complete wiki. They are the stable objects that retrieval should recall first during prompt assembly.

This document defines the role, creation timing, state transitions, and update rules for:

- `task`
- `constraint`
- `decision`
- `failure`
- `fix_attempt`
- `summary` / `summary_anchor`
- `relation`

Current implementation highlights:

```text
implemented:
  explicit task / constraint memory writes
  prompt retrieval with controlled two-hop relation stitch
  intent-aware relation whitelist and chain templates
  memory_nodes / memory_tags
  memory_relations
  memory_lifecycle_events
  memory_pending_updates
  attempt_spans
  failure resolved -> lifecycle event
  explicit decision supersede -> relation + lifecycle event
  summary_anchor -> derivedFromSummary relation
  LifecycleResolver strong and weak targeting
  succeeded fix_attempt -> resolve failure or write pending_update
  mutation -> validation command -> fix_attempt tracking
  reopen_failure / stale_summary / stale_node
  multi-command validation and partial fix_attempt outcome
  decision conflict detection + conflictsWith relation
  stale maintenance
  lifecycle debug and admin tools
  explicit task / constraint supersede
  task / constraint lifecycle resolve and supersede admin
```

Core principle:

```text
Raw Messages and the Summary DAG are the evidence layer.
Memory Nodes are the recall layer.
Memory Tags are the index layer.
Relations and Lifecycle Events express state changes and evidence chains.
```

The original contents and evidence of a memory node should remain as immutable as practical. Later changes should mostly be expressed through `status`, `metadata.lifecycle`, tags, and relation edges.

## 2. Shared fields and states

`memory_nodes` currently includes:

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

Current concrete `status` values:

```text
active
resolved
superseded
stale
```

Logical states that may still expand later:

```text
candidate
pending_update
```

`candidate` means low-confidence memory that should not be injected by default. `pending_update` means the system thinks a lifecycle change may be needed, but it cannot confidently identify the correct target node yet.

The current `memory_pending_updates` implementation is used when `LifecycleResolver` sees a likely state change, such as a successful validation that could resolve multiple active failures, but cannot safely choose one.

Shared state machine:

```text
candidate -> active
active -> resolved
active -> superseded
active -> stale
resolved -> stale
resolved -> active        // reopen, failure only
superseded -> stale
```

Any update must keep the following in sync:

```text
memory_nodes.status
memory_tags status:*
memory_nodes.updatedAt
metadata.lifecycle / metadata.outcome
memory_lifecycle_events
```

Default retrieval behavior:

```text
inject by default:
  active task
  active constraint
  active decision
  active failure
  strongly relevant resolved failure
  active summary_anchor
  fix_attempt with a clear outcome

exclude by default:
  stale
  superseded
  candidate
  pending_update
```

## 3. Update principles

### 3.1 Do not overwrite historical facts

When an old decision is replaced, do not rewrite the old node into the new decision. Create a new node and mark the old node as `superseded`.

When a failure is fixed, do not delete the failure node. Mark it as `resolved` and record the resolution.

When a summary anchor loses value, do not delete the summary. Mark the anchor node as `stale` or `superseded`.

### 3.2 Prefer strong evidence

Target resolution for lifecycle updates should follow this order:

```text
1. direct nodeId
2. source + sourceId
3. explicit relation edge
4. attempt span / task span
5. exact signature + file + command
6. recent target in current conversation
7. semantic tag/query score
8. no update
```

The first four are strong anchors and are suitable for automatic updates. The latter four are weak anchors and should only update automatically when confidence is high and the margin over other candidates is clear.

Suggested thresholds:

```text
confidence >= 0.85  auto update
0.60 - 0.85         write pending_update
confidence < 0.60   no update
close candidates    no update
```

The current `LifecycleResolver` follows this rule:

```text
single strong active-failure match:
  auto active -> resolved

multiple close active failures:
  write memory_pending_updates
  do not change memory_nodes
```

### 3.3 Prefer relations over after-the-fact guessing

The more accurate system is not one that re-searches the whole graph every time state changes. It is one that writes future anchors at node creation time:

```text
failure      -> sourceId = negexpId
decision     -> sourceId = messageId or decisionId
fix_attempt  -> sourceId = attemptId
summary      -> summaryId = leaf-* or cond-*
relation     -> fromNodeId + toNodeId + relationType
```

This makes later updates resolvable through explicit source or relation anchors instead of loose guessing.

### 3.4 Tasks and constraints are current-state anchors

`task` and `constraint` are not the same thing as `decision`:

- `task` answers what we are trying to accomplish right now
- `constraint` answers what must not regress and which boundaries must hold
- `decision` answers why a given implementation path was chosen

For long coding sessions, `task` and `constraint` are the most direct continuity anchors, so they should be part of the default retrieval path.

Recommended creation paths:

```text
codememory_mark_requirement(kind=task)
codememory_mark_requirement(kind=constraint)
codememory_mark_requirement(..., supersedesNodeId=oldNodeId)
high-confidence task/constraint extractor (future stage)
```

Recommended state changes:

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

Tasks and constraints should not be removed merely because time passes. They should only change when the goal is finished, the requirement is replaced, or the node has clearly lost context value.

Current explicit update paths:

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
  -> task / constraint / decision use the same explicit supersede path
```

## 4. Decision mode

### 4.1 Definition

`decision` represents an engineering constraint, implementation choice, or design tradeoff that should continue to hold in the future.

Typical examples:

```text
Use X, not Y.
This module should always go through Z from now on.
Stop using legacy approach A.
Keep C to remain compatible with B.
```

A casual suggestion is not automatically a decision. "We could consider using zod" is a candidate at best, not an active decision.

### 4.2 Creation timing

High-confidence entrypoints:

```text
explicit codememory_mark_decision call
user explicitly says "we decided", "use", "do not use", "from now on"
assistant explicitly records a decision or rationale
```

Creation rule:

```text
kind = decision
status = active
confidence = 1.0 for explicit tool writes, 0.7-0.9 for rule-based recognition
source = codememory_mark_decision / message_classifier
sourceId = messageId / decisionId
tags = kind:decision + status:active + file/topic/symbol/package
```

### 4.3 State transitions

```text
candidate -> active
active -> superseded
active -> stale
superseded -> stale
```

Decisions should not expire just because time passes. They should change only when:

- a new decision explicitly replaces the old one
- the user explicitly abandons the old decision
- the related file or module no longer exists and the decision is no longer applicable
- maintenance detects conflicting active decisions on the same topic or file and the conflict is confirmed

### 4.4 Update path

When a new decision replaces an old one:

```text
new decision:
  status = active
  relation: supersedes -> old decision
  metadata.lifecycle.supersedesReason = ...
  supersedesNodeId = oldNodeId

old decision:
  status = superseded
  status tag changes from active to superseded
  lifecycle event active -> superseded
  metadata.lifecycle.supersededAt = ...
  metadata.lifecycle.supersededBy = newNodeId
```

Current strong-anchor path:

```text
codememory_mark_decision(..., supersedesNodeId=oldNodeId)
  -> create new active decision node
  -> relation(newDecision, oldDecision, supersedes)
  -> oldDecision.status = superseded
  -> oldDecision status tag = status:superseded
  -> lifecycle event supersede_decision
```

Default prompt retrieval only injects active decisions. Superseded decisions are shown only when the user asks about historical evolution.

## 5. Failure mode

### 5.1 Definition

`failure` represents a previous error or failed path that should be avoided in the future.

Typical examples:

```text
a test failure after changing a file
a command that failed with a known error
a symbol or API that caused a runtime error
a "fix" that introduced a regression
```

### 5.2 Creation timing

High-confidence entrypoints:

```text
tool result exit_code != 0
test failure
TypeScript, lint, or runtime error
stack trace
NegExp extractor hit
```

Creation rule:

```text
kind = failure
status = active
source = negative_experience
sourceId = negexpId
evidence = negexpId / messageId
tags = kind:failure + status:active + file/command/symbol/signature/topic
```

A stable `failure-negexp-${id}` anchor is useful because later resolve and reopen logic can target it directly.

### 5.3 State transitions

```text
active -> resolved
resolved -> active      // reopen on recurrence
active -> stale
resolved -> stale
```

Triggers for `active -> resolved`:

```text
automatic stale resolution
user says "fixed" or "works now"
follow-up tests pass
fix_attempt outcome=succeeded
```

Triggers for `resolved -> active`:

```text
the same signature / file / command / symbol fails again
```

Triggers for `resolved -> stale`:

```text
no recurrence for a long time
related file or module removed
very low useCount
covered by more precise failure / decision / fix_attempt memory
```

### 5.4 Update path

Most accurate path:

```text
negative_experience.id -> failure-negexp-${id}
```

Example:

```text
negative_experience 42 resolved
  -> memory node failure-negexp-42 status = resolved
  -> status tag becomes status:resolved
  -> metadata.resolution = ...
  -> lifecycle event resolve_failure
```

Current implemented behavior:

```text
fix_attempt succeeded
  -> LifecycleResolver resolves a single strong failure
  -> failure Memory Node status = resolved
  -> if failure.metadata.negexpId exists:
       negative_experiences.resolved = 1
       negative_experiences.resolution = resolution reason
```

Without a direct NegExp ID, weak resolution falls back to anchors such as:

```text
kind=failure
status=active
same file / command / symbol / signature
prefer current conversation
prefer more recent updatedAt
```

Weak targeting must be high-confidence to auto-update; otherwise write a pending update or do nothing.

## 6. Fix-attempt mode

### 6.1 Definition

`fix_attempt` captures a repair attempt and its outcome. It exists to tell the future model:

```text
this fix path was tried and failed, do not repeat it
this fix path was tried and succeeded, prefer it
this fix path only partly worked, watch the boundary conditions
```

`fix_attempt` is usually generated from a sequence of events, not a single message:

```text
failure appears
  -> Edit / Write / Patch changes files
  -> validation command or test runs
  -> success / failure / partial / unknown
```

### 6.2 Creation timing

High-value entrypoints:

```text
an edit or patch occurs after a failure
user or assistant explicitly says they are attempting a fix
a validation command runs after the change
the fix attempt produces a new failure
```

Recommended attempt-span fields:

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

Current implementation already has `attempt_spans` and `FixAttemptTracker`:

```text
Edit / Write / MultiEdit / NotebookEdit
  -> open active attempt span
  -> create/update fix_attempt node with outcome=unknown

Bash validation command tool_result
  -> close or update attempt span
  -> outcome=succeeded / failed / partial
  -> update fix_attempt node
```

Recognized validation commands currently include:

```text
test / vitest / jest / pytest
tsc / typecheck
eslint / lint
build
cargo test / go test
```

Creation rule:

```text
kind = fix_attempt
status = active
source = fix_attempt_tracker
sourceId = attemptId
metadata.outcome = unknown | failed | succeeded | partial
tags = kind:fix_attempt + status:active + file/command/topic
relation = attemptedFixFor -> failure
```

### 6.3 State transitions

```text
candidate -> active
active -> resolved
active -> superseded
active -> stale
```

Outcome values:

```text
unknown
failed
succeeded
partial
```

Relationship between status and outcome:

```text
tests pass / user confirms:
  status = resolved
  outcome = succeeded

tests fail:
  status = active
  outcome = failed

only part of the issue is fixed:
  status = active
  outcome = partial

later replaced by a better fix path:
  status = superseded
```

### 6.4 Update path

Best-case targeting:

```text
attemptId -> fix_attempt node
```

Without an attempt ID, the system can use a short event window:

```text
recent active failure
same touchedFiles
edit/patch sequence range
following validation result
```

Example:

```text
Edit src/auth/login.ts
npm test passed
  -> recent fix_attempt outcome=succeeded
  -> relation resolves -> failure
  -> related failure status=resolved
```

Current behavior:

```text
if success validation has exactly one strong active-failure match:
  relation(fix_attempt, failure, resolves)
  failure.status = resolved
  lifecycle event resolve_failure_after_fix_attempt

if there are multiple similar active failures:
  write memory_pending_updates.transition = resolve_failure
  leave memory_nodes unchanged
```

Failed validation flow:

```text
Edit src/auth/login.ts
npm test failed
  -> recent fix_attempt outcome=failed
  -> failure remains active
  -> relation causedBy / attemptedFixFor
```

Current implementation links the new failure to the fix attempt:

```text
relation(failure, fix_attempt, causedBy)
fix_attempt.status = active
fix_attempt.metadata.outcome = failed
```

Multi-command validation is also supported:

```text
Edit src/auth/login.ts
npm test passed
npm run build failed
  -> same attempt continues collecting validationResults
  -> fix_attempt.outcome = partial
  -> fix_attempt.status = active
  -> if the first success already resolved a failure, reopen it
```

## 7. Summary / summary-anchor mode

### 7.1 Definition

In the current implementation, a summary anchor is stored as `kind = summary`, with anchor semantics expressed through tags and metadata:

```text
kind = summary
metadata.anchorType = summary_anchor
tag kind:summary_anchor
```

`summary_anchor` marks a useful entrypoint into the DAG. It does not replace decisions, failures, or fix attempts. It only helps retrieval reach the most valuable summary nodes.

### 7.2 Creation timing

Entry source:

```text
compaction generates a leaf or condensed summary
```

Only high-value summaries should become summary anchors. Signals include wording about:

```text
decisions / chosen path / rejected path
root cause / fixed / failed
```

Creation rule:

```text
kind = summary
status = active
source = summary_dag
sourceId = summaryId
summaryId = leaf-* / cond-*
metadata.anchorType = summary_anchor
tags = kind:summary_anchor + status:active + file/topic/symbol/command
```

Current implementation:

```text
memoryStore.createSummaryNode(summary)
  -> nodeId = summary-${summaryId}
  -> kind = summary
  -> metadata.anchorType = summary_anchor
  -> relation(summary-${summaryId}, summaryId, derivedFromSummary)
```

### 7.3 State transitions

```text
active -> stale
active -> superseded
superseded -> stale
```

Triggers for stale:

```text
summary quality is too generic
recalled repeatedly but not useful
covered by a more precise decision / failure / fix_attempt
the underlying DAG evidence has drifted
```

Triggers for superseded:

```text
a higher-level condensed summary replaces the old one
a newer summary anchor represents the same topic more accurately
```

### 7.4 Update path

Most accurate path:

```text
summaryId -> summary-${summaryId}
```

Example:

```text
summary leaf-1 is replaced by cond-1
  -> summary-leaf-1 status = superseded
  -> relation supersededBy -> summary-cond-1
```

Default retrieval may recall active summary anchors and expand one layer of DAG evidence if the token budget allows. It does not expand raw messages by default.

## 8. Relation mode

### 8.1 Definition

`relation` should not behave like a normal content node. It is better represented as edges between nodes so the system can express replacement, repair, conflict, and evidence chains.

Current table:

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

Common relation types:

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

Current store interface:

```ts
addRelation(input)
getRelationsForNode(nodeId, direction)
supersedeDecision(input)
```

### 8.2 Creation timing

```text
new decision replaces old decision
fix_attempt resolves failure
fix_attempt causes failure
summary_anchor comes from a summary
two active decisions may conflict
failure and summary_anchor describe the same root cause
```

### 8.3 Update path

The key to a safe relation update is identifying both ends:

```text
fromNodeId
toNodeId
relationType
confidence
evidence
```

Examples:

```text
new decision supersedes old decision
  -> relation(newDecision, oldDecision, supersedes)
  -> oldDecision.status = superseded

fix_attempt succeeded
  -> relation(fixAttempt, failure, resolves)
  -> failure.status = resolved

fix_attempt failed
  -> relation(failure, fixAttempt, causedBy)
  -> fixAttempt.metadata.outcome = failed

summary_anchor created
  -> relation(summaryNode, summaryId, derivedFromSummary)
```

Decision supersede prefers explicit caller input:

```text
new decision with supersedesNodeId
  -> supersedeDecision(oldNodeId, newNodeId)
  -> oldDecision.status = superseded

codememory_memory_lifecycle action=supersede_decision
  -> explicit oldNodeId/newNodeId
  -> call supersedeDecision
```

When `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM=true` and the caller does not provide `supersedesNodeId`, the daemon can use a lightweight judge within the same conversation only. Cross-session or cross-conversation auto-supersede is intentionally not supported because the false-positive risk is too asymmetric.

## 9. Lifecycle event log

To avoid silent incorrect updates, the system uses an append-only lifecycle log:

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

Current store interface:

```ts
addLifecycleEvent(input)
getLifecycleEvents(nodeId)
updateNodeStatus(input)
```

Every state change writes an event:

```text
failure active -> resolved
decision active -> superseded
summary active -> stale
fix_attempt active -> resolved
```

Benefits:

- auditable history
- possible rollback support
- analysis of misfiring rules
- training and tuning material for lifecycle resolution

## 10. Lifecycle resolver

`LifecycleResolver` centralizes target resolution for lifecycle updates. The first major implementation focus was:

```text
succeeded fix_attempt -> resolve active failure
```

Core shape:

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

Flow:

```text
event
  -> identify transition type
  -> resolve target node by strong anchors
  -> if strong target found: apply status update
  -> if weak target: write pending_update
  -> if ambiguous: do nothing
  -> write lifecycle event
```

Strong targeting rules:

```text
failure:
  negexpId -> failure-negexp-${id}

decision:
  explicit new decision + old nodeId
  or same file/topic with explicit supersede wording

fix_attempt:
  attemptId -> fix_attempt node

summary_anchor:
  summaryId -> summary-${summaryId}

relation:
  fromNodeId + toNodeId + relationType
```

Weak targeting rules:

```text
same file / command / symbol / signature
same current conversation
recent updatedAt
high tag overlap
high content/queryVariant match
```

Weak targeting only auto-updates when the top score clearly beats the runner-up.

Current implemented resolver flows:

```text
resolveFailuresForSucceededAttempt(...)
  -> findActiveFailuresByAnchors(files, commands)
  -> single strong match: updateNodeStatus(resolved) + relation resolves
  -> multi-candidate or weak match: addPendingUpdate(...)

reopenFailure(...)
  -> find resolved/stale failures on recurrence
  -> single strong match: active + lifecycle reopen_failure
  -> multi-candidate or weak match: pending_update(reopen_failure)

markSummaryStale(...) / markNodeStale(...)
  -> direct nodeId
  -> updateNodeStatus(stale)
  -> lifecycle event stale_summary / stale_node
```

## 10.1 Pending update

`pending_update` is a buffer for low-confidence lifecycle changes. It does not change `memory_nodes`; it stores candidates and reasons only.

Current table:

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

Current store interface:

```ts
addPendingUpdate(input)
getPendingUpdate(pendingId)
getPendingUpdates(status)
applyPendingUpdate({ pendingId, targetNodeId?, reason? })
dismissPendingUpdate({ pendingId, reason? })
```

Typical write scenario:

```text
fix_attempt succeeded
  -> multiple active failures match the same file/command
  -> write pending resolve_failure
  -> do not auto-update any failure
```

Current debug/admin tool:

```text
codememory_memory_pending
  action=list     -> list pending/applied/dismissed updates
  action=apply    -> apply to targetNodeId or the single remaining candidate
  action=dismiss  -> dismiss the pending update
```

This tool is only exposed when `CODEMEMORY_DEBUG_TOOLS_ENABLED=true`.

Validation before applying a pending update:

```text
pending.status must be pending
target node must exist
if fromStatus exists, target node must still match it
multi-candidate pending updates require explicit targetNodeId
```

Successful apply writes:

```text
memory_nodes.status
memory_tags status:*
memory_lifecycle_events
memory_pending_updates.status = applied
```

Dismissal writes:

```text
memory_pending_updates.status = dismissed
metadata.dismissedReason / dismissedAt
memory_nodes unchanged
```

## 11. Recall and injection impact

Lifecycle state directly affects prompt retrieval:

```text
active failure:
  strong warning, high injection priority

resolved failure:
  down-weighted, but may still be shown on strong matches with the resolution path

active decision:
  injected as current engineering constraint

superseded decision:
  hidden by default unless the user asks for historical evolution

fix_attempt outcome=failed:
  high value, reminds the model not to repeat the same fix

fix_attempt outcome=succeeded:
  can be surfaced as a recommended path or resolution evidence

summary_anchor active:
  injected as a DAG entrypoint with lightweight evidence expansion

stale:
  excluded by default
```

## 11.1 Stale maintenance

`memoryStore.runStaleMaintenance(...)` moves low-value old nodes out of the default recall surface.

Default rules:

```text
active summary:
  long-unused -> stale_summary

resolved failure:
  long time without recurrence and low usage -> stale_node

resolved fix_attempt:
  long-unused -> stale_node

superseded node:
  after a retention period -> stale_node

active decision:
  does not become stale automatically just because time passes
```

Execution paths:

```text
daemon:
  run lightweight stale maintenance at most once per hour

codememory_memory_lifecycle:
  action=stale_maintenance
```

## 11.2 Lifecycle debug/admin

`codememory_memory_lifecycle` is exposed only when `CODEMEMORY_DEBUG_TOOLS_ENABLED=true`.

Supported actions:

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

Division of labor:

```text
codememory_memory_pending:
  manage low-confidence pending updates

codememory_memory_lifecycle:
  manage lifecycle inspection, correction, and explicit state changes for already-targeted nodes
```

## 12. Staged rollout guidance

### Current stage

- keep `memory_nodes` and `memory_tags`
- `memory_relations` and `memory_lifecycle_events` already exist
- `memory_pending_updates` already exists
- `attempt_spans` already exists
- explicit decision supersede works
- summary anchors write `derivedFromSummary`
- `LifecycleResolver.resolveFailuresForSucceededAttempt` exists
- `FixAttemptTracker` links mutation to validation commands
- single strong-match resolution is automatic; ambiguous cases write pending updates
- failure recurrence can reopen failures
- stale maintenance exists
- lifecycle debug and admin tools exist
- explicit supersede for requirements exists
- lifecycle admin actions such as `resolve_node` and `supersede_node` exist
- status field and `status:*` tags are kept in sync

### Next stage

Items that were originally "next stage" are already implemented:

```text
LifecycleResolver:
  reopen_failure / stale_summary / stale_node

FixAttemptTracker:
  partial outcome / multi-command validation
```

### Later stage

Items that were originally "later stage" are also already implemented:

```text
decision conflict detection + supersede admin
stale maintenance
lifecycle debug/admin inspection
```

Remaining work is now optimization work, not mandatory functionality:

```text
finer-grained conflict scoring
richer stale-policy configuration
lifecycle-threshold tuning from long-term false-positive data
automatic extraction for task / constraint
automatic stale heuristics for task / constraint
```

## 13. Summary

```text
decision cares about whether it is still valid.
failure cares about whether it still needs to warn.
fix_attempt cares about the outcome of the attempted repair.
summary_anchor cares about whether it is still worth using as a DAG entrypoint.
relation expresses replacement, repair, conflict, and evidence chains.
```

When state changes, the system should not guess node mode from scratch. It should locate existing nodes through `nodeId`, `sourceId`, relation edges, attempt spans, and evidence anchors. Only high-confidence targeting should mutate lifecycle state. If the system is unsure, it should preserve history rather than rewrite memory incorrectly.
