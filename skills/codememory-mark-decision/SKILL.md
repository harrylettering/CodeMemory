---
name: codememory-mark-decision
description: Use this skill to durably record a non-trivial design or implementation decision so it survives compaction and can be recalled in future sessions. Invoke when you (or the user) commit to a meaningful technical choice — schema shape, library selection, refactor direction, breaking-change boundary, etc. Do NOT invoke for trivial choices, exploratory speculation, or decisions the user has already discarded.
version: 0.1.0
---

# CodeMemory — Mark Decision

Persists a single decision into the CodeMemory memory store via the per-session daemon. The result is a Memory Node tagged `decision` that future sessions can recall by file path, symbol, or query.

## When to Use

Invoke this skill when, in the current turn, a decision was *made* — not merely discussed. Good signals:

- The user said "let's go with X" / "use X instead" / "we'll keep Y for now".
- You proposed an approach and the user accepted it.
- You and the user agreed to reject an alternative for a concrete reason.
- A non-obvious tradeoff was resolved (e.g. "store as JSON because schema churn is too high right now").

Do NOT invoke for:

- Tactical edits whose rationale is obvious from the diff.
- Decisions that are still under debate.
- Decisions the user has already overridden in the same turn.
- Restating something the model has already marked in this session.

## When You Are Replacing a Prior Decision (READ THIS BEFORE INVOKING)

Before sending the curl, **stop and ask yourself**: did you already mark a decision earlier in *this same session* whose conclusion the new decision contradicts or replaces? Common shapes:

- "Use A" earlier → "Actually, use B" now.
- "Keep X in module M" earlier → "Move X out of module M" now.
- "Pick library L1" earlier → "Switch to library L2" now.

If yes, you **MUST** pass `supersedesNodeId` pointing to the older decision's Memory Node id. The daemon's response to every prior `codememory-mark-decision` call returned that id as `memoryNodeId` — keep track of those ids in your scratch reasoning so you can reference them when superseding.

If you do not pass `supersedesNodeId`, the old decision will remain `active` and will resurface in future retrieval alongside the new one. Cross-session retrieval *deliberately* keeps both visible (the system cannot tell from outside whether contexts differ), but **within one session it is your responsibility** to retire prior decisions you have already overruled.

Do not pass `supersedesNodeId` for unrelated decisions, or for refinements that merely add detail without contradicting the prior conclusion.

## How to Invoke

Run the wrapper script with `decision` as the endpoint and a JSON payload. Required fields: `decision`, `rationale`. Optional: `alternatives_rejected` (array of strings), `supersedesNodeId` (id of the older decision this replaces — see section above), `sourceToolUseId` (idempotency key — pass the model `tool_use.id` if available).

```bash
~/.claude/plugins/codememory/hooks/scripts/codememory-mark.sh decision "$(cat <<'JSON'
{
  "decision": "Store memory node tags in a separate join table rather than a JSON column",
  "rationale": "We need indexed lookup by tag for retrieval; JSON column would force a full scan.",
  "alternatives_rejected": [
    "JSON column on memory_nodes — no index, scans grow with node count",
    "FTS5 virtual table — overkill for a fixed enum of tags"
  ]
}
JSON
)"
```

The script discovers the running daemon socket automatically. On success it returns JSON like `{"ok":true,"conversationId":...,"memoryNodeId":"decision-tool-..."}`.

## Authoring Guidance

- **`decision`**: one imperative-ish sentence. State *what* was chosen, not *why*.
- **`rationale`**: one or two sentences of *why*. The reason is what makes the memory load-bearing in future sessions — don't skip it.
- **`alternatives_rejected`**: list each rejected option with a one-line reason. Skip if there were no real alternatives.
- **`supersedesNodeId`**: required if this decision overrides an earlier decision you marked in this session. See the "When You Are Replacing a Prior Decision" section. Within one session this is the *only* way to retire the older node.
- **`sourceToolUseId`**: pass the originating tool_use id when known so retries collapse onto the same node.

After invoking, do not paraphrase the decision back to the user — the memory has been written, just continue the work.
