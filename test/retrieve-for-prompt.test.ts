/**
 * Tests for `RetrievalEngine.retrieveForPrompt` — the UserPromptSubmit
 * injection path. Verifies:
 *   - Path A: prior failures (memory_nodes kind='failure') surface when
 *     the prompt mentions a known file/command/symbol.
 *   - Path B: conversation messages matching prompt keywords surface,
 *     with `[DECISION]`-prefixed messages bucketed separately.
 *   - Empty input → empty markdown (noop).
 *   - `extractPromptPivots` covers filePaths, commands, and symbols.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RetrievalEngine, extractPromptPivots } from "../src/retrieval.js";
import {
  createMemoryNodeStore,
  type CreateFailureNodeInput,
} from "../src/store/memory-store.js";
import type { SummaryRecord } from "../src/store/summary-store.js";

let dbDir: string;
let db: any;
let conversationStore: ConversationStore;
let summaryStore: SummaryStore;
let engine: RetrievalEngine;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-prompt-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  conversationStore = new ConversationStore(db);
  summaryStore = new SummaryStore(db);
  const memoryStore = createMemoryNodeStore(db);
  engine = new RetrievalEngine(conversationStore, summaryStore, memoryStore);

  await db.run(
    `INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')`
  );
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function seedFailure(record: Partial<CreateFailureNodeInput>) {
  const memoryStore = createMemoryNodeStore(db);
  return memoryStore.createFailureNode({
    conversationId: 1,
    sessionId: "sess-A",
    seq: 1,
    type: "type_error",
    signature: "TS2345",
    raw: "argument not assignable",
    weight: 1.0,
    ...record,
  });
}

async function seedMessage(params: {
  content: string;
  role?: string;
  tags?: string[];
}) {
  return conversationStore.insertMessage({
    conversationId: 1,
    role: params.role ?? "assistant",
    content: params.content,
    tokenCount: Math.ceil(params.content.length / 4),
    tier: "S",
    tags: params.tags,
    parts: [{ partType: "text", textContent: params.content }],
  });
}

async function seedSummary(params: {
  summaryId: string;
  kind: "leaf" | "condensed";
  depth: number;
  content: string;
}): Promise<SummaryRecord> {
  const tokenCount = Math.ceil(params.content.length / 4);
  const createdAt = "2026-04-22T00:02:00.000Z";
  await db.run(
    `INSERT INTO summaries (
       summaryId, conversationId, kind, depth, earliestAt, latestAt,
       descendantCount, content, tokenCount, createdAt
     ) VALUES (?, 1, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      params.summaryId,
      params.kind,
      params.depth,
      "2026-04-22T00:00:00.000Z",
      "2026-04-22T00:01:00.000Z",
      params.content,
      tokenCount,
      createdAt,
    ]
  );

  return {
    summaryId: params.summaryId,
    conversationId: 1,
    kind: params.kind,
    depth: params.depth,
    earliestAt: "2026-04-22T00:00:00.000Z",
    latestAt: "2026-04-22T00:01:00.000Z",
    descendantCount: 1,
    tokenCount,
    content: params.content,
    createdAt,
  };
}

describe("extractPromptPivots", () => {
  it("pulls file paths, commands, and symbols from a prompt", () => {
    const pivots = extractPromptPivots(
      "Can you rerun npm test and fix src/auth/login.ts — the HandleLogin function is broken?"
    );

    expect(pivots.filePaths).toContain("src/auth/login.ts");
    expect(pivots.commands.some((c) => c.startsWith("npm test"))).toBe(true);
    expect(pivots.symbols).toContain("HandleLogin");
  });

  it("ignores stopwords and short tokens in keywords", () => {
    const pivots = extractPromptPivots("when should we make this code work");
    for (const stop of ["when", "this", "make", "code"]) {
      expect(pivots.keywords).not.toContain(stop);
    }
  });

  it("handles empty / whitespace prompts without throwing", () => {
    const pivots = extractPromptPivots("");
    expect(pivots.filePaths).toEqual([]);
    expect(pivots.commands).toEqual([]);
    expect(pivots.symbols).toEqual([]);
    expect(pivots.keywords).toEqual([]);
  });
});

describe("RetrievalEngine.retrieveForPrompt", () => {
  it("surfaces prior failure records keyed on a filePath pivot", async () => {
    await seedFailure({
      filePath: "src/auth/login.ts",
      type: "test_fail",
      raw: "AssertionError: expected 200, got 500",
      attemptedFix: "tried rewriting handler",
    });

    const result = await engine.retrieveForPrompt({
      prompt: "Please touch src/auth/login.ts again and retry",
    });

    expect(result.pivots.filePaths).toContain("src/auth/login.ts");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filePath).toBe("src/auth/login.ts");
    expect(result.markdown).toContain("Prior Failures");
    expect(result.markdown).toContain("src/auth/login.ts");
  });

  it("buckets [DECISION]-prefixed messages into `decisions` and surfaces them first", async () => {
    await seedMessage({
      content: "[DECISION] Use zod for runtime validation",
      tags: ["decision"],
    });
    await seedMessage({
      content: "we debated validation approaches earlier today",
      role: "user",
    });

    const result = await engine.retrieveForPrompt({
      prompt: "What did we decide about validation?",
      conversationId: 1,
    });

    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.decisions[0].content).toContain("[DECISION]");
    // A decision message must not also appear in the generic messages bucket.
    const decisionIds = new Set(result.decisions.map((d) => d.messageId));
    for (const m of result.messages) {
      expect(decisionIds.has(m.messageId)).toBe(false);
    }
    expect(result.markdown).toContain("Past Decisions");
  });

  it("uses the decision tag when a decision message has no prefix", async () => {
    await seedMessage({
      content: "Use the central validator for login payloads",
      tags: ["decision"],
    });

    const result = await engine.retrieveForPrompt({
      prompt: "What did we decide about validator?",
      conversationId: 1,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].content).toContain("central validator");
  });

  it("returns empty markdown when nothing matches", async () => {
    const result = await engine.retrieveForPrompt({
      prompt: "completely unrelated quoobledorf phraseology",
    });

    expect(result.failures).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
    expect(result.markdown).toBe("");
  });

  it("respects the failureLimit option", async () => {
    for (let i = 0; i < 4; i++) {
      await seedFailure({
        filePath: "src/hot.ts",
        signature: `sig-${i}`,
        raw: `occurrence ${i}`,
        seq: i + 1,
      });
    }

    const result = await engine.retrieveForPrompt({
      prompt: "edit src/hot.ts again",
      failureLimit: 1,
    });

    expect(result.failures).toHaveLength(1);
  });

  it("merges prior failures + decisions + messages into one markdown block", async () => {
    await seedFailure({
      filePath: "src/handler.ts",
      type: "runtime_error",
      raw: "TypeError: undefined is not a function",
    });
    await seedMessage({
      content: "[DECISION] Route handler errors through the central logger",
      tags: ["decision"],
    });
    await seedMessage({
      content: "handler got refactored last week",
      role: "user",
    });

    const result = await engine.retrieveForPrompt({
      prompt: "please update src/handler.ts",
      conversationId: 1,
    });

    expect(result.markdown).toContain("Prior Failures");
    expect(result.markdown).toContain("Past Decisions");
    // Ordering matters: failure warnings come before decisions, which come
    // before generic context.
    const failIdx = result.markdown.indexOf("Prior Failures");
    const decIdx = result.markdown.indexOf("Past Decisions");
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(decIdx).toBeGreaterThan(failIdx);
  });

  it("uses Memory Node retrieval as the primary prompt injection path when available", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.upsertNode({
      nodeId: "decision-message-99",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "99",
      content: "[DECISION] Login validation must stay in src/auth/login.ts",
      tags: [
        { tagType: "kind", tagValue: "decision", weight: 2 },
        { tagType: "file", tagValue: "src/auth/login.ts", weight: 2 },
        { tagType: "topic", tagValue: "auth", weight: 1 },
      ],
    });
    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "之前 src/auth/login.ts 的决策是什么",
      conversationId: 1,
    });

    expect(result.memoryNodes).toHaveLength(1);
    expect(result.markdown).toContain("Decision Memory");
    expect(result.markdown).toContain("Login validation");
    expect(result.plan?.intent).toBe("recall_decision_rationale");
  });

  it("surfaces task / constraint memory first for low-anchor continuation prompts", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.createTaskNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 41,
      task: "Finish the login refactor in src/auth/login.ts",
      details: "Continue from the shared validator extraction.",
    });
    await memoryStore.createConstraintNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 42,
      constraint: "Do not change the login response shape",
      details: "Existing clients depend on the current payload keys.",
    });
    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "继续下一步",
      conversationId: 1,
    });

    expect(result.plan?.wantedKinds).toEqual(
      expect.arrayContaining(["task", "constraint"])
    );
    expect(result.memoryNodes?.map((candidate) => candidate.node.kind)).toEqual(
      expect.arrayContaining(["task", "constraint"])
    );
    expect(result.markdown).toContain("Current Task Memory");
    expect(result.markdown).toContain("Active Constraint Memory");
    expect(result.markdown.indexOf("Current Task Memory")).toBeLessThan(
      result.markdown.indexOf("Active Constraint Memory")
    );
  });

  it("stitches one-hop related memory into the prompt context chain", async () => {
    const memoryStore = createMemoryNodeStore(db);
    const taskNode = await memoryStore.createTaskNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 51,
      task: "Continue the login refactor in src/auth/login.ts",
      details: "Current work is still in the auth module.",
    });
    await memoryStore.upsertNode({
      nodeId: "decision-response-contract",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-response-contract",
      content: "[DECISION] Keep the public login response contract stable",
      metadata: {
        decision: "Keep the public login response contract stable",
      },
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });
    await memoryStore.addRelation({
      fromNodeId: taskNode.nodeId,
      toNodeId: "decision-response-contract",
      relationType: "relatedTo",
      confidence: 0.92,
      metadata: { reason: "task depends on the previously agreed response contract" },
    });

    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "继续 src/auth/login.ts 的改造，并避免之前 stale token 的失败",
      conversationId: 1,
    });

    expect(result.memoryNodes?.map((candidate) => candidate.node.nodeId)).toContain(
      taskNode.nodeId
    );
    expect(result.stitchedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "relatedTo",
          fromNodeId: taskNode.nodeId,
          toNodeId: "decision-response-contract",
        }),
      ])
    );
    expect(result.markdown).toContain("Stitched Memory Chain");
    expect(result.markdown).toContain("public login response contract stable");
  });

  it("extends stitched memory into a controllable two-hop short chain", async () => {
    const memoryStore = createMemoryNodeStore(db);
    const taskNode = await memoryStore.createTaskNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 61,
      task: "Continue the login refactor in src/auth/login.ts",
      details: "We are still in the auth flow.",
    });
    await memoryStore.upsertNode({
      nodeId: "decision-shared-validator",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-shared-validator",
      content: "[DECISION] Move auth validation into the shared validator",
      metadata: {
        decision: "Move auth validation into the shared validator",
      },
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "failure-stale-token",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-stale-token",
      content: "[FAILURE] stale token still broke the login flow",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.addRelation({
      fromNodeId: taskNode.nodeId,
      toNodeId: "decision-shared-validator",
      relationType: "relatedTo",
      confidence: 0.94,
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-shared-validator",
      toNodeId: "failure-stale-token",
      relationType: "relatedTo",
      confidence: 0.9,
    });

    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "继续 src/auth/login.ts 的改造，并避免之前 stale token 的失败",
      conversationId: 1,
    });

    expect(result.stitchedChains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeIds: [
            taskNode.nodeId,
            "decision-shared-validator",
            "failure-stale-token",
          ],
          relationTypes: ["relatedTo", "relatedTo"],
        }),
      ])
    );
    expect(result.markdown).toContain("2-hop");
    expect(result.markdown).toContain("stale token still broke the login flow");
    expect(result.metrics.memory.relationQueryBatches).toBe(2);
    expect(result.metrics.memory.firstHopNodeCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.memory.secondHopNodeCount).toBeGreaterThanOrEqual(2);
    expect(result.metrics.memory.stitchedChainCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.legacy.failureLookupCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.legacy.queryCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps failure-oriented stitched chains for modify/debug prompts while filtering rationale-only branches", async () => {
    const memoryStore = createMemoryNodeStore(db);
    const taskNode = await memoryStore.createTaskNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 71,
      task: "Continue the login refactor in src/auth/login.ts",
      details: "We still need to avoid the stale-token regression.",
    });
    await memoryStore.upsertNode({
      nodeId: "decision-shared-validator-intent",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-shared-validator-intent",
      content: "[DECISION] Move auth validation into the shared validator",
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "failure-stale-token-intent",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-stale-token-intent",
      content: "[FAILURE] stale token still broke the login flow",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "summary-rationale-intent",
      kind: "summary",
      conversationId: 1,
      source: "summary_dag",
      sourceId: "summary-rationale-intent",
      summaryId: "leaf-rationale-intent",
      content: "Rationale summary: we moved validation to unify auth checks.",
      tags: [{ tagType: "kind", tagValue: "summary_anchor", weight: 2 }],
    });
    await memoryStore.addRelation({
      fromNodeId: taskNode.nodeId,
      toNodeId: "decision-shared-validator-intent",
      relationType: "relatedTo",
      confidence: 0.95,
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-shared-validator-intent",
      toNodeId: "failure-stale-token-intent",
      relationType: "relatedTo",
      confidence: 0.93,
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-shared-validator-intent",
      toNodeId: "summary-rationale-intent",
      relationType: "relatedTo",
      confidence: 0.94,
    });

    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "继续 src/auth/login.ts 的改造，并避免之前 stale token 的失败",
      conversationId: 1,
    });

    expect(result.plan?.intent).toBe("modify_and_avoid_prior_failure");
    expect(result.stitchedChains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeIds: [
            taskNode.nodeId,
            "decision-shared-validator-intent",
            "failure-stale-token-intent",
          ],
        }),
      ])
    );
    expect(
      result.stitchedChains?.some((chain) =>
        chain.nodeIds.includes("summary-rationale-intent")
      )
    ).toBe(false);
  });

  it("keeps rationale-oriented stitched chains for history prompts while filtering failure branches", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.upsertNode({
      nodeId: "decision-shared-validator-history",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-shared-validator-history",
      content: "[DECISION] Move auth validation into the shared validator",
      metadata: {
        decision: "Move auth validation into the shared validator",
      },
      tags: [
        { tagType: "kind", tagValue: "decision", weight: 2 },
        { tagType: "topic", tagValue: "auth", weight: 1 },
      ],
    });
    await memoryStore.upsertNode({
      nodeId: "summary-rationale-history",
      kind: "summary",
      conversationId: 1,
      source: "summary_dag",
      sourceId: "summary-rationale-history",
      summaryId: "leaf-rationale-history",
      content: "Summary: shared validation keeps auth logic consistent across handlers.",
      tags: [{ tagType: "kind", tagValue: "summary_anchor", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "failure-stale-token-history",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-stale-token-history",
      content: "[FAILURE] stale token broke the login flow",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-shared-validator-history",
      toNodeId: "summary-rationale-history",
      relationType: "relatedTo",
      confidence: 0.95,
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-shared-validator-history",
      toNodeId: "failure-stale-token-history",
      relationType: "relatedTo",
      confidence: 0.9,
    });

    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "之前为什么决定把 auth validation 移到 shared validator",
      conversationId: 1,
    });

    expect(result.plan?.intent).toBe("recall_decision_rationale");
    expect(result.stitchedChains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeIds: ["decision-shared-validator-history", "summary-rationale-history"],
        }),
      ])
    );
    expect(
      result.stitchedChains?.some((chain) =>
        chain.nodeIds.includes("failure-stale-token-history")
      )
    ).toBe(false);
  });

  it("adds one-layer DAG evidence for recalled condensed summary anchors", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await seedSummary({
      summaryId: "leaf-login-1",
      kind: "leaf",
      depth: 0,
      content:
        "Root cause: src/auth/login.ts failed because the auth token was stale.",
    });
    await seedSummary({
      summaryId: "leaf-login-2",
      kind: "leaf",
      depth: 0,
      content:
        "Fix attempt: refresh auth token before calling the login handler.",
    });
    const condensed = await seedSummary({
      summaryId: "cond-login-1",
      kind: "condensed",
      depth: 1,
      content:
        "Root cause for src/auth/login.ts: stale token, fixed by refreshing before login.",
    });
    await db.run(
      "INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)",
      ["leaf-login-1", "cond-login-1", 0]
    );
    await db.run(
      "INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)",
      ["leaf-login-2", "cond-login-1", 1]
    );
    await memoryStore.createSummaryNode(condensed);

    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "之前 src/auth/login.ts 的根因是什么",
      conversationId: 1,
    });

    expect(result.markdown).toContain("Summary Anchor Memory");
    expect(result.markdown).toContain("Evidence:");
    expect(result.markdown).toContain("leaf-login-1");
    expect(result.markdown).toContain("auth token was stale");
  });

  it("uses a smart query planner after weak fast-path memory retrieval", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.upsertNode({
      nodeId: "decision-validation",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "validation",
      content: "[DECISION] Use the central validator for login payloads",
      tags: [
        { tagType: "topic", tagValue: "validation", weight: 2 },
      ],
    });
    const queryPlanner = {
      async plan({ fastPlan }: any) {
        return {
          ...fastPlan,
          intent: "recall_decision_rationale",
          entities: {
            ...fastPlan.entities,
            topics: [...fastPlan.entities.topics, "validation"],
          },
          wantedKinds: ["decision", "summary_anchor"],
          tagQueries: [
            ...fastPlan.tagQueries,
            { tagType: "topic", tagValue: "validation", weight: 2 },
            { tagType: "kind", tagValue: "decision", weight: 1 },
          ],
        };
      },
    };
    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      memoryStore,
      queryPlanner,
      true
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "之前我们为什么这么决定",
      conversationId: 1,
    });

    expect(result.planner?.source).toBe("smart");
    expect(result.memoryNodes?.map((candidate) => candidate.node.nodeId)).toContain(
      "decision-validation"
    );
    expect(result.metrics.memory.candidateCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.memory.selectedNodeCount).toBeGreaterThanOrEqual(1);
    expect(result.markdown).toContain("Decision Memory");
    expect(result.markdown).toContain("central validator");
  });

  it("falls back to the fast plan when smart query planning fails", async () => {
    const memoryEngine = new RetrievalEngine(
      conversationStore,
      summaryStore,
      createMemoryNodeStore(db),
      {
        async plan() {
          throw new Error("planner unavailable");
        },
      },
      true
    );

    const result = await memoryEngine.retrieveForPrompt({
      prompt: "之前我们为什么这么决定",
      conversationId: 1,
    });

    expect(result.planner?.source).toBe("fallback");
    expect(result.planner?.error).toContain("planner unavailable");
    expect(result.markdown).toBe("");
  });
});
