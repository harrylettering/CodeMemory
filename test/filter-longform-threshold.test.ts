/**
 * Unit tests for Filter/Score #4 — assistant long-form promotion now
 * requires BOTH length >= 500 AND a structure signal (code fence /
 * heading / table / ≥2 list items / ≥2 indented code lines / ≥2
 * paragraph breaks).
 *
 * Structure:
 *   - "stays at M" — long prose without structure (was S under the old
 *     200-char threshold, now correctly M)
 *   - "promotes to S" — long text with each type of structure signal
 *   - "edge cases" — just-below threshold, single weak signal, etc.
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

function assistantText(text: string): JsonlMessage {
  const parts: RawMessagePart[] = [{ type: "text", text }];
  return {
    id: `a-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: text,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("long-form path — prose without structure stays at M", () => {
  it("250-char narration (old over-promoter) stays M", () => {
    const text =
      "I'll start by reading the main entry file and then look at how " +
      "the router wires things up before moving on to the state store. " +
      "After that I'll run the tests to see what is failing so we can " +
      "decide the next step together.";
    expect(text.length).toBeGreaterThan(200);
    expect(text.length).toBeLessThan(500);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });

  it("700-char single-paragraph prose without structure stays M", () => {
    const text = (
      "Alright, so walking through this I think we need to be careful " +
      "about how the cache invalidation interacts with the fan-out pattern " +
      "since there's no explicit versioning on the keys and the consumer " +
      "side assumes monotonic progression which isn't actually guaranteed " +
      "when multiple writers race on the same shard during a rebalance — " +
      "plus the retry policy is exponential but not jittered so we could " +
      "end up with thundering-herd behavior on transient failures. "
    ).repeat(2);
    expect(text.length).toBeGreaterThan(500);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });
});

describe("long-form path — structure signals promote to S", () => {
  it("fenced code block", () => {
    const text =
      "a".repeat(500) + "\nHere's the patch:\n```ts\nconst x = 1;\n```\n";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("markdown heading", () => {
    const text = "## Plan\n\n" + "a".repeat(520);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("markdown table", () => {
    const text =
      "a".repeat(500) +
      "\n\n| col1 | col2 | col3 |\n| ---- | ---- | ---- |\n| a | b | c |\n";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("two bullet list items", () => {
    const text =
      "a".repeat(500) + "\n\n- first option\n- second option\n- third option";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("numbered list items", () => {
    const text =
      "a".repeat(500) + "\n\n1. first step\n2. second step\n3. third step";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("two indented code lines", () => {
    const text =
      "a".repeat(500) + "\n\n    const x = 1;\n    const y = 2;\n";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });

  it("multi-paragraph (≥ 2 blank-line breaks)", () => {
    const text =
      "first paragraph here. ".repeat(10) +
      "\n\n" +
      "second paragraph here. ".repeat(10) +
      "\n\n" +
      "third paragraph here. ".repeat(10);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
  });
});

describe("long-form path — edge cases", () => {
  it("just below 500 chars with structure still stays M", () => {
    const text =
      "short intro here.\n```\ncode\n```\n" + "a".repeat(300);
    expect(text.length).toBeLessThan(500);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });

  it("single list item at 600 chars does NOT qualify (need ≥ 2)", () => {
    const text = "a".repeat(600) + "\n- only one bullet";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });

  it("single indented code line at 600 chars does NOT qualify", () => {
    const text = "a".repeat(600) + "\n    only_one_indented_line();";
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });

  it("single blank-line break does NOT qualify (need ≥ 2)", () => {
    const text = "a".repeat(300) + "\n\n" + "b".repeat(300);
    const result = scoreMessage(assistantText(text), state);
    expect(result.tier).toBe("M");
  });
});
