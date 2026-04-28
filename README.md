# CodeMemory for Claude Code

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](#prerequisites)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)](#development)
[![SQLite](https://img.shields.io/badge/SQLite-local--first-003B57?logo=sqlite&logoColor=white)](#architecture)

> Coding-specialized persistent memory for the Claude Code CLI.  
> 中文文档: [README.zh-CN.md](./README.zh-CN.md)

CodeMemory is a local-first Claude Code plugin that turns per-session context into durable engineering memory. It stores conversations, summaries, decisions, constraints, failures, and fix attempts in SQLite, then injects the right context back into prompts and risky tool calls.

CodeMemory is intentionally narrow: it is not a general-purpose RAG layer. It is optimized for long Claude Code sessions, complex refactors, and multi-round debugging loops where remembering prior intent matters more than broad document search.

> Registered Claude Code plugin name: `codememory-plugin`  
> Runtime npm package name: `codememory-for-claude`

## Contents

- [Why CodeMemory](#why-codememory)
- [Quick Start](#quick-start)
- [Default Workflow](#default-workflow)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Configuration](#configuration)
- [Tools, Skills, and Commands](#tools-skills-and-commands)
- [Technical Overview](#technical-overview)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Reference Docs](#reference-docs)
- [License](#license)

## Why CodeMemory

CodeMemory is built for three recurring pain points in coding sessions:

1. **Long sessions**: keep stable requirements and constraints visible after context-window truncation.
2. **Complex refactors**: preserve design rationale, rejected alternatives, and why the current approach won.
3. **Multi-round debugging**: recall prior failures and fix attempts before repeating a broken path.

## Highlights

- **Local-first memory**: everything lives in `~/.claude/codememory.db`; no external service is required.
- **Prompt-time retrieval**: every user prompt can pull relevant tasks, constraints, decisions, and failures into `additionalContext`.
- **Prior-failure alerts**: before `Edit`, `Write`, or `Bash`, CodeMemory checks whether the target has failed before.
- **DAG-based compaction**: long history is compacted into leaf and condensed summaries instead of being discarded.
- **Structured memory nodes**: `task`, `constraint`, `decision`, `failure`, `fix_attempt`, and `summary` nodes with tags, relations, and lifecycle status.
- **Fast runtime path**: a per-session daemon serves hot lookups over a Unix socket, with a CLI cold-start fallback where needed.
- **Debuggable surface area**: hooks, tools, slash commands, and docs all map cleanly onto the same runtime model.

## Quick Start

### Prerequisites

- Node.js 18 or newer
- Claude Code CLI
- `jq` and `curl` available on `PATH`

### Install

```bash
git clone https://github.com/harrylettering/CodeMemory.git
cd CodeMemory
npm install
npm run build
chmod +x hooks/scripts/*.sh
```

### Link it as a Claude Code plugin

```bash
mkdir -p ~/.claude/plugins
ln -sf "$(pwd)" ~/.claude/plugins/codememory
```

The repository already contains `.claude-plugin/plugin.json` and `hooks/hooks.json`, so linking the repository root is enough.

Restart Claude Code. On the next `SessionStart`, CodeMemory will initialize the SQLite database, start its per-session daemon, and begin watching the session transcript.

## Default Workflow

Once installed, CodeMemory runs mostly on its own:

1. `SessionStart` initializes the database and starts a per-session daemon.
2. The daemon tails the session JSONL so it can ingest model responses as well as hook events.
3. Every `UserPromptSubmit` can trigger memory-first retrieval and inject relevant context into the prompt.
4. Every `PreToolUse` checks for prior failures related to the file, command, or symbol being touched.
5. As history grows, M/L-tier messages are compacted into a summary DAG and promoted into reusable memory nodes.

## Architecture

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

For the full design walk-through, start with [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Repository Layout

| Path | Purpose |
|---|---|
| `src/` | Core runtime: retrieval, compaction, stores, hooks runtime, and plugin activation. |
| `hooks/` | Claude Code hook definitions and shell entrypoints. |
| `commands/` | Slash-command descriptions such as `/codememory-status` and `/codememory-watch`. |
| `skills/` | Skills for marking decisions, tasks, and constraints from the model side. |
| `docs/` | Deeper architecture and subsystem references. |
| `test/` | Automated tests for retrieval, lifecycle, failure lookup, compaction, and tools. |
| `benchmark/` | Latency benchmark for the lookup path. |

## Configuration

All configuration goes through `CODEMEMORY_*` environment variables resolved in [`src/db/config.ts`](./src/db/config.ts). The most useful knobs:

Each model env var is configured independently. If you do not set it explicitly, each one defaults to `claude-haiku-4-5-20251001`.

| Variable | Default | Description |
|---|---|---|
| `CODEMEMORY_ENABLED` | `true` | Global on/off switch. |
| `CODEMEMORY_DATABASE_PATH` | `~/.claude/codememory.db` | SQLite database location. |
| `CODEMEMORY_WORKSPACE_ROOT` | daemon's `cwd` at start | Root used to qualify file tags across repositories. |
| `CODEMEMORY_DEBUG_TOOLS_ENABLED` | `false` | Expose grep/describe/expand/lifecycle admin tools to the model. |
| `CODEMEMORY_COMPACTION_ENABLED` | `true` | Enable async compaction. |
| `CODEMEMORY_COMPACTION_TOKEN_THRESHOLD` | `30000` | Uncompacted M/L token budget that triggers compaction. |
| `CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT` | `20` | Most-recent messages protected from compaction. |
| `CODEMEMORY_COMPACTION_DISABLE_LLM` | `false` | Skip `claude --print` and use truncation fallback. Required offline / in CI. |
| `CODEMEMORY_EXPANSION_MODEL` | `claude-haiku-4-5-20251001` | Model used by `codememory_expand` and `codememory_expand_query`. |
| `CODEMEMORY_QUERY_PLANNER_MODEL` | `claude-haiku-4-5-20251001` | Model used by the optional query planner. |
| `CODEMEMORY_COMPACTION_MODEL` | `claude-haiku-4-5-20251001` | Model used for compaction. |
| `CODEMEMORY_AUTO_SUPERSEDE_MODEL` | `claude-haiku-4-5-20251001` | Model used by the optional auto-supersede judge. |
| `CODEMEMORY_QUERY_PLANNER_ENABLED` | `false` | Enable the optional LLM planner after weak fast-path retrieval. |
| `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM` | `false` | Auto-detect implicit decision supersedes within a conversation. |
| `CODEMEMORY_EXPLORED_TARGET_WINDOW_MS` | `1800000` (30 min) | Repeat exploration of the same Read/Grep/Glob target inside this window decays L → N. |

For the full reference (DAG-shape, expansion sub-agent, auto-supersede tuning, etc.) see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## Tools, Skills, and Commands

### Default model-callable tools

| Tool | Purpose |
|---|---|
| `codememory_check_prior_failures` | Ask whether a file, command, or symbol has failed before. |
| `codememory_mark_decision` | Persist a meaningful technical decision as a `decision` node. |
| `codememory_mark_requirement` | Persist a hard requirement or stable constraint. |
| `codememory_compact` | Force compaction for the current conversation. |

### Debug tools

Enable `CODEMEMORY_DEBUG_TOOLS_ENABLED=true` to expose:

`codememory_grep`, `codememory_describe`, `codememory_expand`, `codememory_expand_query`, `codememory_memory_pending`, `codememory_memory_lifecycle`

### Skills

`codememory-mark-decision`, `codememory-mark-task`, `codememory-mark-constraint`, `codememory-context-skill`, `codememory-summarization-skill`

The mark skills post through `hooks/scripts/codememory-mark.sh`, and the daemon remains the single writer for `memory_nodes`.

### Slash commands

`/codememory-status`, `/codememory-grep`, `/codememory-describe`, `/codememory-expand`, `/codememory-expand-query`, `/codememory-watch`

## Technical Overview

### Retrieval pipeline

1. Extract pivots from the user prompt: file paths, bash binaries, and identifiers.
2. Run a deterministic fast plan to choose intent, wanted node kinds, and tag queries.
3. Query `memory_nodes` first through tag indexes.
4. Stitch nearby rationale through relations such as `relatedTo`, `supersedes`, and `resolves`.
5. Run prior-failure lookup against file, command, and symbol anchors.
6. Fall back to S-tier conversation search when memory-node recall is weak.
7. Inject a single markdown block through `additionalContext` when recall is strong enough.

### Compaction model

1. Older M/L-tier messages are grouped once they exceed the compaction threshold.
2. Each batch becomes a leaf summary through `claude --print`, or a truncation fallback when LLM compaction is disabled.
3. Related leaves condense one level up into a depth-1 summary node.
4. High-value summaries are also promoted into `memory_nodes(kind='summary')` so retrieval can reuse them.

### Data model

| Table | Purpose |
|---|---|
| `conversations` | One row per Claude Code session. |
| `conversation_messages` + `message_parts` | Tier-tagged messages and structured parts. |
| `summaries` + `summary_parents` | Leaf and condensed nodes in the summary DAG. |
| `memory_nodes` | Durable engineering memory. |
| `memory_tags` | Indexed tags such as `kind`, `file`, `command`, and `symbol`. |
| `memory_relations` | Typed edges like `relatedTo`, `resolves`, and `supersedes`. |
| `memory_lifecycle_events` | Status transition log. |
| `memory_pending_updates` | Ambiguous lifecycle updates that need review. |
| `attempt_spans` | Edit/Write to validation-command pairings for fix-attempt tracking. |

## Development

```bash
npm install
npm run build
npm run build:watch
npm test
npm run test:watch
npm run benchmark
npm run benchmark:ci
```

Useful one-off commands:

```bash
npx vitest run test/failure-lookup.test.ts
npx vitest run -t "stitched chain"
```

Notes:

- The build compiles `src/` to `dist/`.
- Hook scripts require `jq` and `curl`.
- Prompt-time retrieval depends on the daemon and compiled `dist/`.
- In offline or CI environments, set `CODEMEMORY_COMPACTION_DISABLE_LLM=true`.

## Troubleshooting

- **No retrieval or failure warnings appear**: make sure `npm run build` has been run, then restart Claude Code so hooks and `dist/` are available.
- **Daemon does not start**: check `~/.claude/codememory-logs/session-start.log` and `~/.claude/codememory-logs/daemon.log`.
- **Offline or CI hangs during compaction**: set `CODEMEMORY_COMPACTION_DISABLE_LLM=true`.
- **Need to inspect runtime state**: use `/codememory-status` and review `~/.claude/codememory.db`.

## Reference Docs

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md): full system design
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): full env-var reference
- [docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md](./docs/MEMORY_FIRST_RETRIEVAL_ARCHITECTURE.md): retrieval pipeline
- [docs/MEMORY_NODE_LIFECYCLE.md](./docs/MEMORY_NODE_LIFECYCLE.md): node states and lifecycle rules
- [docs/MEMORY_RETRIEVAL_REFERENCE.md](./docs/MEMORY_RETRIEVAL_REFERENCE.md): retrieval engine internals
- [docs/PRIOR_FAILURE_REFERENCE.md](./docs/PRIOR_FAILURE_REFERENCE.md): failure capture and lookup
- [docs/TOOL_SURFACE_REFERENCE.md](./docs/TOOL_SURFACE_REFERENCE.md): exposed tools, skills, and commands

## License

MIT.
