# CodeMemory for Claude Code

> Coding-specialized persistent memory for the Claude Code CLI.
> *中文文档：[README.zh-CN.md](./README.zh-CN.md)*

CodeMemory is a Claude Code plugin that turns the agent's per-session context into durable, searchable engineering memory. It captures the full session JSONL, scores every message into a four-tier importance ladder (S/M/L/N), extracts structured failures from error output, and incrementally compacts long history into a DAG of summaries — all in a local SQLite database. The result is an agent that remembers prior decisions, avoids repeating prior failures, and survives compaction without losing project context.

The plugin is designed around three coding-specific scenarios:

1. **Long sessions** — keep stable requirements visible after sliding-window truncation.
2. **Complex refactors** — preserve the design decisions and rejected alternatives that justify the current code.
3. **Multi-round debugging** — recall prior failures and fix attempts before re-trying broken paths.

> Plugin name (registered with Claude Code): `codememory-plugin`.
> npm package name (runtime): `codememory-for-claude`.

---

## Features

- **DAG-based compaction.** Long history is grouped into leaf summaries and one level of condensed summaries, replacing the lossy sliding-window compaction Claude Code does by default.
- **Filter/Score tiers.** Every message is classified S (skeleton — full text), M (mutation metadata), L (lightweight fact), or N (noise). Compaction only touches M/L; retrieval prioritizes S.
- **Memory nodes.** Structured entries — `task`, `constraint`, `decision`, `failure`, `fix_attempt`, `summary` — with tags, relations, and lifecycle status (`active` / `resolved` / `superseded` / `stale`).
- **Prior-failure lookup on PreToolUse.** Before every Edit / Write / Bash, the daemon checks whether this file, command, or symbol has previously failed. If so, the model receives a short `additionalContext` warning describing the failure, the attempted fix, and the age of the record.
- **Memory-first retrieval on UserPromptSubmit.** Each user prompt triggers a deterministic fast plan that pulls relevant tasks, constraints, decisions, and failures into the prompt. An optional LLM query planner kicks in when the fast plan recalls weakly.
- **Stitched relation chains.** Memory nodes are connected via `relatedTo`, `supersedes`, `resolves`, etc. Retrieval can follow up to two hops to surface the rationale chain, not just isolated nodes.
- **Two-path ingestion.** Hooks capture real-time events; a JSONL watcher tails `~/.claude/projects/<project>/<session>.jsonl` to pick up model responses (which have no hook) and replay prior sessions.
- **Per-session daemon + cold-start fallback.** A background daemon serves a Unix socket for ~50 ms hot-path lookups; a CLI fallback handles cold start in 150–300 ms when the daemon isn't running.
- **Skills-driven decision marking.** Three skills (`codememory-mark-decision`, `codememory-mark-task`, `codememory-mark-constraint`) let the model explicitly persist intent without polluting the chat thread.

---

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Claude Code session                            │
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

For a deeper walk-through see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Installation

### Prerequisites

- Node.js ≥ 18
- `jq` and `curl` on `$PATH` (used by hook scripts)
- Claude Code CLI

### Clone and build

```bash
git clone <repo-url> coding-agent-memory-system
cd coding-agent-memory-system
npm install
npm run build
chmod +x hooks/scripts/*.sh
```

### Link as a Claude Code plugin

```bash
mkdir -p ~/.claude/plugins
ln -sf "$(pwd)" ~/.claude/plugins/codememory
```

Restart Claude Code so the plugin is loaded. On the next `SessionStart`, the daemon will spin up and a system message will confirm `CodeMemory initialized`.

---

## Configuration

All knobs are environment variables; defaults live in `src/db/config.ts`.

| Variable | Default | Description |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | Master kill-switch. |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite file. |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | Expose `codememory_grep` / `codememory_describe` / `codememory_expand` / `codememory_memory_*` to the model. |
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | Whether async compaction runs. |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | Uncompacted M/L tokens that trigger compaction. |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | Most-recent messages always exempt from compaction. |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | Summarizer model. |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | Skip `claude --print`; use truncation fallback (required offline / in tests). |
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | Enable the optional LLM query planner after a weak fast plan. |
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | Run a haiku judge to detect implicit decision supersedes within a conversation. |
| `CODEMEMORY_WORKSPACE_ROOT` | `process.cwd()` | Used to qualify file tags across repos. |

See `src/db/config.ts` for the full list (ignore patterns, expansion model, query planner timeouts, explored-target window, etc.).

---

## Tools and skills

### Default model-callable tools

| Tool | Purpose |
|---|---|
| `codememory_check_prior_failures` | Ask "have I failed on this file / command / symbol before?" before risky edits. |
| `codememory_mark_decision` | Persist a meaningful technical decision as a `decision` memory node. |
| `codememory_mark_requirement` | Persist a hard constraint or stable requirement. |
| `codememory_compact` | Force-compact the current conversation now (also runs automatically on threshold). |

### Debug tools (`CODEMEMORY_DEBUG_TOOLS_ENABLED=true`)

`codememory_grep`, `codememory_describe`, `codememory_expand`, `codememory_expand_query`, `codememory_memory_pending`, `codememory_memory_lifecycle`.

### Skills

