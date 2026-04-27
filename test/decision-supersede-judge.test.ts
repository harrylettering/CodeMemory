/**
 * Tests for the LLM-as-judge auto-supersede backstop.
 *
 * Two layers:
 *   1. `ClaudeDecisionSupersedeJudge` parsing — given a stub completion,
 *      does it interpret `[{nodeId, verdict}]` correctly?
 *   2. `MemoryNodeStore.createDecisionNode` integration — when
 *      `autoSupersedeViaLlm` is on and the judge marks a candidate
 *      `SUPERSEDED_BY_NEW`, the old node flips to `superseded`.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import {
  createMemoryNodeStore,
  type MemoryNodeStore,
} from "../src/store/memory-store.js";
import {
  ClaudeDecisionSupersedeJudge,
  type DecisionJudgeInput,
  type DecisionSupersedeJudge,
} from "../src/store/decision-supersede-judge.js";

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-judge-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ClaudeDecisionSupersedeJudge", () => {
  it("parses a JSON array verdict and ignores unknown nodeIds", async () => {
    const judge = new ClaudeDecisionSupersedeJudge(
      { model: "stub", timeoutMs: 1000 },
      async () =>
        JSON.stringify([
          { nodeId: "decision-a", verdict: "SUPERSEDED_BY_NEW", reason: "replaced" },
          { nodeId: "decision-b", verdict: "KEEP" },
          { nodeId: "decision-unknown", verdict: "SUPERSEDED_BY_NEW" },
        ])
    );
    const outcomes = await judge.judge({
      newDecision: { nodeId: "decision-new", content: "use B" },
      candidates: [
        { nodeId: "decision-a", content: "use A" },
        { nodeId: "decision-b", content: "unrelated" },
      ],
    });
    expect(outcomes).toEqual([
      { nodeId: "decision-a", verdict: "SUPERSEDED_BY_NEW", reason: "replaced" },
      { nodeId: "decision-b", verdict: "KEEP", reason: undefined },
    ]);
  });

  it("recovers JSON wrapped in prose", async () => {
    const judge = new ClaudeDecisionSupersedeJudge(
      { model: "stub", timeoutMs: 1000 },
      async () =>
        'Here is the answer: [{"nodeId":"decision-a","verdict":"SUPERSEDED_BY_NEW"}] done.'
    );
    const outcomes = await judge.judge({
      newDecision: { nodeId: "decision-new", content: "x" },
      candidates: [{ nodeId: "decision-a", content: "y" }],
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].verdict).toBe("SUPERSEDED_BY_NEW");
  });

  it("returns an empty list when the model emits garbage", async () => {
    const judge = new ClaudeDecisionSupersedeJudge(
      { model: "stub", timeoutMs: 1000 },
      async () => "I cannot answer."
    );
    const outcomes = await judge.judge({
      newDecision: { nodeId: "decision-new", content: "x" },
      candidates: [{ nodeId: "decision-a", content: "y" }],
    });
    expect(outcomes).toEqual([]);
  });

  it("short-circuits with no model call when there are no candidates", async () => {
    let called = 0;
    const judge = new ClaudeDecisionSupersedeJudge(
      { model: "stub", timeoutMs: 1000 },
      async () => {
        called += 1;
        return "[]";
      }
    );
    const outcomes = await judge.judge({
      newDecision: { nodeId: "decision-new", content: "x" },
      candidates: [],
    });
    expect(outcomes).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("MemoryNodeStore.createDecisionNode auto-supersede backstop", () => {
  function makeJudge(verdicts: Record<string, "KEEP" | "SUPERSEDED_BY_NEW">): {
    judge: DecisionSupersedeJudge;
    calls: DecisionJudgeInput[];
  } {
    const calls: DecisionJudgeInput[] = [];
    return {
      calls,
      judge: {
        async judge(input) {
          calls.push(input);
          return input.candidates.map((c) => ({
            nodeId: c.nodeId,
            verdict: verdicts[c.nodeId] ?? "KEEP",
          }));
        },
      },
    };
  }

  it("does not call the judge when an explicit supersedesNodeId is provided", async () => {
    const { judge, calls } = makeJudge({});
    const memoryStore: MemoryNodeStore = createMemoryNodeStore(db, {
      autoSupersedeViaLlm: true,
      decisionJudge: judge,
    });

    const old = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A\nWhy: smaller",
      sourceToolUseId: "toolu_dec_1",
    });
    const next = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library B",
      rationale: "actively maintained",
      content: "[DECISION] Use library B\nWhy: actively maintained",
      sourceToolUseId: "toolu_dec_2",
      supersedesNodeId: old.nodeId,
    });

    expect(calls).toHaveLength(0);
    expect((await memoryStore.getNode(old.nodeId))?.status).toBe("superseded");
    expect((await memoryStore.getNode(next.nodeId))?.supersedesNodeId).toBe(
      old.nodeId
    );
  });

  it("auto-supersedes candidates the judge marks SUPERSEDED_BY_NEW", async () => {
    const { judge, calls } = makeJudge({});
    const memoryStore: MemoryNodeStore = createMemoryNodeStore(db, {
      autoSupersedeViaLlm: true,
      decisionJudge: judge,
    });

    const old = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A\nWhy: smaller",
      sourceToolUseId: "toolu_dec_1",
    });
    // Re-program verdicts: declare oldNodeId superseded.
    Object.assign(judge as any, {
      async judge(input: DecisionJudgeInput) {
        calls.push(input);
        return input.candidates.map((c) => ({
          nodeId: c.nodeId,
          verdict: c.nodeId === old.nodeId ? "SUPERSEDED_BY_NEW" : "KEEP",
          reason: "replaced",
        }));
      },
    });

    const next = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library B",
      rationale: "actively maintained",
      content: "[DECISION] Use library B\nWhy: actively maintained",
      sourceToolUseId: "toolu_dec_2",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].newDecision.nodeId).toBe(next.nodeId);
    expect((await memoryStore.getNode(old.nodeId))?.status).toBe("superseded");
  });

  it("only considers candidates from the same conversation", async () => {
    const { judge, calls } = makeJudge({});
    const memoryStore: MemoryNodeStore = createMemoryNodeStore(db, {
      autoSupersedeViaLlm: true,
      decisionJudge: judge,
    });

    const otherConv = await memoryStore.createDecisionNode({
      conversationId: 7,
      sessionId: "s2",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A",
      sourceToolUseId: "toolu_dec_x",
    });
    const sameConvOld = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A",
      sourceToolUseId: "toolu_dec_y0",
    });
    await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library B",
      rationale: "different conversation",
      content: "[DECISION] Use library B",
      sourceToolUseId: "toolu_dec_y",
    });

    expect(calls).toHaveLength(1);
    const seenIds = calls[0].candidates.map((c) => c.nodeId);
    expect(seenIds).toContain(sameConvOld.nodeId);
    expect(seenIds).not.toContain(otherConv.nodeId);
    expect((await memoryStore.getNode(otherConv.nodeId))?.status).toBe("active");
  });

  it("ignores judge errors and leaves the new decision active", async () => {
    const failingJudge: DecisionSupersedeJudge = {
      async judge() {
        throw new Error("model timed out");
      },
    };
    const memoryStore: MemoryNodeStore = createMemoryNodeStore(db, {
      autoSupersedeViaLlm: true,
      decisionJudge: failingJudge,
    });

    const old = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A",
      sourceToolUseId: "toolu_dec_1",
    });
    const next = await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library B",
      rationale: "actively maintained",
      content: "[DECISION] Use library B",
      sourceToolUseId: "toolu_dec_2",
    });

    expect((await memoryStore.getNode(old.nodeId))?.status).toBe("active");
    expect((await memoryStore.getNode(next.nodeId))?.status).toBe("active");
  });

  it("does nothing when the autoSupersedeViaLlm flag is off", async () => {
    const { judge, calls } = makeJudge({ "any": "SUPERSEDED_BY_NEW" });
    const memoryStore: MemoryNodeStore = createMemoryNodeStore(db, {
      autoSupersedeViaLlm: false,
      decisionJudge: judge,
    });
    await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library A",
      rationale: "smaller",
      content: "[DECISION] Use library A",
      sourceToolUseId: "toolu_dec_1",
    });
    await memoryStore.createDecisionNode({
      conversationId: 9,
      sessionId: "s1",
      decision: "Use library B",
      rationale: "actively maintained",
      content: "[DECISION] Use library B",
      sourceToolUseId: "toolu_dec_2",
    });
    expect(calls).toHaveLength(0);
  });
});
