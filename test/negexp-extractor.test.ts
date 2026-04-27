/**
 * Unit tests for NegExpExtractor — covers the broadened error whitelist
 * (#4), the richer attemptedFix payload (#6), and the seq-window dedup
 * fix (#8).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { NegExpExtractor } from "../src/negexp/extractor.js";
import type { JsonlMessage } from "../src/hooks/jsonl-watcher.js";

function makeMessage(opts: {
  id?: string;
  role?: string;
  content: string;
  parts?: any[];
}): JsonlMessage {
  return {
    id: opts.id ?? "msg-1",
    type: opts.role ?? "user",
    role: opts.role ?? "user",
    content: opts.content,
    timestamp: Date.now(),
    metadata: {
      sessionId: "test-session",
      parts: opts.parts ?? [],
    },
  };
}

describe("NegExpExtractor.extractFromErrorMessage — error whitelist (#4)", () => {
  let ex: NegExpExtractor;
  beforeEach(() => {
    ex = new NegExpExtractor();
  });

  // Each entry: [label, raw error text]. All must be classified as a
  // real coding error and produce a NegExp record.
  const cases: Array<[string, string]> = [
    ["TS error", "src/foo.ts(12,3): error TS2345: Argument not assignable"],
    [
      "Python ImportError",
      "Traceback (most recent call last):\n  File \"x.py\"\nImportError: No module named foo",
    ],
    [
      "Python ModuleNotFoundError",
      "Traceback (most recent call last):\nModuleNotFoundError: No module named 'requests'",
    ],
    ["Jest fail", "FAIL  src/foo.test.ts\n  ✕ should work\n  AssertionError: expected 1 to equal 2"],
    [
      "ESLint",
      "  10:5  error  'foo' is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)",
    ],
    ["Go panic", "panic: runtime error: index out of range\n\ngoroutine 1 [running]:"],
    ["Go test FAIL", "FAIL\tgithub.com/x/y\t0.123s"],
    ["Rust compile error", "error[E0308]: mismatched types\n  --> src/main.rs:5:9"],
    ["Rust panic", "thread 'main' panicked at 'oh no', src/main.rs:7:5"],
    ["npm ERR!", "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1"],
    ["filesystem ENOENT", "Error: ENOENT: no such file or directory, open '/x/y'"],
    ["Cannot find module", "Error: Cannot find module 'nonexistent'"],
  ];

  it.each(cases)("recognises %s", (_label, raw) => {
    const msg = makeMessage({ content: raw, role: "user" });
    const out = ex.extractFromErrorMessage(msg, /*conv*/ 1, /*seq*/ 5);
    expect(out, `expected ${_label} to be recognised`).not.toBeNull();
    expect(out!.signature).toBeTruthy();
    expect(out!.type).toBeTruthy();
  });

  it("rejects non-coding noise (chrome-devtools, marketplace, etc)", () => {
    const noise = [
      "Failed to clone repository foo/bar",
      "Request failed with status code 404",
      "user doesn't want to proceed",
    ];
    for (const raw of noise) {
      const msg = makeMessage({ content: raw, role: "user" });
      expect(ex.extractFromErrorMessage(msg, 1, 5)).toBeNull();
    }
  });
});

