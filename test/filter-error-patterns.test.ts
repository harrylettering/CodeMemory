/**
 * Unit tests for Filter/Score #2 — ERROR_RESULT_PATTERNS tightening.
 *
 * Verifies that:
 *   - obvious false positives in the old patterns no longer promote to S
 *     (bare "error"/"failed" tokens, "no errors found", "exit code 0",
 *     prose discussing errors, etc.)
 *   - genuinely-failing tool output still gets promoted to S via the
 *     orphan fallback path (no tool_use_id resolution).
 *
 * The orphan path is what exercises these patterns, so the tests construct
 * tool_result user messages with an unresolvable tool_use_id.
 */

import { describe, expect, it, beforeEach } from "vitest";
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

function orphanResult(text: string): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_result", content: text, tool_use_id: "orphan_id" },
  ];
  return {
    id: `user-${Math.random()}`,
    type: "user",
    role: "user",
    content: `[tool_result] ${text}`,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("ERROR_RESULT_PATTERNS false-positive fixes", () => {
  // These used to promote to S under the old /\berror|failed|exception\b/i.
  // With the tightened set they should fall through to plain M.
  const falsePositives: Array<[string, string]> = [
    ["'no errors found' output", "Lint passed. No errors found in 42 files."],
    [
      "prose that discusses errors",
      "The function returns an error object describing the failure mode in detail.",
    ],
    [
      "code identifier containing 'error'",
      "const error_handler = (e) => console.log(e);\nexport { error_handler };",
    ],
    ["0 tests failed", "Tests: 42 passed, 0 failed, 42 total."],
    ["'exit code 0' — successful exit", "Process exited with exit code 0"],
    [
      "'exit code ' with trailing whitespace (no digits) — old [^0] bug",
      "Command finished. exit code \nnext line",
    ],
    [
      "generic 'exception' mention in log",
      "This function may throw an exception when input is invalid.",
    ],
    [
      "'failure' inside a word/sentence that isn't a real failure",
      "A failure-detection retry loop guards the network call.",
    ],
    [
      "traceback mentioned in docs, not a real one",
      "See the traceback section in the Python manual for more details.",
    ],
  ];

  for (const [name, text] of falsePositives) {
    it(`no longer promotes to S: ${name}`, () => {
      const result = scoreMessage(orphanResult(text), state);
      expect(result.tier, `text: ${text}`).toBe("M");
      expect(result.tags, `text: ${text}`).toContain("orphan");
    });
  }
});

describe("ERROR_RESULT_PATTERNS still catches genuine errors", () => {
  const trueErrors: Array<[string, string]> = [
    ["Python traceback", "Traceback (most recent call last):\n  File 'a.py'"],
    ["Named Python exception", "NameError: name 'foo' is not defined"],
    ["TypeScript diagnostic code", "src/a.ts(10,5): TS2304: Cannot find name"],
    ["Cannot find module", "Error: Cannot find module 'foo' from '/x'"],
    ["ENOENT", "ENOENT: no such file or directory, open '/tmp/x'"],
    ["EACCES", "EACCES: permission denied, open '/root/secret'"],
    ["npm ERR!", "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1"],
    ["Go panic", "panic: runtime error: index out of range"],
    ["Rust error code", "error[E0308]: mismatched types"],
    ["Rust panic", "thread 'main' panicked at 'assertion failed'"],
    ["Compiler 'error:' at line start", "main.c:42: error: expected ';'"],
    ["'fatal:' at line start (git)", "fatal: not a git repository"],
    ["Non-zero exit code — single digit", "Command failed with exit code 1"],
    ["Non-zero exit code — multi digit", "Command exited with exit code 127"],
    ["Vitest failure summary", "Tests: 3 failed, 10 passed, 13 total"],
    ["Is not a function", "TypeError: foo.bar is not a function"],
  ];

  for (const [name, text] of trueErrors) {
    it(`still promotes to S: ${name}`, () => {
      const result = scoreMessage(orphanResult(text), state);
      expect(result.tier, `text: ${text}`).toBe("S");
      expect(result.tags, `text: ${text}`).toContain("error_inferred");
    });
  }
});

describe("is_error===true still wins regardless of text", () => {
  it("is_error=true on innocuous text still goes S", () => {
    const parts: RawMessagePart[] = [
      {
        type: "tool_result",
        content: "everything looks fine",
        tool_use_id: "orphan_id",
        is_error: true,
      },
    ];
    const msg: JsonlMessage = {
      id: "u1",
      type: "user",
      role: "user",
      content: "[tool_result] everything looks fine",
      timestamp: Date.now(),
      metadata: { sessionId: "s", parts },
    };
    const result = scoreMessage(msg, state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("error");
  });
});
