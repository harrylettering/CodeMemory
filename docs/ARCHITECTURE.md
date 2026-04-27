# CodeMemory Architecture

> Chinese version: [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)
>
> This document is a guided tour of the CodeMemory system design. It covers ingestion paths, daemon lifecycle, scorer rules, memory-store schema, retrieval flow, compaction DAG, lifecycle resolution, prior-failure handling, and the data flow between them.
>
> Related narrower documents:
> - retrieval details: `MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md`, `MEMORY_RETRIEVAL_REFERENCE.md`
> - node lifecycle: `MEMORY_NODE_LIFECYCLE.md`
> - failure memory: `PRIOR_FAILURE_REFERENCE.md`
> - tool surface: `TOOL_SURFACE_REFERENCE.md`

---

## 1. Design goals

CodeMemory is not a general-purpose RAG system. It is a narrow memory system built specifically for Claude Code coding sessions. The design is always optimized for three scenarios:

1. **Long sessions**: stable requirements and constraints must remain visible after sliding-window truncation.
2. **Complex refactors**: the system should preserve why the current design exists, including rejected alternatives.
3. **Multi-round debugging**: the system should warn before the agent walks into a known failure again.

From those goals come a few system-wide principles:

- **Local-first**: all data lives in `~/.claude/codememory.db`; no remote service is required.
- **Never block the agent**: hook or lookup failures must not block tool execution; a fallback path is required.
- **Single writer for memory**: `memory_nodes` is written by the daemon to avoid concurrent write contention.
- **Multi-source retrieval with graceful degradation**: Memory-first -> Path A failure lookup -> Path B keyword fallback.
- **Prefer less recall over noisy recall**: each layer uses confidence floors and anti-flood rules such as decay, debounce, and explored-target degradation.

---

## 2. High-level components

```text
                ┌──────────────────────────────────────────┐
                │            Claude Code CLI               │
                │ (hooks, tools, skills, slash commands)  │
                └──────────────┬───────────────────────────┘
                               │
              hook scripts (bash)             tool calls (TS)
                               │                 │
                ┌──────────────▼─────────────────▼─────────┐
                │         Per-session daemon (TS)          │
                │                                          │
                │  ┌────────────┐   ┌────────────────────┐ │
                │  │ JSONL      │   │ unix socket server │ │
                │  │ watcher    │   │ /retrieval/onPrompt│ │
                │  │            │   │ /failure/lookup    │ │
                │  └─────┬──────┘   │ /compact           │ │
                │        │          │ /mark/*            │ │
                │  ┌─────▼──────┐   └──────────┬─────────┘ │
                │  │ Scorer     │              │           │
                │  │ (S/M/L/N)  │              │           │
                │  └─────┬──────┘              │           │
                │        │                     │           │
                │  ┌─────▼─────────────────────▼────────┐  │
                │  │ ConversationStore / SummaryStore / │  │
                │  │ MemoryNodeStore / NegExpExtractor /│  │
                │  │ AsyncCompactor / RetrievalEngine   │  │
                │  └──────────────────┬─────────────────┘  │
                │                     │                    │
                └─────────────────────┼────────────────────┘
                                      ▼
                        ~/.claude/codememory.db (SQLite WAL)
```

`src/plugin/index.ts` assembles the stores and engine inside `createCodeMemoryPlugin()`. `src/hooks/daemon.ts` is the runtime host for those components.

---

## 3. Session lifecycle and daemon

CodeMemory aligns the daemon lifecycle tightly to the Claude Code session lifecycle:

```text
SessionStart  -> hooks/scripts/session-start.sh
                 -> nohup node dist/hooks/daemon.js start <sessionId> <cwd>
                    -> writes ~/.claude/codememory-runtime/<sid>.pid / .sock
                    -> starts JSONL watcher and replays unread history

UserPromptSubmit -> hooks/scripts/user-prompt-submit.sh
                    -> curl --unix-socket ... /retrieval/onPrompt
                       -> daemon hot path, injects markdown

PreToolUse     -> hooks/scripts/pre-tool-use.sh
                  -> curl --unix-socket ... /failure/lookup
                     -> daemon hot path
                     -> falls back to dist/failure-lookup-cli.js on failure

PreCompact     -> hooks/scripts/pre-compact.sh
                  -> curl --unix-socket ... /compact

SessionEnd     -> hooks/scripts/session-end.sh
                  -> node dist/hooks/daemon.js stop <sessionId>
                     -> cleans .pid / .sock and flushes compaction
```

Important implications:

- **Per-session, not per-process**: sessions do not contaminate each other.
- **Socket first with CLI fallback**: even if the daemon dies, `PreToolUse` still has a cold-path lookup.
- **Crash residue is expected**: stale `.pid` and `.sock` files may need cleanup; `session-start.sh` tries to probe and clean them.

---

## 4. Two-path ingestion

CodeMemory feeds the same stores through two ingestion paths.

### 4.1 Hook path

