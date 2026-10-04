/**
 * The memories a compaction call reports, and which of them are allowed in.
 *
 * Extraction rides the summary call: the same first-line JSON object that
 * already says whether a summary is worth anchoring now also carries what the
 * window decided, started or constrained, and what that replaces.
 *
 * The rules here are all anti-pollution. A wrong new memory costs a line; a
 * wrong INVALIDATE destroys one that was right, and this system's standing
 * rule is that polluted memory is more expensive than missing memory.
 */
import { describe, expect, it } from "vitest";
import { parseExtractedMemories } from "../src/compaction/extracted-memories.js";

const CANDIDATES = ["task-1-10", "decision-1-20"];

const parse = (raw: string, candidates = CANDIDATES) =>
  parseExtractedMemories(raw, candidates);

describe("what comes back", () => {
  it("reads memories out of the first-line JSON alongside the anchor fields", () => {
    const result = parse(
      JSON.stringify({
        anchor: true,
        kinds: ["decision"],
        memories: [
          { kind: "decision", op: "ADD", text: "Ride the compaction call" },
          { kind: "task", op: "INVALIDATE", targetNodeId: "task-1-10", reason: "shipped" },
        ],
      })
    );

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]).toMatchObject({ kind: "decision", op: "ADD" });
    expect(result.accepted[1]).toMatchObject({ op: "INVALIDATE", targetNodeId: "task-1-10" });
    expect(result.rejected).toEqual([]);
  });

  it("treats a summary with no memories as none, not as an error", () => {
    const result = parse(JSON.stringify({ anchor: false, kinds: [] }));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ignores NOOP, which exists so the model can say 'nothing new'", () => {
    const result = parse(JSON.stringify({ memories: [{ op: "NOOP" }] }));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("what is refused", () => {
  it("refuses an operation aimed at a node that was never offered", () => {
    // The id may be invented, or copied from context belonging to another
    // session. Either way it is not something this window was shown.
    const result = parse(
      JSON.stringify({
        memories: [{ kind: "task", op: "INVALIDATE", targetNodeId: "task-9-99" }],
      })
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "unknown-target", op: "INVALIDATE" }]);
  });

  it("refuses an UPDATE with no target", () => {
    const result = parse(
      JSON.stringify({ memories: [{ kind: "task", op: "UPDATE", text: "x" }] })
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "missing-target", op: "UPDATE" }]);
  });

  it("refuses an ADD with no text", () => {
    const result = parse(JSON.stringify({ memories: [{ kind: "task", op: "ADD" }] }));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "empty-text", op: "ADD" }]);
  });

  it("refuses a kind this pass does not produce", () => {
    // failure, fix_attempt and summary are derived deterministically; letting
    // the model mint them would put guesses next to observations.
    const result = parse(
      JSON.stringify({ memories: [{ kind: "failure", op: "ADD", text: "TS2322 again" }] })
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ reason: "unsupported-kind", op: "ADD" }]);
  });

  it("refuses every operation on a node when they contradict each other", () => {
    const result = parse(
      JSON.stringify({
        memories: [
          { kind: "task", op: "UPDATE", targetNodeId: "task-1-10", text: "still going" },
          { kind: "task", op: "INVALIDATE", targetNodeId: "task-1-10", reason: "done" },
        ],
      })
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { reason: "conflicting-ops", op: "UPDATE" },
      { reason: "conflicting-ops", op: "INVALIDATE" },
    ]);
  });

  it("survives a malformed header without losing the summary", () => {
    const result = parse("not json at all");
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("survives memories that are not a list", () => {
    const result = parse(JSON.stringify({ memories: "everything" }));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("revises, which names an earlier memory in words rather than by id", () => {
  it("keeps the text so the caller can match it against this batch's own output", () => {
    const result = parse(
      JSON.stringify({
        memories: [
          {
            kind: "decision",
            op: "ADD",
            text: "Send titles only",
            revises: "Send 200 characters of each candidate",
          },
        ],
      })
    );

    expect(result.accepted[0].revises).toBe("Send 200 characters of each candidate");
  });
});
