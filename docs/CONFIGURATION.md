# CodeMemory Configuration Reference

> Chinese version: [CONFIGURATION.zh-CN.md](./CONFIGURATION.zh-CN.md)

All configuration is read from environment variables prefixed with `CODEMEMORY_`. Defaults are resolved in [`src/db/config.ts`](../src/db/config.ts) by `resolveCodeMemoryConfig`. The README's Configuration section lists only the highest-traffic knobs; this document is the full surface.

Each model env var is independent. If unset, `CODEMEMORY_EXPANSION_MODEL`, `CODEMEMORY_QUERY_PLANNER_MODEL`, `CODEMEMORY_COMPACTION_MODEL`, and `CODEMEMORY_AUTO_SUPERSEDE_MODEL` each default to `claude-haiku-4-5-20251001`.

> Anything previously documented but not listed here was removed in cleanup as dead-letter (declared in config but never consumed). If you have one of those set in your shell, it is now a no-op and can be removed.

## Core switches

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | Master on/off switch. Set `false` to disable the plugin without uninstalling it. |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | Exposes `codememory_grep`, `codememory_describe`, `codememory_expand`, `codememory_expand_query`, `codememory_memory_pending`, `codememory_memory_lifecycle` to the model. Off by default to keep the tool surface small. |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite file location. |
| `CODEMEMORY_WORKSPACE_ROOT` | daemon's `process.cwd()` at start | Used to qualify file tag values across repos so `/abs/foo.ts` and `./foo.ts` collide on the same memory anchor. Note: this is the **daemon's** cwd at `SessionStart`, not your shell's cwd at the moment of an action. |

## Compaction

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | Master switch for async compaction. |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | Uncompacted M/L-tier token sum that triggers a compaction sweep. |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | Most-recent uncompacted messages preserved verbatim — compaction only ever touches messages older than these. |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | Skip `claude --print` and use truncation fallback. Required in offline / CI runs. |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | Model used for compaction. |
| `CODEMEMORY_COMPACTION_MAX_INPUT_CHARS` | `24000` | Per-batch character cap fed to `claude --print` (≈ 6k tokens). Acts as both an LLM budget and the upper bound for `leafChunkTokens` in practice. |

## Summary DAG shape

These knobs control the leaf → condensed structure built by `AsyncCompactor`. Most users never need to touch them.

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_LEAF_CHUNK_TOKENS` | `20000` (capped by `compactionMaxInputChars / 4`) | Max source tokens per leaf summary batch. |
| `CODEMEMORY_LEAF_TARGET_TOKENS` | `1200` | Target output size for a leaf summary. |
| `CODEMEMORY_CONDENSED_TARGET_TOKENS` | `2000` | Target output size for a depth-1 condensed summary. |
| `CODEMEMORY_CONDENSED_MIN_FANOUT` | `4` | Minimum sibling leaves required before a condensed summary is produced. |
| `CODEMEMORY_INCREMENTAL_MAX_DEPTH` | `1` | Number of incremental depth passes to run after each leaf compaction. The DAG stays shallow at depth 1 by default. |
| `CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR` | `3` | Hard ceiling for output size relative to target tokens. Summaries exceeding `target × factor` are rejected and re-truncated. |

## Retrieval / context assembly

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | Enable the optional LLM query planner that runs only when the deterministic fast plan recall is weak. Adds an extra `claude --print` call on those prompts. |
| `CODEMEMORY_QUERY_PLANNER_MODEL` | `claude-haiku-4-5-20251001` | Model used by the planner. |
| `CODEMEMORY_QUERY_PLANNER_TIMEOUT_MS` | `1200` | Hard timeout for the planner subprocess. The planner kills itself rather than block prompt-time injection. |
| `CODEMEMORY_QUERY_PLANNER_MAX_TOKENS` | `800` | Token cap declared in the planner config interface (currently used by the planner contract / tests; not yet passed as a CLI flag). |
| `CODEMEMORY_EXPLORED_TARGET_WINDOW_MS` | `1800000` (30 min) | Repeat exploration of the same Read/Grep/Glob target inside this window decays L → N. Past the window the file may have changed, so re-reads are signal again. |
| `CODEMEMORY_MAX_ASSEMBLY_TOKEN_BUDGET` | `0` (= use built-in default) | Override the context-assembly token cap used by `codememory_expand_query`. |

## Sub-agent expansion

Used by `codememory_expand` and `codememory_expand_query`.

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_EXPANSION_MODEL` | `claude-haiku-4-5-20251001` | Model for the expansion sub-agent. |
| `CODEMEMORY_EXPANSION_PROVIDER` | `anthropic` | Provider for the expansion sub-agent. |
| `CODEMEMORY_MAX_EXPAND_TOKENS` | `4000` | Token cap for `codememory_expand`. |
| `CODEMEMORY_DELEGATION_TIMEOUT_MS` | `120000` | Timeout for the delegated expansion query subprocess. |

## Auto-supersede (decisions)

When enabled, a single haiku call detects whether a newly marked decision implicitly retires an older active decision in the **same conversation**. Cross-session is never auto-handled — that's a deliberate design choice, since one project's context cannot reliably override another's.

| Variable | Default | Effect |
|---|---|---|
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | Master switch for the LLM-as-judge auto-supersede path. |
| `CODEMEMORY_AUTO_SUPERSEDE_MODEL` | `claude-haiku-4-5-20251001` | Judge model. |
| `CODEMEMORY_AUTO_SUPERSEDE_MAX_CANDIDATES` | `20` | Max active decisions the judge considers per call. |
| `CODEMEMORY_AUTO_SUPERSEDE_TIMEOUT_MS` | `8000` | Hard timeout for the judge call. |

## Removed in cleanup (no longer recognized)

The following variables were declared historically but had no consumer in the runtime. They were removed to avoid the misleading impression of being tunable. If your environment still sets any of these, it is safe to remove:

`CODEMEMORY_CONTEXT_THRESHOLD`, `CODEMEMORY_FRESH_TAIL_COUNT` (the compactor uses `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` instead), `CODEMEMORY_LEAF_MIN_FANOUT`, `CODEMEMORY_CONDENSED_MIN_FANOUT_HARD`, `CODEMEMORY_MAX_ROUNDS`, `CODEMEMORY_TIMEZONE`, `CODEMEMORY_PRUNE_HEARTBEAT_OK`, `CODEMEMORY_CIRCUIT_BREAKER_COOLDOWN_MS`, `CODEMEMORY_CIRCUIT_BREAKER_THRESHOLD`, `CODEMEMORY_MAX_EXPAND_QUERY_TOKENS`, `CODEMEMORY_SUMMARY_MODEL`, `CODEMEMORY_SUMMARY_PROVIDER`, `CODEMEMORY_FILES_PATH`, `CODEMEMORY_IGNORE_SESSION_PATTERNS`, `CODEMEMORY_STATELESS_SESSION_PATTERNS`, `CODEMEMORY_SKIP_STATELESS_SESSIONS`.
