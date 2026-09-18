/**
 * Session isolation.
 *
 * Memory recall had no conversation boundary. `conversationId` reached the
 * scoring function as a +0.2 bonus, which changes the order of results but not
 * which results exist, so one session could surface nodes another produced.
 *
 * Measured on a live database before this changed: 123 of 263 surfaced nodes,
 * 46.8%, came from a different session.
 *
 * The product rule these tests encode: a session recalls only what it produced.
 * Promoting durable knowledge across sessions is a separate, later step with a
 * human in the loop; until then, wrong context costs more than missing context.
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
import { createFastRetrievalPlan } from "../src/retrieval-plan.js";

let dbDir: string;
let db: any;
let store: MemoryNodeStore;

const MINE = 1;
const THEIRS = 2;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-isolation-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function addDecision(nodeId: string, conversationId: number, text: string) {
  await store.upsertNode({
    nodeId,
    kind: "decision",
    conversationId,
    source: "codememory_mark_decision",
    sourceId: nodeId,
    content: `[DECISION] ${text}`,
    tags: [
      { tagType: "kind", tagValue: "decision", weight: 2 },
      { tagType: "file", tagValue: "shared/config.ts", weight: 2.3 },
    ],
  });
}

/** Built the way production builds it, so the test cannot drift from reality. */
const planFor = (prompt: string) => createFastRetrievalPlan(prompt);

describe("searchByPlan is bounded by conversation", () => {
  it("does not surface a node another session produced", async () => {
    await addDecision("decision-mine", MINE, "use option A");
    await addDecision("decision-theirs", THEIRS, "use option B");

    const found = await store.searchByPlan(
      planFor("shared/config.ts 之前的决策是什么"),
      { conversationId: MINE }
    );

    const ids = found.map((c) => c.node.nodeId);
    expect(ids).toContain("decision-mine");
    expect(ids).not.toContain("decision-theirs");
  });

  it("bounds the content fallback too, not just the tag query", async () => {
    // The content LIKE path is a second query in the same method. Filtering
    // only the tag query would leave a silent hole behind an identical API.
    await addDecision("decision-mine", MINE, "zzsentinelzz applies here");
    await addDecision("decision-theirs", THEIRS, "zzsentinelzz applies here");

    const plan = planFor("zzsentinelzz 之前是怎么决定的");
    // Strip the tag queries so only the content fallback can match.
    plan.tagQueries = [];

    const found = await store.searchByPlan(plan, { conversationId: MINE });
    const ids = found.map((c) => c.node.nodeId);
    expect(ids).not.toContain("decision-theirs");
  });

  it("returns nothing rather than everything when the session is unknown", async () => {
    // Two live rows had a NULL conversationId and surfaced nodes anyway.
    // Falling through to unscoped recall is the failure mode that makes a leak
    // silent, so the unknown case must fail closed.
    await addDecision("decision-mine", MINE, "use option A");
    await addDecision("decision-theirs", THEIRS, "use option B");

    const found = await store.searchByPlan(
      planFor("shared/config.ts 之前的决策是什么"),
      {}
    );
    expect(found).toEqual([]);
  });
});

describe("relation stitching is bounded by conversation", () => {
  it("does not traverse an edge that leaves the conversation", async () => {
    await addDecision("decision-mine", MINE, "use option A");
    await addDecision("decision-theirs", THEIRS, "use option B");
    await store.addRelation({
      fromNodeId: "decision-mine",
      toNodeId: "decision-theirs",
      relationType: "relatedTo",
      confidence: 1,
    });

    const groups = await store.getRelationsForNodes(
      ["decision-mine"],
      "both",
      MINE
    );

    // The edge exists; following it would pull a node from another session
    // into this one's context, which is the leak in a different shape.
    expect(groups.get("decision-mine")).toEqual([]);
  });

  it("still traverses an edge inside the conversation", async () => {
    await addDecision("decision-one", MINE, "use option A");
    await addDecision("decision-two", MINE, "use option A refined");
    await store.addRelation({
      fromNodeId: "decision-two",
      toNodeId: "decision-one",
      relationType: "supersedes",
      confidence: 1,
    });

    const groups = await store.getRelationsForNodes(
      ["decision-two"],
      "both",
      MINE
    );

    expect(groups.get("decision-two")).toHaveLength(1);
  });

  it("traverses nothing when the conversation is unknown", async () => {
    await addDecision("decision-one", MINE, "use option A");
    await addDecision("decision-two", MINE, "use option A refined");
    await store.addRelation({
      fromNodeId: "decision-two",
      toNodeId: "decision-one",
      relationType: "supersedes",
      confidence: 1,
    });

    const groups = await store.getRelationsForNodes(["decision-two"], "both");
    expect(groups.get("decision-two")).toEqual([]);
  });
});
