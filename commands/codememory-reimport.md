---
name: codememory-reimport
description: Rebuild a session's stored memory from its transcript on disk
---

# codememory-reimport

Rebuild everything CodeMemory has stored for one session by replaying its
transcript.

## Usage

```
/codememory-reimport                 # rebuild the current session
/codememory-reimport <session-id>    # rebuild a specific session
```

## When to use it

The daemon ingests live only. Transcripts already on disk when it starts are
treated as handled, so nothing is re-read on a restart and no rows are
duplicated. The gap that leaves is deliberate, and this command is how it gets
closed:

- a session ran while the daemon was down or crashed
- the stored data for a session looks wrong or incomplete
- an older session predates a change in how messages are scored or extracted

## What it does

**This deletes before it rebuilds.** Everything the session owns — messages,
message parts, summaries, memory nodes, attempt spans, explored targets — is
removed, then reconstructed from the jsonl. That is what makes it safe to run
twice: the result of running it repeatedly is identical to running it once.

The rebuild has two phases:

1. **Deterministic replay.** Every line goes back through the same ingest path
   the live watcher uses — same scorer, same tiers, same extractors — so
   failures, fix attempts and summaries are recovered exactly as they would
   have been captured live.

2. **Key-memory extraction.** Decisions, tasks and constraints are stated in
   prose and no rule produces them, so an LLM pass reads them back out of the
   transcript. Skipped when `CODEMEMORY_COMPACTION_DISABLE_LLM=true`, in which
   case the response says so rather than silently dropping them.

Phase 2 costs model calls proportional to transcript length, so a long session
takes a while. Nothing is written until the delete and replay have succeeded.

## Process

1. Run `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/codememory-reimport.sh` with the
   session id, if one was given.
2. Report the JSON it prints: rows deleted per table, lines parsed, messages
   stored, and how many decisions / tasks / constraints were recovered.
3. If `ok` is false, show the error and point at
   `~/.claude/codememory-logs/reimport.log`.
