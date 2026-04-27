/**
 * Unit tests for Filter/Score #6 — scaffolding tool classification.
 *
 * Scaffolding tools (TodoWrite, ExitPlanMode) produce no durable memory
 * signal; classifying them N keeps the row count sane and prevents their
 * tool_result replies from persisting as M.
 *
 * Also covers the expanded EXPLORATION_TOOLS set (WebSearch, NotebookRead).
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

function assistantToolUse(
  toolName: string,
  input: any,
  id: string = "tu_" + Math.random()
): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_use", name: toolName, input, id },
  ];
  return {
    id: `a-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

function toolResult(toolUseId: string, content: string): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_result", tool_use_id: toolUseId, content },
  ];
  return {
    id: `u-${Math.random()}`,
    type: "user",
    role: "user",
    content,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("#6 scaffolding tools → N", () => {
  it("TodoWrite tool_use is N", () => {
    const result = scoreMessage(
      assistantToolUse("TodoWrite", {
        todos: [{ content: "step 1", status: "pending", activeForm: "doing" }],
      }),
      state
    );
    expect(result.tier).toBe("N");
  });

  it("ExitPlanMode tool_use is N", () => {
    const result = scoreMessage(
      assistantToolUse("ExitPlanMode", { plan: "do the thing" }),
      state
    );
    expect(result.tier).toBe("N");
  });

  it("TodoWrite tool_result also drops (inherits N from origin)", () => {
    const id = "tu_todo_1";
    scoreMessage(assistantToolUse("TodoWrite", { todos: [] }, id), state);
    const result = scoreMessage(toolResult(id, "Todos have been updated"), state);
    expect(result.tier).toBe("N");
  });

  it("mixed message with text + TodoWrite — text still drives the tier", () => {
    // Long prose + TodoWrite in the same message. The text part is scaffolding
    // narration (no decision keyword, no structure) so stays M.
    const parts: RawMessagePart[] = [
      { type: "text", text: "Let me update the plan and continue." },
      {
        type: "tool_use",
        name: "TodoWrite",
        input: { todos: [] },
        id: "tu_mixed",
      },
    ];
    const msg: JsonlMessage = {
      id: "a-mixed",
      type: "assistant",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      metadata: { sessionId: "s", parts },
    };
    const result = scoreMessage(msg, state);
    // Text part → M, TodoWrite → N. Highest wins: M.
    expect(result.tier).toBe("M");
  });
});

describe("#6 expanded exploration set", () => {
  it("WebSearch is L (fact-only)", () => {
    const result = scoreMessage(
      assistantToolUse("WebSearch", { query: "vitest snapshot api" }),
      state
    );
    expect(result.tier).toBe("L");
  });

  it("NotebookRead is L (fact-only)", () => {
    const result = scoreMessage(
      assistantToolUse("NotebookRead", { notebook_path: "/x.ipynb" }),
      state
    );
    expect(result.tier).toBe("L");
  });

  it("WebSearch result is fact-summarized, not raw payload", () => {
    const id = "tu_ws_1";
    scoreMessage(
      assistantToolUse("WebSearch", { query: "abc" }, id),
      state
    );
    const bigResult = "a".repeat(5000); // would be capped at M if stored raw
    const res = scoreMessage(toolResult(id, bigResult), state);
    expect(res.tier).toBe("L");
    expect(res.content.length).toBeLessThan(200); // summary, not payload
    expect(res.content).toContain("WebSearch result");
  });
});

describe("#6 still safe for unknown tools", () => {
  it("unknown MCP-style tool falls through to M (safe default)", () => {
    const result = scoreMessage(
      assistantToolUse("mcp__foo__query", { x: 1 }),
      state
    );
    expect(result.tier).toBe("M");
  });

  it("Task (subagent spawn) stays M — the delegation itself is signal", () => {
    const result = scoreMessage(
      assistantToolUse("Task", {
        description: "review migration",
        prompt: "Review X",
        subagent_type: "general-purpose",
      }),
      state
    );
    expect(result.tier).toBe("M");
  });
});
