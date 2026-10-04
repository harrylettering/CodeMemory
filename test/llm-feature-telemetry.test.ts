/**
 * Telemetry for the two optional LLM-backed features.
 *
 * Both were enabled in settings and neither could be shown to have ever run.
 * Telemetry for the LLM-backed features that remain: retrieval planning and
 * expansion. The decision judge that used to be covered here was retired when
 * compaction-time extraction took over superseding (see the plan's T4.6).
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

const retrievalEvents = () => db.all("SELECT * FROM retrieval_events ORDER BY eventId");


const decision = (store: MemoryNodeStore, text: string, seq: number) =>
  store.createDecisionNode({
    conversationId: 1,
    sessionId: "s1",
    decision: text,
    rationale: "because",
    content: `[DECISION] ${text}\nWhy: because`,
    sourceToolUseId: `toolu_${seq}`,
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
