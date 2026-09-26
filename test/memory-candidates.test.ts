/**
 * Which existing memories a compaction call is shown.
 *
 * Extraction rides the compaction call, so the model has to be told what this
 * session already knows -- otherwise every extracted item is an ADD and
 * nothing is ever updated or retired. The candidate set is assembled without
 * an LLM, from three sources:
 *
 *   A  what prompt-time retrieval already surfaced in this window. Measured on
 *      a live database: median 5 nodes per turn, and 86% of them (658/762) are
 *      decisions, tasks or constraints -- exactly the kinds this needs. A node
 *      the model never saw is one this window is unlikely to be revising.
 *   B  what was written since the last extraction: the previous window's own
 *      output, and anything a mark skill just stored. Too new to have been
 *      surfaced.
 *   C  a tag scan, for windows with neither: the daemon was down, the rows
 *      came from a re-import, or the turns were a subagent's (no
 *      UserPromptSubmit, so no retrieval event).
 *
 * Lines are titles only. Sending 200 characters of content per candidate cost
 * about 1,000 tokens on every compaction, re-sent each time; titles cost a
 * quarter of that.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import {
  collectCandidateMemories,
  memoryTitle,
} from "../src/compaction/memory-candidates.js";

let dbDir: string;
let db: any;
let store: MemoryNodeStore;

const CONV = 1;

async function addNode(
  nodeId: string,
  kind: "decision" | "task" | "constraint" | "failure",
  content: string,
  opts: { updatedAt?: string; status?: string; tags?: Array<{ tagType: string; tagValue: string }> } = {}
) {
  await store.upsertNode({
    nodeId,
    kind: kind as any,
    conversationId: CONV,
    source: "codememory_mark_requirement",
    sourceId: nodeId,
    content,
    tags: [
      { tagType: "kind", tagValue: kind, weight: 2 },
      ...(opts.tags ?? []).map((t) => ({ ...t, weight: 1.5 })),
    ] as any,
  });
  if (opts.updatedAt || opts.status) {
    await db.run("UPDATE memory_nodes SET updatedAt = COALESCE(?, updatedAt), status = COALESCE(?, status) WHERE nodeId = ?", [
      opts.updatedAt ?? null,
      opts.status ?? null,
      nodeId,
    ]);
  }
}

async function addRetrievalEvent(nodeIds: string[], createdAt: string) {
  await store.recordRetrieval({
    conversationId: CONV,
    sessionId: "sess-c",
    promptLength: 10,
    plannerSource: "fast",
    plannerAttempted: false,
    memoryNodeCount: nodeIds.length,
    injectedChars: 100,
    surfacedNodeIds: nodeIds,
  });
  await db.run(
    "UPDATE retrieval_events SET createdAt = ? WHERE eventId = (SELECT MAX(eventId) FROM retrieval_events)",
    createdAt
  );
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-cand-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = createMemoryNodeStore(db);
  await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-c')");
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const WINDOW = { from: "2026-09-20T00:00:00.000Z", to: "2026-09-20T01:00:00.000Z" };

function collect(extra: Record<string, unknown> = {}) {
  return collectCandidateMemories(db, {
    conversationId: CONV,
    windowFrom: WINDOW.from,
    windowTo: WINDOW.to,
    writtenSince: "2026-09-19T00:00:00.000Z",
    anchors: { files: [], commands: [], symbols: [], topics: [] },
    budgetChars: 2000,
    ...extra,
  });
}

describe("source A: what the window already surfaced", () => {
  it("takes the nodes prompt-time retrieval showed in this window", async () => {
    await addNode("decision-seen", "decision", "[DECISION] Use tool_use_id", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await addNode("decision-unseen", "decision", "[DECISION] Something else", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await addRetrievalEvent(["decision-seen"], "2026-09-20T00:30:00.000Z");

    const result = await collect();

    expect(result.items.map((i) => i.nodeId)).toEqual(["decision-seen"]);
    expect(result.counts.fromSurfaced).toBe(1);
  });

  it("ignores retrieval from outside the window", async () => {
    await addNode("decision-old", "decision", "[DECISION] Old", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await addRetrievalEvent(["decision-old"], "2026-09-19T12:00:00.000Z");

    expect((await collect()).items).toEqual([]);
  });
});

describe("source B: written since the last extraction", () => {
  it("includes a node no retrieval has had time to surface", async () => {
    await addNode("task-fresh", "task", "[TASK] Wire up the extractor", {
      updatedAt: "2026-09-20T00:10:00.000Z",
    });

    const result = await collect();

    expect(result.items.map((i) => i.nodeId)).toEqual(["task-fresh"]);
    expect(result.counts.fromRecentWrites).toBe(1);
  });

  it("puts a freshly written node ahead of a merely surfaced one", async () => {
    await addNode("decision-seen", "decision", "[DECISION] Seen", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await addNode("task-fresh", "task", "[TASK] Fresh", {
      updatedAt: "2026-09-20T00:10:00.000Z",
    });
    await addRetrievalEvent(["decision-seen"], "2026-09-20T00:30:00.000Z");

    const result = await collect();

    expect(result.items[0].nodeId).toBe("task-fresh");
  });
});

describe("source C: the fallback scan", () => {
  it("matches on an anchor when nothing was surfaced or freshly written", async () => {
    await addNode("constraint-node", "constraint", "[CONSTRAINT] Node >= 22", {
      updatedAt: "2026-09-01T00:00:00.000Z",
      tags: [{ tagType: "symbol", tagValue: "spawnWithStdin" }],
    });
    await addNode("decision-other", "decision", "[DECISION] Unrelated", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });

    const result = await collect({
      anchors: { files: [], commands: [], symbols: ["spawnWithStdin"], topics: [] },
    });

    expect(result.items.map((i) => i.nodeId)).toEqual(["constraint-node"]);
    expect(result.counts.fromTagScan).toBe(1);
  });

  it("is not used when A or B produced anything", async () => {
    await addNode("task-fresh", "task", "[TASK] Fresh", {
      updatedAt: "2026-09-20T00:10:00.000Z",
    });
    await addNode("constraint-node", "constraint", "[CONSTRAINT] Node >= 22", {
      updatedAt: "2026-09-01T00:00:00.000Z",
      tags: [{ tagType: "symbol", tagValue: "spawnWithStdin" }],
    });

    const result = await collect({
      anchors: { files: [], commands: [], symbols: ["spawnWithStdin"], topics: [] },
    });

    expect(result.items.map((i) => i.nodeId)).toEqual(["task-fresh"]);
    expect(result.counts.fromTagScan).toBe(0);
  });
});

describe("what never becomes a candidate", () => {
  it("leaves out other kinds, which are produced deterministically", async () => {
    await addNode("failure-x", "failure", "[FAILURE] TS2322", {
      updatedAt: "2026-09-20T00:10:00.000Z",
    });

    expect((await collect()).items).toEqual([]);
  });

  it("leaves out nodes that are no longer active", async () => {
    await addNode("task-done", "task", "[TASK] Already retired", {
      updatedAt: "2026-09-20T00:10:00.000Z",
      status: "stale",
    });

    expect((await collect()).items).toEqual([]);
  });

  it("leaves out a retired node even when the window surfaced it", async () => {
    // Retrieval surfaces `resolved` nodes too, and a window can surface one
    // that was retired since. Source A needs its own status filter; the one
    // on the recent-writes query does not cover it.
    await addNode("task-retired", "task", "[TASK] Retired but still shown", {
      updatedAt: "2026-09-01T00:00:00.000Z",
      status: "stale",
    });
    await addRetrievalEvent(["task-retired"], "2026-09-20T00:30:00.000Z");

    expect((await collect()).items).toEqual([]);
  });

  it("leaves out another conversation's nodes", async () => {
    await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (2, 'sess-other')");
    await store.upsertNode({
      nodeId: "decision-other-conv",
      kind: "decision" as any,
      conversationId: 2,
      source: "codememory_mark_decision",
      sourceId: "decision-other-conv",
      content: "[DECISION] Another session's",
    });
    await db.run("UPDATE memory_nodes SET updatedAt = ? WHERE nodeId = ?", [
      "2026-09-20T00:10:00.000Z",
      "decision-other-conv",
    ]);

    expect((await collect()).items).toEqual([]);
  });
});

describe("the budget", () => {
  it("drops the lowest-ranked candidates and reports how many", async () => {
    for (let i = 0; i < 40; i++) {
      await addNode(`task-${i}`, "task", `[TASK] ${"长任务描述 ".repeat(20)} ${i}`, {
        updatedAt: `2026-09-20T00:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }

    const result = await collect({ budgetChars: 600 });

    expect(result.rendered.length).toBeLessThanOrEqual(600);
    expect(result.counts.dropped).toBeGreaterThan(0);
    expect(result.items.length + result.counts.dropped).toBe(40);
  });
});

describe("the title of a memory", () => {
  it("drops the kind prefix and stops at the details", () => {
    expect(
      memoryTitle(
        "[CONSTRAINT] Never introduce native dependencies Details: Claude Code installs with --ignore-scripts"
      )
    ).toBe("Never introduce native dependencies");
  });

  it("stops at the first sentence when there is no details marker", () => {
    expect(memoryTitle("[DECISION] Use FTS5 instead of a vector store. It needs no native build.")).toBe(
      "Use FTS5 instead of a vector store"
    );
  });

  it("caps a long single sentence", () => {
    const title = memoryTitle("[TASK] " + "任务描述 ".repeat(60));
    expect(title.length).toBeLessThanOrEqual(121);
  });
});
