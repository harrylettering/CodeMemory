/**
 * Signature quality tests.
 *
 * A signature is the equality key prior-failure recall matches on, so it has
 * two ways to fail and they pull in opposite directions.
 *
 * Too long: it carries whatever the command happened to print alongside the
 * error — a directory listing, a diff — which differs next time, so it never
 * matches a second occurrence. Measured on a real database before this was
 * fixed: median 330 characters, only 32% short enough to be reusable.
 *
 * Too generic: `Exit code 1` matches every failed command there has ever
 * been. That is the worse direction. A signature that fails to match costs a
 * missed warning; one that matches everything costs a wrong warning, and a
 * wrong prior-failure warning is what teaches someone to ignore them.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeError,
  isAnchorableSignature,
  extractErrorLines,
} from "../src/negexp/signature.js";

describe("extractErrorLines", () => {
  it("isolates the error from surrounding command output", () => {
    const raw = [
      "total 16",
      "drwxr-xr-x@  4 harlihao  wheel  128 Sep  7 00:16 .",
      "-rw-r--r--@  1 harlihao  wheel  180 broken.ts",
      "broken.ts(3,9): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join("\n");

    const isolated = extractErrorLines(raw);
    expect(isolated).toContain("TS2322");
    expect(isolated).not.toContain("drwxr-xr-x");
    expect(isolated).not.toContain("total 16");
  });

  it("does not let an exit-code line crowd out the real error", () => {
    // The harness prints the exit code first. Treated as a match it wins by
    // position and truncates away the error underneath it.
    const raw = [
      "[tool_result] Exit code 1",
      "node:internal/modules/esm/resolve:314",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from /x/y.js",
    ].join("\n");

    expect(extractErrorLines(raw)).toContain("ERR_MODULE_NOT_FOUND");
  });
});

describe("normalizeError", () => {
  it("keeps a real failure short enough to match a second occurrence", () => {
    const raw =
      "total 16\ndrwxr-xr-x@ 4 x\n" +
      "broken.ts(3,9): error TS2322: Type 'number' is not assignable to type 'string'.";
    const sig = normalizeError(raw);

    expect(sig.length).toBeLessThanOrEqual(200);
    expect(sig).toContain("TS2322");
  });

  it("produces the same signature for the same failure in different noise", () => {
    const err =
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from /x/y.js";
    const first = normalizeError(`total 16\ndrwxr-x 4 x\n${err}`);
    const second = normalizeError(`$ npm run build\n> tsc\n${err}`);

    // Same failure, different surrounding output — recall depends on these
    // being equal, which is exactly what whole-payload normalization broke.
    expect(first).toBe(second);
  });
});

describe("isAnchorableSignature", () => {
  it("accepts a signature that identifies a specific failure", () => {
    for (const raw of [
      "broken.ts(3,9): error TS2322: Type 'number' is not assignable to type 'string'.",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from /x",
      "Traceback (most recent call last):\nAttributeError: 'NoneType' object has no attribute 'e'",
    ]) {
      expect(isAnchorableSignature(normalizeError(raw)), raw).toBe(true);
    }
  });

  it("rejects a signature that would match every failed command", () => {
    // The node is still stored and still reachable by file and command —
    // only the anchor that would produce false matches is withheld.
    for (const raw of [
      "[tool_result] Exit code 1",
      "[tool_result] Exit code 1\n=== 差异 ===\n19c19",
      "Exit code 2",
    ]) {
      expect(isAnchorableSignature(normalizeError(raw)), raw).toBe(false);
    }
  });

  it("ignores the harness prefix when judging specificity", () => {
    // `[tool_result]` is added by the watcher when flattening parts. Counted
    // as content it made a bare exit code look like 25 characters of signal.
    expect(isAnchorableSignature("[tool_result] Exit code 1")).toBe(false);
  });
});
