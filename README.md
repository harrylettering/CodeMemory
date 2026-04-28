# CodeMemory for Claude Code

[English](./README.md) | [简体中文](./README.zh-CN.md)

<p align="center">
  <strong>Persistent engineering memory for Claude Code.</strong>
</p>

<p align="center">
  Store decisions, constraints, failures, and compacted summaries in local SQLite, then bring the right context back into long sessions, complex refactors, and debugging loops.
</p>

<p align="center">
  <a href="https://github.com/harrylettering/CodeMemory/stargazers">Star on GitHub</a>
  ·
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#feature-highlights">Feature Highlights</a>
  ·
  <a href="#configuration">Configuration</a>
  ·
  <a href="#tooling-surface">Tools</a>
  ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="https://github.com/harrylettering/CodeMemory/stargazers"><img src="https://img.shields.io/github/stars/harrylettering/CodeMemory?style=flat-square" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin-black" alt="Claude Code Plugin" />
  <img src="https://img.shields.io/badge/SQLite-Local%20First-003B57" alt="SQLite Local First" />
  <img src="https://img.shields.io/badge/Persistent-Memory-1f6feb" alt="Persistent Memory" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

CodeMemory is a local-first Claude Code plugin that turns per-session context into durable engineering memory. It stores conversations, summaries, decisions, constraints, failures, and fix attempts in SQLite, then injects the right context back into prompts and risky tool calls.

CodeMemory is intentionally narrow: it is not a general-purpose RAG layer. It is optimized for long Claude Code sessions, complex refactors, and multi-round debugging loops where remembering prior intent matters more than broad document search.

- Claude Code plugin: `codememory-plugin`
- npm package: `codememory-for-claude`

## Why CodeMemory

CodeMemory is built for three recurring pain points in coding sessions:

1. **Long sessions**: keep stable requirements and constraints visible after context-window truncation.
2. **Complex refactors**: preserve design rationale, rejected alternatives, and why the current approach won.
3. **Multi-round debugging**: recall prior failures and fix attempts before repeating a broken path.

## Feature Highlights

- **Local-first memory**: everything lives in `~/.claude/codememory.db`; no external service is required.
- **Prompt-time retrieval**: every user prompt can pull relevant tasks, constraints, decisions, and failures into `additionalContext`.
- **Prior-failure alerts**: before `Edit`, `Write`, or `Bash`, CodeMemory checks whether the target has failed before.
- **DAG-based compaction**: long history is compacted into leaf and condensed summaries instead of being discarded.
- **Structured memory nodes**: `task`, `constraint`, `decision`, `failure`, `fix_attempt`, and `summary` nodes with tags, relations, and lifecycle status.
- **Fast runtime path**: a per-session daemon serves hot lookups over a Unix socket, with a CLI cold-start fallback where needed.
- **Debuggable surface area**: hooks, tools, and slash commands map cleanly onto the same runtime model.

## Quick Start

### Prerequisites

- Node.js 18 or newer
- Claude Code CLI
- `jq` and `curl` available on `PATH`

### Install from Marketplace

Open Claude Code in any project, then run:

```text
/plugin marketplace add harrylettering/CodeMemory
/plugin install codememory-plugin@harrylettering-codememory
/reload-plugins
```

This repository now doubles as its own marketplace through [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json), so you can distribute the plugin through Claude Code's standard marketplace flow without a separate catalog repository.

### Install from Source for Development

```bash
git clone https://github.com/harrylettering/CodeMemory.git
cd CodeMemory
npm install
npm run build
chmod +x hooks/scripts/*.sh

mkdir -p ~/.claude/plugins
ln -sf "$(pwd)" ~/.claude/plugins/codememory
```

The repository already contains `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `hooks/hooks.json`, so linking the repository root is enough for local development.

Restart Claude Code. On the next `SessionStart`, CodeMemory will initialize the SQLite database, start its per-session daemon, and begin watching the session transcript.

## What Happens After Install

Once installed, CodeMemory runs mostly on its own:

1. `SessionStart` initializes the database and starts a per-session daemon.
2. The daemon tails the session JSONL so it can ingest model responses as well as hook events.
3. Every `UserPromptSubmit` can trigger memory-first retrieval and inject relevant context into the prompt.
4. Every `PreToolUse` checks for prior failures related to the file, command, or symbol being touched.
5. As history grows, M/L-tier messages are compacted into a summary DAG and promoted into reusable memory nodes.

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

For the full environment-variable reference, see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## Tooling Surface

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

## Documentation

- [README.zh-CN.md](./README.zh-CN.md): Chinese README
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): full environment-variable reference

## Development

### Repository Layout

| Path | Purpose |
|---|---|
| `src/` | Core runtime: retrieval, compaction, stores, hooks runtime, and plugin activation. |
| `hooks/` | Claude Code hook definitions and shell entrypoints. |
| `commands/` | Slash-command descriptions such as `/codememory-status` and `/codememory-watch`. |
| `skills/` | Skills for marking decisions, tasks, and constraints from the model side. |
| `docs/` | User-facing configuration reference in English and Chinese. |
| `test/` | Automated tests for retrieval, lifecycle, failure lookup, compaction, and tools. |
| `benchmark/` | Latency benchmark for the lookup path. |

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
- If you publish an update, bump the version in [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) so installed users receive the new release.

## Troubleshooting

- **No retrieval or failure warnings appear**: make sure `npm run build` has been run, then restart Claude Code so hooks and `dist/` are available.
- **Daemon does not start**: check `~/.claude/codememory-logs/session-start.log` and `~/.claude/codememory-logs/daemon.log`.
- **Offline or CI hangs during compaction**: set `CODEMEMORY_COMPACTION_DISABLE_LLM=true`.
- **Need to inspect runtime state**: use `/codememory-status` and review `~/.claude/codememory.db`.

## License

MIT.
