---
name: codememory-mark-constraint
description: Use this skill to durably record a hard constraint or invariant that the work must respect. Invoke when the user states a must-not-break rule, a compatibility boundary, a performance budget, a security/compliance requirement, or any other guardrail that should outlive compaction. Do NOT invoke for soft preferences, style nudges, or constraints already captured earlier in the session.
version: 0.1.0
---

# CodeMemory — Mark Constraint

Persists a single hard constraint into the CodeMemory memory store via the per-session daemon. The result is a Memory Node tagged `constraint` + `requirement` that future turns can consult before making decisions.

## When to Use

Invoke this skill when, in the current turn, the user (or you, after agreement) established a guardrail. Good signals:

- "Don't break the public API."
- "We need to keep p99 latency under 50 ms."
- "All writes must go through the daemon — no direct sqlite from hooks."
- "This file must remain backwards-compatible with v0.1 clients."
- A migration plan that explicitly excludes a region of code from changes.

Do NOT invoke for:

- Stylistic preferences ("use camelCase") — those belong in CLAUDE.md or feedback memory.
- Constraints already marked in this session, unless materially revised (then supersede).
- Soft suggestions phrased as "might be nice".

## How to Invoke

Run the wrapper script with `requirement` as the endpoint and a JSON payload. Required fields: `kind: "constraint"`, `requirement`. Optional: `details`, `acceptance_criteria` (array), `supersedesNodeId`, `sourceToolUseId`.

```bash
~/.claude/plugins/codememory/hooks/scripts/codememory-mark.sh requirement "$(cat <<'JSON'
{
  "kind": "constraint",
  "requirement": "Daemon is the only writer of memory_nodes; watcher is the only writer of conversation_messages",
  "details": "Single-writer-per-table avoids race conditions during concurrent ingestion paths.",
  "acceptance_criteria": [
    "memory_nodes inserts only originate from src/hooks/daemon.ts",
    "conversation_messages inserts only originate from the JSONL watcher"
  ]
}
JSON
)"
```

The script discovers the running daemon socket automatically. On success it returns JSON like `{"ok":true,"conversationId":...,"memoryNodeId":"requirement-constraint-tool-..."}`.

## Authoring Guidance

- **`requirement`**: one durable sentence stating the rule. Phrase as an invariant ("must / never / only").
- **`details`**: short paragraph explaining the *why* — usually a past incident, a compliance ask, or a performance budget. The why is what lets future turns judge edge cases.
- **`acceptance_criteria`**: concrete checks that the constraint is being honored. Optional but recommended.
- **`supersedesNodeId`**: set when an older constraint node is being replaced.
- **`sourceToolUseId`**: pass the originating tool_use id when known so retries collapse onto the same node.

After invoking, continue the work — do not echo the constraint back at the user.