`hooks/scripts/*.sh` runs on key Claude Code events such as `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PreCompact`, and `SessionEnd`.

Hook payloads are structured and real-time, but hooks do not cover every event. In particular, model response content is not fully covered by hooks.

### 4.2 JSONL watcher path

`src/hooks/jsonl-watcher.ts` tails `~/.claude/projects/<project>/<sessionId>.jsonl` and parses appended events in order. It captures:

- model responses that hooks do not cover
- historical replay when CodeMemory starts in the middle of a session
- cross-session failure history

Writes from both paths are deduplicated by `messageId` and scored by the same scorer.

---

## 5. Scorer: S/M/L/N tiers

`src/filter/scorer.ts` together with `src/filter/rules-coding.ts` is the gatekeeper for the entire system. Every message passes through the scorer before storage decisions are made.

| Tier | Meaning | Storage | Examples |
|---|---|---|---|
| **S** | skeleton | full text plus parts | user prompts, model decisions, error excerpts, `[DECISION]` lines |
| **M** | mutation metadata | metadata only, no payload | Edit / Write / Bash execution results |
| **L** | lightweight fact | fact fields only | Read / Glob / Grep and other exploration tools |
| **N** | noise | dropped | sidechain or sub-agent internal chatter, repeated exploration |

`ScorerSessionState.exploredTargets` tracks recently explored targets so repeated low-value exploration can decay from L to N instead of flooding storage.

Design implication: changing scorer rules changes the semantics of the whole system. For example, moving `Read` from L to M would affect compaction, retrieval, and prior-failure behavior at once.

---

## 6. Store layer

### 6.1 ConversationStore (`src/store/conversation-store.ts`)

Manages conversations and messages keyed by `conversationId`, `sessionId`, and `sessionKey`. `message_parts` stores typed segments such as text, tool use, and tool result. S-tier messages keep full text; M and L keep metadata only.

### 6.2 SummaryStore (`src/store/summary-store.ts`)

Stores all summary nodes in `summaries` and the DAG edges in `summary_parents`. IDs beginning with `leaf-` represent leaf summaries; `cond-` represents condensed summaries.

### 6.3 MemoryNodeStore (`src/store/memory-store.ts`)

This is the core durable engineering-memory store. It handles:

- writes: `createTask`, `createConstraint`, `createDecision`, `createFailureNode`, `createFixAttempt`, `createSummary`
- indexes through `memory_tags` by kind, file, command, symbol, signature, topic, and similar anchors
- relations through `memory_relations` such as `relatedTo`, `supersedes`, `resolves`, `attemptedFixFor`, `causedBy`, `derivedFromSummary`, `evidenceOf`, and `conflictsWith`
- lifecycle state through `memory_lifecycle_events` and `memory_pending_updates`
- failure lookup through `findFailuresByAnchors`, `resolveFailureNodesByTarget`, and `autoResolveStaleFailureNodes`

`memory_nodes` also contains a UNIQUE `sourceToolUseId` field so mark-skill retries remain idempotent.

### 6.4 NegExpExtractor (`src/negexp/extractor.ts`)

Although the old `negative_experiences` table has been merged away, the extractor module still exists and is reused. It turns raw error text into structured fields such as type, signature, file path, command, symbol, location, and attempted fix. This keeps failure memory cleanly indexed.

---

## 7. Retrieval pipeline

`src/retrieval.ts::RetrievalEngine.retrieveForPrompt` is the entrypoint for every `UserPromptSubmit`. The flow looks like this:

```text
prompt
  -> PivotExtractor: file paths, bash binaries, identifiers
  -> FastPlanner (deterministic)
       intent in { recall_decision_rationale,
                   modify_and_avoid_prior_failure,
                   continuation, generic }
       wantedKinds, tagQueries, hopBudget
  -> optional LLM query planner
       only when fast-plan recall is weak and the prompt looks historical
  -> Memory-first lookup
  -> Relation stitching (<= 2 hops, intent-aware)
  -> Path A failure lookup
       findFailuresByAnchors, confidence >= 0.6, 30-day half-life
  -> Path B keyword fallback
       S-tier conversation search, with [DECISION] lines treated separately
  -> DAG backfill
  -> markdown injection through additionalContext
```

Key design choices:

- **Fast path first, planner second**: avoid model calls on every prompt.
- **Confidence floor plus half-life decay**: do not force weak or stale failure results into the prompt.
- **Intent-aware pruning**: "modify code and avoid failure" does not need every rationale chain.
- **Empty markdown means skip**: retrieval should fail silently rather than blocking the session.

---

## 8. Compaction DAG

`src/compaction/compactor.ts::AsyncCompactor` incrementally builds a summary DAG:

```text
M/L messages older than freshTailCount
  -> grouped by token threshold
  -> each batch summarized by claude --print into a leaf summary
  -> enough sibling leaves condense upward into a depth-1 summary
  -> high-value summaries also written into memory_nodes(kind='summary')
```

Important behaviors:

