---
name: codememory-mark-task
description: Use this skill to durably record the current task or goal so future turns (and future sessions) can recall what we are trying to accomplish. Invoke when the user states a non-trivial objective, when scope is clarified after ambiguity, or when a goal is revised mid-session. Do NOT invoke for trivial follow-ups, micro-edits, or work already captured by an earlier task mark in the same session.
version: 0.1.0
---

# CodeMemory — Mark Task

Persists a single durable task / goal into the CodeMemory memory store via the per-session daemon. The result is a Memory Node tagged `task` + `requirement`.

## When to Use

Invoke this skill when, in the current turn, the user (or you, after clarification) committed to a *non-trivial* goal that should outlive compaction. Good signals:

- The user opened the session with a multi-step ask: "implement X across A, B, C".
- A vague request was sharpened into a concrete objective.
- The user revised the goal partway through ("actually, we also need to migrate Y").
- You and the user agreed on acceptance criteria.

Do NOT invoke for:

- Single-edit asks where the goal is fully captured by the file diff.
- Conversational pleasantries or scoping questions.
- Goals already marked earlier in this session — supersede only if the goal materially changed.

## How to Invoke

Run the wrapper script with `requirement` as the endpoint and a JSON payload. Required fields: `kind: "task"`, `requirement`. Optional: `details`, `acceptance_criteria` (array), `supersedesNodeId`, `sourceToolUseId`.

```bash
~/.claude/plugins/codememory/hooks/scripts/codememory-mark.sh requirement "$(cat <<'JSON'
{
  "kind": "task",
  "requirement": "Migrate the JSONL watcher to write through the new conversation_store API",
  "details": "Old path went through ConversationIngestor; new path exposes idempotent insert keyed by sessionId+sequence.",
  "acceptance_criteria": [
    "All existing tests pass",
    "No direct sqlite writes remain in jsonl-watcher.ts",
    "New code path handles JSONL replay idempotently"
  ]
}
JSON
)"
```

The script discovers the running daemon socket automatically. On success it returns JSON like `{"ok":true,"conversationId":...,"memoryNodeId":"requirement-task-tool-..."}`.

## Authoring Guidance

- **`requirement`**: one durable sentence describing the goal. Imperative voice.
- **`details`**: one short paragraph of supporting context. Skip if the requirement is self-explanatory.
- **`acceptance_criteria`**: bullet checks that define "done". Each one short and verifiable.
- **`supersedesNodeId`**: set when a previous task node is being replaced — keeps lifecycle clean.
- **`sourceToolUseId`**: pass the originating tool_use id when known so retries collapse onto the same node.

After invoking, continue the work — do not summarize the task back at the user.