`codememory-mark-decision`, `codememory-mark-task`, `codememory-mark-constraint`, `codememory-context-skill`, `codememory-summarization-skill`. Mark skills POST to the running daemon socket via `hooks/scripts/codememory-mark.sh`; the daemon is the single writer of `memory_nodes`.

### Slash commands

`/codememory-status`, `/codememory-grep`, `/codememory-describe`, `/codememory-expand`, `/codememory-expand-query`, `/codememory-watch` — see `commands/`.

---

## How retrieval works

1. **Pivot extraction.** The user prompt is parsed for file paths, bash binaries, and identifiers (`HandleLogin`, `processPayment`, ...).
2. **Fast plan.** A deterministic plan picks intent (`recall_decision_rationale`, `modify_and_avoid_prior_failure`, `continuation`, ...), wanted node kinds, and tag queries.
3. **Memory-first lookup.** Tag-indexed query against `memory_nodes` returns scored candidates.
4. **Relation stitching.** Up to two hops along whitelisted edges (`relatedTo`, `supersedes`, `resolves`) — intent-aware, e.g. "modify and avoid failure" prunes rationale-only branches.
5. **Failure lookup (Path A).** `findFailuresByAnchors` against file/command/symbol pivots; results pass a confidence floor (`MIN_CONFIDENCE = 0.6`) and 30-day half-life decay.
6. **Conversation Path B.** Falls back to keyword search across S-tier messages, with `[DECISION]`-prefixed lines bucketed separately.
7. **Markdown injection.** A single block injected via `additionalContext`. Empty markdown means "skip injection".

When the fast plan returns weakly *and* the prompt looks historical (asks "why", "earlier", etc.), an optional LLM planner extends the plan; failures fall back to the fast plan with a metric flag.

---

## How compaction works

`AsyncCompactor` runs incrementally:

1. M/L messages older than `compactionFreshTailCount` are grouped into batches that exceed `compactionTokenThreshold`.
2. Each batch is sent to `claude --print` (`compactionModel = claude-haiku-4-5-20251001` by default) to produce a leaf summary. A truncation fallback applies when `CODEMEMORY_COMPACTION_DISABLE_LLM=true` or the LLM call fails.
3. When enough leaves with the same parent accumulate (`leafMinFanout`), they condense one level up into a depth-1 summary.
4. High-value summaries (decisions, root-cause language, failure traces) are also written as `memory_nodes` with `kind='summary'` so retrieval can surface them with the rest of the engineering memory.

`codememory_compact` lets the model trigger this on demand. `PreCompact` and `SessionEnd` also flush.

---

## Data model

| Table | Purpose |
|---|---|
| `conversations` | One row per session. |
| `conversation_messages` + `message_parts` | Tier-tagged messages and their typed parts. |
| `summaries` + `summary_parents` | Leaf and condensed nodes of the compaction DAG. |
| `memory_nodes` | Engineering memory: `task`, `constraint`, `decision`, `failure`, `fix_attempt`, `summary`. |
| `memory_tags` | Index columns: `kind`, `file`, `command`, `symbol`, `signature`, `topic`, etc. |
| `memory_relations` | Typed edges between memory nodes (`relatedTo`, `supersedes`, `resolves`, ...). |
| `memory_lifecycle_events` | Status transition log. |
| `memory_pending_updates` | Ambiguous resolves that need human review. |
| `attempt_spans` | Edit/Write → validate-command pairing for fix-attempt tracking. |

Failure nodes replace an earlier standalone `negative_experiences` table — see [`docs/PRIOR_FAILURE_REFERENCE.md`](./docs/PRIOR_FAILURE_REFERENCE.md).

---

## Development

```bash
npm install
npm run build              # tsc → dist/
npm run build:watch
npm test                   # vitest run --dir test
npm run test:watch
npm run benchmark          # build + node benchmark/lookup-latency.ts
npm run benchmark:ci       # CI gate, exit non-zero on p95 > 200ms

# run a single test file
npx vitest run test/failure-lookup.test.ts
# run tests matching a name
npx vitest run -t "stitched chain"
```

The build only compiles `src/`; tests in `test/` import compiled modules via `.js` ESM paths (NodeNext) and Vitest runs TS directly. Hook scripts depend on `jq` and `curl`; the cold-start fallback additionally requires `dist/` to exist.

In offline / CI environments set `CODEMEMORY_COMPACTION_DISABLE_LLM=true` so the compactor doesn't try to spawn `claude --print`.

---

## Reference docs

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — full system design.
- [`docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md`](./docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md) — retrieval pipeline.
- [`docs/MEMORY_NODE_LIFECYCLE.md`](./docs/MEMORY_NODE_LIFECYCLE.md) — node states, transitions, and lifecycle resolver.
- [`docs/MEMORY_RETRIEVAL_REFERENCE.md`](./docs/MEMORY_RETRIEVAL_REFERENCE.md) — memory retrieval engine internals.
- [`docs/PRIOR_FAILURE_REFERENCE.md`](./docs/PRIOR_FAILURE_REFERENCE.md) — failure capture, lookup, and confidence scoring.
- [`docs/TOOL_SURFACE_REFERENCE.md`](./docs/TOOL_SURFACE_REFERENCE.md) — tool / skill / command surface.

## License

MIT.