- **freshTailCount** protects recent messages from compaction
- **incrementalMaxDepth=1** keeps compaction shallow by default
- **LLM fallback exists** when `CODEMEMORY_COMPACTION_DISABLE_LLM=true`
- **summary <-> memory node dual write** lets retrieval surface high-value summaries next to tasks, decisions, and failures

`codememory_compact` can force compaction on demand. `PreCompact` and `SessionEnd` also flush.

---

## 9. Memory node lifecycle

Every memory node participates in a lifecycle:

```text
        active -> resolved
           |         |
           |         | reopen
           v         |
      superseded     |
           \         |
            \        |
             -> stale
```

`LifecycleResolver` is responsible for transitions such as:

- `reopenFailure`: reopen a resolved failure when the same anchor fails again
- `resolveFailuresForSucceededAttempt`: close related failures after a successful validation step
- `markSummaryStale`: mark a summary stale when its source context has drifted
- `autoResolveStaleFailureNodes`: periodically resolve long-dormant failures

`memory_pending_updates` stores ambiguous lifecycle changes such as "I think this failure may be resolved, but I do not have enough confidence to change it automatically."

For details, see `MEMORY_NODE_LIFECYCLE.md`.

---

## 10. Prior-failure pipeline

Prior failure is the clearest end-user value in CodeMemory. The end-to-end path is:

```text
1. Error text appears in JSONL or tool results
2. NegExpExtractor.extractFromErrorMessage
3. signature normalization (signature.ts)
4. MemoryNodeStore.createFailureNode
     - kind='failure'
     - metadata with type/signature/raw/filePath/command/symbol/location/attemptedFix/seq
     - tags for kind/file/command/symbol/signature
     - lifecycle status = active
5. PreToolUse fires
6. lookupForPreToolUse
     - daemon hot path /failure/lookup
     - cold fallback: dist/failure-lookup-cli.js
7. findFailuresByAnchors over file/command/symbol pivots
8. scoreMatch with confidence >= 0.6 and 30-day half-life
9. debounce so the same node is not re-injected within 60 seconds
10. inject additionalContext markdown warning
```

Failure lookup uses both tag indexes and metadata fields, so file, command, symbol, and signature can all participate in matching.

---

## 11. Mark-skill path

`codememory-mark-decision`, `codememory-mark-task`, and `codememory-mark-constraint` are the main way the model intentionally persists engineering intent.

```text
Skill body
  -> hooks/scripts/codememory-mark.sh <endpoint> <json>
     -> discover active daemon socket
     -> curl --unix-socket ... /mark/decision or /mark/requirement
        -> daemon dispatches to mark tool implementation
        -> MemoryNodeStore writes the node (idempotent via sourceToolUseId)
        -> JSONL watcher later records the mark skill tool use as S-tier conversation history
```

Why a socket path instead of direct tool writes?

- keep the daemon as the single writer
- minimize chat-thread noise from skill bodies
- reuse existing hook-side auth and session ID handling

---

## 12. Configuration and observability

Configuration is centralized in `src/db/config.ts::resolveCodeMemoryConfig`, with `CODEMEMORY_*` environment variables for each knob.

Operational visibility comes from:

- `codememory_memory_pending` and `codememory_memory_lifecycle` for pending updates and lifecycle state
- `codememory_describe`, `codememory_grep`, and `codememory_expand` for manual debug inspection
- `/codememory-status` and `/codememory-watch` for daemon and watcher state
- `npm run benchmark:ci` as a p95 latency gate for prior-failure lookup

---

## 13. Failure modes and boundaries

Boundaries:

- **Not a general RAG system**: it does not index source code or repository docs; it only models engineering memory from conversations.
- **Not a replacement for version control**: do not treat CodeMemory like a commit log.
- **Not guaranteed truth**: retrieval results are guidance, not ground truth.
- **Not shared across users**: the database is local per-user SQLite.
- **Offline and CI require `CODEMEMORY_COMPACTION_DISABLE_LLM=true`** if `claude --print` is unavailable.

Common failure modes and how the system responds:

| Scenario | System behavior |
|---|---|
| Daemon crash | hooks fall back to the cold CLI path; session-start restarts next time |
| Repeated identical error | debounce plus confidence decay prevents repeated injection |
| LLM compaction failure | truncation fallback is used; writes are not blocked |
| Stale `.sock` or `.pid` | cleaned by session-start probing |
| No usable anchors extracted | retrieval falls back to keyword search; empty markdown means skip |

---

## 14. Further reading

- more detailed retrieval chain: `MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md`, `MEMORY_RETRIEVAL_REFERENCE.md`
- node state machine and lifecycle resolver: `MEMORY_NODE_LIFECYCLE.md`
- failure-memory fields, APIs, and `PreToolUse` flow: `PRIOR_FAILURE_REFERENCE.md`
- exposed tools, skills, and commands: `TOOL_SURFACE_REFERENCE.md`
- project-level usage guides: root `README.md` and `README.zh-CN.md`