describe("NegExpExtractor — attemptedFix payload (#6)", () => {
  it("captures Edit old_string → new_string snippet", () => {
    const ex = new NegExpExtractor();
    const editMsg = makeMessage({
      role: "assistant",
      content: "[tool_use:Edit] ...",
      parts: [
        {
          type: "tool_use",
          name: "Edit",
          input: {
            file_path: "/repo/src/foo.ts",
            old_string: "const x = 1",
            new_string: "const x: number = 1",
          },
        },
      ],
    });
    ex.observeMessage(editMsg, 1);

    const errorMsg = makeMessage({
      content: "src/foo.ts(1,7): error TS1109: Expression expected",
      role: "user",
      id: "err-1",
    });
    const out = ex.extractFromErrorMessage(errorMsg, 1, 2);
    expect(out).not.toBeNull();
    expect(out!.attemptedFix).toContain("/repo/src/foo.ts");
    expect(out!.attemptedFix).toContain("const x = 1");
    expect(out!.attemptedFix).toContain("const x: number = 1");
    expect(out!.filePath).toBe("/repo/src/foo.ts");
  });

  it("captures full Bash command (not just .py files)", () => {
    const ex = new NegExpExtractor();
    const bashMsg = makeMessage({
      role: "assistant",
      content: "[tool_use:Bash] npm test",
      parts: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "npm test -- --watchAll=false" },
        },
      ],
    });
    ex.observeMessage(bashMsg, 1);

    const errorMsg = makeMessage({
      content: "FAIL  src/foo.test.ts\nAssertionError: expected 1 to equal 2",
      role: "user",
    });
    const out = ex.extractFromErrorMessage(errorMsg, 1, 2);
    expect(out).not.toBeNull();
    expect(out!.command).toContain("npm test");
    expect(out!.attemptedFix).toContain("npm test");
  });
});

describe("NegExpExtractor — symbol extraction", () => {
  it("populates symbol field from V8 stack trace", () => {
    const ex = new NegExpExtractor();
    const errorMsg = makeMessage({
      content:
        `TypeError: x is not a function\n` +
        `    at validateUser (/repo/src/auth.ts:42:9)`,
      role: "user",
    });
    const out = ex.extractFromErrorMessage(errorMsg, 1, 1);
    expect(out).not.toBeNull();
    expect(out!.symbol).toBe("validateUser");
  });

  it("populates symbol field from Python AttributeError", () => {
    const ex = new NegExpExtractor();
    const errorMsg = makeMessage({
      content: "AttributeError: 'User' object has no attribute 'emial'",
      role: "user",
    });
    const out = ex.extractFromErrorMessage(errorMsg, 1, 1);
    expect(out!.symbol).toBe("emial");
  });

  it("leaves symbol undefined when nothing recognisable", () => {
    const ex = new NegExpExtractor();
    const errorMsg = makeMessage({
      content: "exit code 1",
      role: "user",
    });
    const out = ex.extractFromErrorMessage(errorMsg, 1, 1);
    expect(out).not.toBeNull();
    expect(out!.symbol).toBeUndefined();
  });
});

describe("NegExpExtractor — seq-window dedup (#8)", () => {
  it("dedups within window but allows recurrence after window", () => {
    const ex = new NegExpExtractor();
    const errorContent = "TS2345 argument not assignable";

    // First error at seq 5 → should be extracted.
    const m1 = makeMessage({ content: errorContent, role: "user", id: "e1" });
    expect(ex.extractFromErrorMessage(m1, 1, 5)).not.toBeNull();

    // Same signature 3 seqs later → in-window, should be skipped.
    const m2 = makeMessage({ content: errorContent, role: "user", id: "e2" });
    expect(ex.extractFromErrorMessage(m2, 1, 8)).toBeNull();

    // Same signature 20 seqs later → out of window, should re-extract.
    // This is the actual "stepping on the same pit twice" signal we
    // want to surface.
    const m3 = makeMessage({ content: errorContent, role: "user", id: "e3" });
    expect(ex.extractFromErrorMessage(m3, 1, 25)).not.toBeNull();
  });

  it("scopes dedup per conversation", () => {
    const ex = new NegExpExtractor();
    const errorContent = "TS2345 argument not assignable";

    expect(
      ex.extractFromErrorMessage(
        makeMessage({ content: errorContent }),
        /*conv*/ 1,
        5
      )
    ).not.toBeNull();

    // Same signature, different conversation → should NOT be deduped.
    expect(
      ex.extractFromErrorMessage(
        makeMessage({ content: errorContent }),
        /*conv*/ 2,
        5
      )
    ).not.toBeNull();
  });
});
