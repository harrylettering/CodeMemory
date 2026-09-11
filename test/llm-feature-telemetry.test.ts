/**
 * Telemetry for the two optional LLM-backed features.
 *
 * Both were enabled in settings and neither could be shown to have ever run.
 * The decision judge recorded something only when it ruled SUPERSEDED_BY_NEW
 * and swallowed every error at the call site, so three very different states
 * looked identical from outside: never invoked, invoked and conservatively
 * kept everything, invoked and failed on every call. The first needs a
 * trigger fix, the second is correct behavior, the third is an outage.
 *
 * The query planner had the same shape of gap. Its source/reason pair was
 * computed and returned, then dropped, so "the fast plan was good enough" and
 * "the smart planner threw" both showed up as a fast-plan result.
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
import type { DecisionSupersedeJudge } from "../src/store/decision-supersede-judge.js";

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-telemetry-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const judgeEvents = () => db.all("SELECT * FROM decision_judge_events ORDER BY eventId");
const retrievalEvents = () => db.all("SELECT * FROM retrieval_events ORDER BY eventId");

function storeWithJudge(judge: DecisionSupersedeJudge): MemoryNodeStore {
  return createMemoryNodeStore(db, {
    autoSupersedeViaLlm: true,
    decisionJudge: judge,
  });
}

const decision = (store: MemoryNodeStore, text: string, seq: number) =>
  store.createDecisionNode({
    conversationId: 1,
    sessionId: "s1",
    decision: text,
    rationale: "because",
    content: `[DECISION] ${text}\nWhy: because`,
    sourceToolUseId: `toolu_${seq}`,
  });

describe("decision judge telemetry", () => {
  it("records a row when the judge keeps every candidate", async () => {
    const store = storeWithJudge({
      async judge(input) {
        return input.candidates.map((c) => ({
          nodeId: c.nodeId,
          verdict: "KEEP" as const,
        }));
      },
    });

    await decision(store, "Use library A", 1);
    await decision(store, "Name the module widgets", 2);

    const rows = await judgeEvents();
    const kept = rows.filter((r: any) => r.outcome === "all_kept");
    expect(kept).toHaveLength(1);
    expect(kept[0].candidateCount).toBe(1);
    expect(kept[0].supersededCount).toBe(0);
    expect(kept[0].errorMessage).toBeNull();
  });

  it("separates a parse failure from a conservative keep", async () => {
    const store = storeWithJudge({
      async judge() {
        return [];
      },
    });

    await decision(store, "Use library A", 1);
    await decision(store, "Use library B instead", 2);

    const rows = await judgeEvents();
    expect(rows.map((r: any) => r.outcome)).toContain("empty_verdict");
    expect(rows.map((r: any) => r.outcome)).not.toContain("all_kept");
  });

  it("records the error instead of swallowing it, and still writes the node", async () => {
    const store = storeWithJudge({
      async judge() {
        throw new Error("claude --print exited with code 1: not authenticated");
      },
    });

    await decision(store, "Use library A", 1);
    const node = await decision(store, "Use library B instead", 2);

    // The write that triggered the judge must survive the judge failing.
    expect(node.nodeId).toBeTruthy();

    const errors = (await judgeEvents()).filter((r: any) => r.outcome === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].errorMessage).toContain("not authenticated");
    expect(errors[0].candidateCount).toBe(1);
  });

  it("records the supersede it performed, with the node it retired", async () => {
    let firstNodeId = "";
    const store = storeWithJudge({
      async judge(input) {
        return input.candidates.map((c) => ({
          nodeId: c.nodeId,
          verdict: "SUPERSEDED_BY_NEW" as const,
          reason: "same topic",
        }));
      },
    });

    firstNodeId = (await decision(store, "Use library A", 1)).nodeId;
    await decision(store, "Use library B instead", 2);

    const rows = (await judgeEvents()).filter((r: any) => r.outcome === "superseded");
    expect(rows).toHaveLength(1);
    expect(rows[0].supersededCount).toBe(1);
    expect(JSON.parse(rows[0].supersededNodeIds)).toEqual([firstNodeId]);
  });

  it("distinguishes having nothing to compare against from having agreed", async () => {
    const store = storeWithJudge({
      async judge() {
        throw new Error("should not be called");
      },
    });

    await decision(store, "Use library A", 1);

    const rows = await judgeEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("no_candidates");
  });

  it("writes no row at all when the feature is off", async () => {
    const store = createMemoryNodeStore(db, { autoSupersedeViaLlm: false });
    await decision(store, "Use library A", 1);
    await decision(store, "Use library B instead", 2);
    expect(await judgeEvents()).toHaveLength(0);
  });
});

describe("retrieval telemetry", () => {
  it("keeps the prompts that injected nothing, so a hit rate exists", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      conversationId: 1,
      sessionId: "s1",
      promptLength: 40,
      plannerSource: "fast",
      plannerAttempted: false,
      plannerReason: "fast_plan_sufficient",
      memoryNodeCount: 0,
      injectedChars: 0,
    });
    await store.recordRetrieval({
      conversationId: 1,
      sessionId: "s1",
      promptLength: 90,
      plannerSource: "fast",
      plannerAttempted: false,
      plannerReason: "fast_plan_sufficient",
      memoryNodeCount: 3,
      injectedChars: 2141,
    });

    const rows = await retrievalEvents();
    expect(rows.map((r: any) => r.outcome)).toEqual(["empty", "injected"]);
  });

  it("records a failed planner as fallback, with the reason it failed", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 120,
      plannerSource: "fallback",
      plannerAttempted: true,
      plannerReason: "fast_plan_weak",
      plannerError: "claude --print timed out after 30000ms",
      memoryNodeCount: 1,
      injectedChars: 415,
    });

    const [row] = await retrievalEvents();
    expect(row.plannerSource).toBe("fallback");
    expect(row.plannerAttempted).toBe(1);
    expect(row.plannerError).toContain("timed out");
    // A fallback still produced a result; the point is that it is no longer
    // indistinguishable from the fast plan having been sufficient.
    expect(row.outcome).toBe("injected");
  });

  it("marks the smart path as attempted so it can be counted", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 200,
      plannerSource: "smart",
      plannerAttempted: true,
      plannerReason: "prompt_looks_historical",
      memoryNodeCount: 5,
      injectedChars: 900,
    });

    const [row] = await retrievalEvents();
    expect(row.plannerSource).toBe("smart");
    expect(row.plannerAttempted).toBe(1);
    expect(row.plannerError).toBeNull();
  });

  it("stores the funnel, so a low hit rate can be attributed", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 60,
      plannerSource: "fast",
      plannerAttempted: false,
      memoryNodeCount: 2,
      injectedChars: 400,
      intent: "debug_prior_failure",
      candidateCount: 37,
      selectedNodeCount: 2,
      stitchedRelationCount: 0,
      stitchedChainCount: 0,
      summaryEvidenceCount: 1,
      firstHopNodeCount: 2,
      secondHopNodeCount: 0,
      estimatedTokens: 310,
    });

    const [row] = await retrievalEvents();
    // 37 matched a tag and 2 survived. Without both numbers, "nothing was
    // injected" cannot be told apart from "nothing was found".
    expect(row.candidateCount).toBe(37);
    expect(row.selectedNodeCount).toBe(2);
    expect(row.stitchedRelationCount).toBe(0);
    expect(row.intent).toBe("debug_prior_failure");
  });

  it("attributes the injection to the path that produced it", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 60,
      plannerSource: "fast",
      plannerAttempted: false,
      memoryNodeCount: 1,
      injectedChars: 900,
      queryCount: 4,
      failureLookupCount: 6,
      failureHits: 2,
      decisionHits: 0,
      messageHits: 3,
    });

    const [row] = await retrievalEvents();
    expect(row.failureHits).toBe(2);
    expect(row.decisionHits).toBe(0);
    expect(row.messageHits).toBe(3);
    expect(row.failureLookupCount).toBe(6);
  });

  it("records which nodes were surfaced, so they can be judged later", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 60,
      plannerSource: "smart",
      plannerAttempted: true,
      memoryNodeCount: 2,
      injectedChars: 500,
      surfacedNodeIds: ["failure-1-12", "decision-abc"],
    });

    const [row] = await retrievalEvents();
    expect(JSON.parse(row.surfacedNodeIds)).toEqual([
      "failure-1-12",
      "decision-abc",
    ]);
  });

  it("leaves the funnel null rather than zero when it was not measured", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordRetrieval({
      sessionId: "s1",
      promptLength: 10,
      plannerSource: "fast",
      plannerAttempted: false,
      memoryNodeCount: 0,
      injectedChars: 0,
    });

    const [row] = await retrievalEvents();
    // A dashboard averaging these must not count an unmeasured call as a zero.
    expect(row.candidateCount).toBeNull();
    expect(row.failureHits).toBeNull();
    expect(row.surfacedNodeIds).toBeNull();
  });

  it("never fails a retrieval because telemetry could not be written", async () => {
    const store = createMemoryNodeStore(db, {});
    await db.run("DROP TABLE retrieval_events");
    await expect(
      store.recordRetrieval({
        sessionId: "s1",
        promptLength: 10,
        plannerSource: "fast",
        plannerAttempted: false,
        memoryNodeCount: 0,
        injectedChars: 0,
      })
    ).resolves.toBeUndefined();
  });
});
