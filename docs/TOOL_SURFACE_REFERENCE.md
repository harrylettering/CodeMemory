# Tool Surface Reference

> Chinese version: [TOOL_SURFACE_REFERENCE.zh-CN.md](./TOOL_SURFACE_REFERENCE.zh-CN.md)
>
> This document describes the actual tools and interfaces currently exposed to the model, hooks, and daemon.

## 1. Model-callable tools

### 1.1 Default tools

Enabled by default:

- `codememory_check_prior_failures`
- `codememory_mark_decision`
- `codememory_mark_requirement`
- `codememory_compact`

These make up the default product-facing tool surface today.

### 1.2 Debug and admin tools

Registered only when `debugToolsEnabled=true`:

- `codememory_grep`
- `codememory_describe`
- `codememory_expand`
- `codememory_expand_query`
- `codememory_memory_pending`
- `codememory_memory_lifecycle`

These are mainly for diagnosis, observability, and manual debugging. They are not intended to be the primary workflow surface.

## 2. Hook scripts

The main hook-side entrypoints are:

- `session-start.sh`
- `user-prompt-submit.sh`
- `pre-tool-use.sh`
- `pre-compact.sh`
- `final-compact.sh`
- `session-end.sh`

Their responsibilities are:

- starting and stopping the daemon
- requesting prompt-time retrieval
- checking prior-failure warnings
- requesting background compaction

## 3. Daemon socket interfaces

The daemon currently exposes the following internal interfaces:

- `/retrieval/onPrompt`
- `/failure/lookup` with `/negexp/lookup` kept as a compatibility alias
- `/compact`

These endpoints are intended for hooks and the local runtime. They are not public model-facing product APIs.

## 4. Tool design principles

The current tool surface follows three principles:

1. Keep the default surface small.  
   Only keep the most stable and highest-value tools on by default.

2. Keep diagnostic power behind debug mode.  
   Tools like grep, expand, and lifecycle admin are still valuable, but should not crowd the main path.

3. Prefer automatic retrieval over manual retrieval.  
   The goal is for the system to proactively recall context during prompt and tool-use stages, rather than forcing the model to search constantly by hand.

## 5. Recommended usage order

For normal usage, the recommended order is:

1. automatic prompt retrieval
2. `PreToolUse` prior-failure warning
3. `codememory_mark_requirement`
4. `codememory_mark_decision`
5. `codememory_compact`

Enabling debug tools is mainly recommended when diagnosing the system itself.
