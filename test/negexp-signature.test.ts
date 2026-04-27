/**
 * Unit tests for negexp signature normalization + classification.
 *
 * These lock down the behaviour of the patterns added/fixed in the
 * P0/P1 sweep so future regressions are caught immediately.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeError,
  classifyError,
  extractSymbol,
} from "../src/negexp/signature.js";

describe("normalizeError", () => {
  it("strips macOS/Linux absolute paths", () => {
    const out = normalizeError(
      "TypeError at /Users/foo/bar/baz.ts: Cannot read"
    );
    expect(out).not.toContain("/Users/foo/bar/baz.ts");
    expect(out).toContain("<path>");
  });

  it("does NOT degenerate to a single slash (regression of #7)", () => {
    // The previous lazy regex /\/[^:\s]+?(?=[\s:])/ would match a bare
    // "/" instead of the whole path. Verify the path is fully replaced.
    const out = normalizeError("error at /a/b/c.py:10");
    expect(out).not.toMatch(/\/a\/b/);
    // Only the placeholder should remain, no leftover "/" segments.
    expect(out.split("<path>").join("")).not.toContain("/");
  });

  it("strips line numbers in stack traces", () => {
    const out = normalizeError(
      "Error: foo\n  at /tmp/x.ts:42\n  at /tmp/y.ts:7"
    );
    expect(out).not.toMatch(/:\d+/);
  });

  it("strips Windows absolute paths", () => {
    const out = normalizeError("Error at C:\\Users\\foo\\bar.ts");
    expect(out).not.toContain("C:\\Users");
    expect(out).toContain("<path>");
  });

  it("collapses whitespace and trims trailing punctuation", () => {
    const out = normalizeError("  Error:   foo   bar.  ");
    expect(out).toBe("Error: foo bar");
  });

  it("produces stable signature across same-error different-paths", () => {
    const a = normalizeError("TS2345 at /repo/a/foo.ts:10");
    const b = normalizeError("TS2345 at /other/b/foo.ts:99");
    expect(a).toBe(b);
  });
});

describe("extractSymbol", () => {
  it("extracts deepest Python Traceback frame", () => {
    const raw =
      `Traceback (most recent call last):\n` +
      `  File "x.py", line 12, in main\n` +
      `  File "x.py", line 25, in process_user\n` +
      `  File "x.py", line 40, in validate_email\n` +
      `ValueError: bad email`;
    expect(extractSymbol(raw)).toBe("validate_email");
  });

  it("ignores Python <module> frame", () => {
    const raw =
      `Traceback (most recent call last):\n` +
      `  File "x.py", line 1, in <module>\n` +
      `ImportError: No module named foo`;
    // <module> is rejected, so falls through to NameError-style heuristics.
    // None match → undefined.
    expect(extractSymbol(raw)).toBeUndefined();
  });

  it("extracts symbol from Python AttributeError", () => {
    expect(
      extractSymbol("AttributeError: 'User' object has no attribute 'emial'")
    ).toBe("emial");
  });

  it("extracts symbol from Python NameError", () => {
    expect(
      extractSymbol("NameError: name 'undefined_var' is not defined")
    ).toBe("undefined_var");
  });

  it("extracts function name from V8 stack frame", () => {
    const raw =
      `TypeError: x is not a function\n` +
      `    at validateUser (/repo/src/auth.ts:42:9)\n` +
      `    at handleLogin (/repo/src/auth.ts:10:3)`;
    expect(extractSymbol(raw)).toBe("validateUser");
  });

  it("extracts symbol from JS ReferenceError", () => {
    expect(
      extractSymbol("ReferenceError: someMissingVar is not defined")
    ).toBe("someMissingVar");
  });

  it("extracts property name from JS TypeError (modern form)", () => {
    expect(
      extractSymbol(
        "TypeError: Cannot read properties of undefined (reading 'profile')"
      )
    ).toBe("profile");
  });

  it("extracts property name from JS TypeError (legacy form)", () => {
    expect(
      extractSymbol("TypeError: Cannot read property 'name' of undefined")
    ).toBe("name");
  });

  it("extracts symbol from TS Property does not exist", () => {
    expect(
      extractSymbol(
        "src/foo.ts(12,5): error TS2339: Property 'doesntExist' does not exist on type 'User'"
      )
    ).toBe("doesntExist");
  });

  it("returns undefined when no recognised pattern matches", () => {
    expect(extractSymbol("FAIL\tgithub.com/x/y\t0.123s")).toBeUndefined();
    expect(extractSymbol("npm ERR! code ELIFECYCLE")).toBeUndefined();
  });

  it("rejects identifiers with whitespace", () => {
    // Pathological — should never happen, but make sure the guard works.
    expect(extractSymbol("name 'foo bar' is not defined")).toBeUndefined();
  });
});

describe("classifyError", () => {
  it.each([
    ["IndexError: list index out of range", "index_error"],
    ["TypeError: Cannot read property 'x' of undefined", "undefined_error"],
    ["error TS2345 argument not assignable", "type_error"],
    ["SyntaxError: Unexpected token", "syntax_error"],
    ["ENOENT: no such file or directory", "file_not_found"],
    ["EACCES: permission denied", "permission_error"],
    ["bash exited with exit code 1", "exit_error"],
  ])("classifies %j as %j", (raw, expected) => {
    expect(classifyError(normalizeError(raw))).toBe(expected);
  });
});
