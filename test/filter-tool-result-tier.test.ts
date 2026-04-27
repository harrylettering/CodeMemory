/**
 * Unit tests for Filter/Score #1 — tool_result tier must inherit the
 * originating tool_use's tier so L-tier exploration results don't silently
 * store full payloads as M.
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

function assistant(parts: RawMessagePart[]): JsonlMessage {
  return {
    id: `asst-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

function userToolResult(parts: RawMessagePart[], flattened = ""): JsonlMessage {
  return {
    id: `user-${Math.random()}`,
    type: "user",
    role: "user",
    content: flattened,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("tool_result tier inheritance", () => {
  it("Read result becomes L with fact summary, not raw payload", () => {
    const toolUseId = "toolu_read_1";
    scoreMessage(
      assistant([
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" }, id: toolUseId },
      ]),
      state
    );

    const rawFile = "line1\nline2\nline3\nsecret content that should not leak";
    const result = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: rawFile, tool_use_id: toolUseId }],
        `[tool_result] ${rawFile}`
      ),
      state
    );

    expect(result.tier).toBe("L");
    expect(result.content).not.toContain("secret content");
    expect(result.content).toMatch(/\[Read result\] \d+ lines, \d+ bytes/);
  });

  it("Bash result becomes M with capped content", () => {
    const toolUseId = "toolu_bash_1";
    scoreMessage(
      assistant([
        { type: "tool_use", name: "Bash", input: { command: "ls" }, id: toolUseId },
      ]),
      state
    );

    const result = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: "file1\nfile2", tool_use_id: toolUseId }],
        "[tool_result] file1\nfile2"
      ),
      state
    );

    expect(result.tier).toBe("M");
    expect(result.content).toContain("file1");
  });

  it("Edit result becomes M", () => {
    const toolUseId = "toolu_edit_1";
    scoreMessage(
      assistant([
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
          id: toolUseId,
        },
      ]),
      state
    );

    const result = scoreMessage(
      userToolResult(
        [
          {
            type: "tool_result",
            content: "File edited successfully",
            tool_use_id: toolUseId,
          },
        ],
        "[tool_result] File edited successfully"
      ),
      state
    );

    expect(result.tier).toBe("M");
  });

  it("is_error=true promotes any result to S regardless of origin tool", () => {
    const toolUseId = "toolu_read_err";
    scoreMessage(
      assistant([
        { type: "tool_use", name: "Read", input: { file_path: "/x.ts" }, id: toolUseId },
      ]),
      state
    );

    const result = scoreMessage(
      userToolResult(
        [
          {
            type: "tool_result",
            content: "ENOENT: no such file or directory",
            tool_use_id: toolUseId,
            is_error: true,
          },
        ],
        "[tool_result] ENOENT: no such file or directory"
      ),
      state
    );

    expect(result.tier).toBe("S");
    expect(result.tags).toContain("error");
    // When it's an actual error, full content is preserved (not summarized).
    expect(result.content).toContain("ENOENT");
  });

  it("duplicate Read drops both the tool_use part and its result", () => {
    const firstId = "toolu_read_first";
    const first = scoreMessage(
      assistant([
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" }, id: firstId },
      ]),
      state
    );
    expect(first.tier).toBe("L");

    const secondId = "toolu_read_second";
    const second = scoreMessage(
      assistant([
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" }, id: secondId },
      ]),
      state
    );
    expect(second.tier).toBe("N");

    // The matching tool_result for the deduped tool_use must also go N
    // so L-tier dedup isn't defeated on the result side.
    const secondResult = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: "line1\nline2", tool_use_id: secondId }],
        "[tool_result] line1\nline2"
      ),
      state
    );
    expect(secondResult.tier).toBe("N");
  });

  it("orphan tool_result (no matching tool_use) falls back to M", () => {
    const result = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: "some output", tool_use_id: "unknown_id" }],
        "[tool_result] some output"
      ),
      state
    );
    expect(result.tier).toBe("M");
    expect(result.tags).toContain("orphan");
  });

  it("orphan tool_result with error-looking text gets S via pattern inference", () => {
    const text = "SyntaxError: Unexpected token";
    const result = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: text, tool_use_id: "unknown_id" }],
        `[tool_result] ${text}`
      ),
      state
    );
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("error_inferred");
  });

  it("empty tool_result → N", () => {
    const result = scoreMessage(
      userToolResult(
        [{ type: "tool_result", content: "", tool_use_id: "anything" }],
        ""
      ),
      state
    );
    expect(result.tier).toBe("N");
  });

  it("Grep result carries match-line count", () => {
    const toolUseId = "toolu_grep_1";
    scoreMessage(
      assistant([
        {
          type: "tool_use",
          name: "Grep",
          input: { pattern: "foo" },
          id: toolUseId,
        },
      ]),
      state
    );

    const result = scoreMessage(
      userToolResult(
        [
          {
            type: "tool_result",
            content: "a.ts:1:foo\nb.ts:2:foo\nc.ts:3:foo",
            tool_use_id: toolUseId,
          },
        ],
        ""
      ),
      state
    );

    expect(result.tier).toBe("L");
    expect(result.content).toMatch(/\[Grep result\] \d+ match lines/);
  });
});
