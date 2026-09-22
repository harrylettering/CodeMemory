/**
 * The content of a file is not the outcome of an action.
 *
 * Inferred errors exist for one case: a command whose exit code was swallowed
 * (`npm test | tail`, `cd x && tsc`) still printed its failure. On a live
 * database about three quarters of inferred failures were exactly that. The
 * clear misses were results of reading: a Read of a Python module that names
 * `TypeError`, a Grep through code that handles `ENOENT`. Those tools report
 * what a file says, never whether something just failed, so their results are
 * no longer inferred from. An explicit is_error from them -- a missing file --
 * still counts.
 *
 * Reading source through Bash (`cat`, `sed -n`, `grep`) is left alone: it
 * cannot be told apart from `npm test | tail` without guessing at the
 * command, and a guess there would drop real failures.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  scoreMessage,
  createSessionState,
  type ScorerSessionState,
} from "../src/filter/scorer.js";
import type { JsonlMessage, RawMessagePart } from "../src/hooks/jsonl-watcher.js";

let state: ScorerSessionState;
beforeEach(() => {
  state = createSessionState();
});

const SOURCE = [
  '1\t"""Cross-encoder reranking."""',
  "2\ttry:",
  "3\t    score = model.predict(pairs)",
  "4\texcept TypeError as exc:",
  "5\t    raise ValueError('bad pairs') from exc",
].join("\n");

function toolUse(name: string, input: any, id: string): JsonlMessage {
  const parts: RawMessagePart[] = [{ type: "tool_use", name, input, id }];
  return {
    id: `a-${id}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

function result(id: string, content: string, isError = false): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_result", tool_use_id: id, content, is_error: isError } as RawMessagePart,
  ];
  return {
    id: `u-${id}`,
    type: "user",
    role: "user",
    content,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

function scoreAfter(name: string, input: any, content: string, isError = false) {
  const id = `tu-${name}-${Math.random()}`;
  scoreMessage(toolUse(name, input, id), state);
  return scoreMessage(result(id, content, isError), state);
}

describe("results of reading are not inferred as failures", () => {
  it("is precondition-checked: the text alone is inferred as an error", () => {
    // Otherwise the assertions below pass because nothing in SOURCE matches.
    expect(scoreAfter("Bash", { command: "python3 rerank.py" }, SOURCE).tags).toContain(
      "error_inferred"
    );
  });

  for (const [name, input] of [
    ["Read", { file_path: "/repo/rerank.py" }],
    ["Grep", { pattern: "TypeError", path: "/repo" }],
    ["Glob", { pattern: "**/*Error*.py" }],
  ] as const) {
    it(`does not infer an error from ${name}`, () => {
      const scored = scoreAfter(name, input, SOURCE);
      expect(scored.tags).not.toContain("error_inferred");
      expect(scored.tags).not.toContain("error");
    });
  }

  it("still counts a read that explicitly failed", () => {
    const scored = scoreAfter(
      "Read",
      { file_path: "/repo/missing.py" },
      "File does not exist.",
      true
    );
    expect(scored.tags).toContain("error");
  });
});
