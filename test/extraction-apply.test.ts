/**
 * Writing what a compaction call extracted.
 *
 * Mem0's four operations map onto this store's existing lifecycle rather than
 * onto deletes: nothing is removed, a retired memory keeps its row and gains a
 * lifecycle event. A wrong retirement is then visible and reversible, which is
 * the only reason it is safe to let a model trigger one at all.
 *
 *   ADD         → a new node
 *   UPDATE      → a new node that supersedes the target (history stays)
 *   INVALIDATE  → the target is retired: decisions superseded, tasks and
 *                 constraints stale, because "nobody referred to it again" is
 *                 all the evidence a window can supply for those
 *   NOOP        → nothing, filtered out before this point
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import { applyExtractedMemories } from "../src/compaction/extraction-apply.js";

let dbDir: string;
let db: any;
let store: MemoryNodeStore;
const CONV = 1;

async function seedTask(nodeId: string, content: string) {
  await store.upsertNode({
    nodeId,
    kind: "task" as any,
    conversationId: CONV,
    source: "codememory_mark_requirement",
    sourceId: nodeId,
    content,
  });
  return nodeId;
}

async function statusOf(nodeId: string) {
  return (await db.get("SELECT status FROM memory_nodes WHERE nodeId = ?", nodeId))?.status;
}

async function nodesOfKind(kind: string) {
  return db.all("SELECT * FROM memory_nodes WHERE kind = ? ORDER BY createdAt ASC", kind);
}

const apply = (memories: any[], created?: string) =>
  applyExtractedMemories(store, {
    conversationId: CONV,
    sessionId: "sess-x",
    summaryId: created ?? "leaf-1-x",
    memories,
  });

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-apply-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = createMemoryNodeStore(db);
  await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-x')");
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ADD", () => {
  it("creates a node of the reported kind in this conversation", async () => {
    const result = await apply([
      { kind: "decision", op: "ADD", text: "Ride the compaction call", reason: "no new calls" },
    ]);

    const decisions = await nodesOfKind("decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].conversationId).toBe(CONV);
    expect(decisions[0].content).toContain("Ride the compaction call");
    expect(result.counts.added).toBe(1);
  });

  it("creates tasks and constraints too", async () => {
    await apply([
      { kind: "task", op: "ADD", text: "Wire extraction into compaction" },
      { kind: "constraint", op: "ADD", text: "No native dependencies" },
    ]);

    expect(await nodesOfKind("task")).toHaveLength(1);
    expect(await nodesOfKind("constraint")).toHaveLength(1);
  });

  it("records the summary it came from, so a claim can be traced back", async () => {
    await apply([{ kind: "decision", op: "ADD", text: "Titles only" }]);
    const [node] = await nodesOfKind("decision");
    expect(JSON.stringify(node.metadata)).toContain("leaf-1-x");
  });
});

describe("INVALIDATE", () => {
  it("retires a task as stale, not resolved", async () => {
    // The window shows nobody referred to it again; it does not show the task
    // succeeded. `resolved` would assert the second.
    const target = await seedTask("task-1-10", "[TASK] Add sourceUuid column");

    const result = await apply([
      { kind: "task", op: "INVALIDATE", targetNodeId: target, reason: "merged in #22" },
    ]);

    expect(await statusOf(target)).toBe("stale");
    expect(result.counts.invalidated).toBe(1);
  });

  it("retires a decision as superseded", async () => {
    await store.upsertNode({
      nodeId: "decision-1-20",
      kind: "decision" as any,
      conversationId: CONV,
      source: "codememory_mark_decision",
      sourceId: "decision-1-20",
      content: "[DECISION] Use a vector store",
    });

    await apply([
      { kind: "decision", op: "INVALIDATE", targetNodeId: "decision-1-20", reason: "replaced" },
    ]);

    expect(await statusOf("decision-1-20")).toBe("superseded");
  });

  it("leaves a lifecycle event behind so the retirement can be undone", async () => {
    const target = await seedTask("task-1-10", "[TASK] Something");
    await apply([{ kind: "task", op: "INVALIDATE", targetNodeId: target, reason: "done" }]);

    const events = await db.all(
      "SELECT * FROM memory_lifecycle_events WHERE nodeId = ?",
      target
    );
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain("done");
  });

  it("does nothing when the target belongs to another conversation", async () => {
    // The candidate list already scopes this, but a write path that trusts its
    // caller is one refactor away from a cross-session retirement.
    await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (2, 'sess-other')");
    await store.upsertNode({
      nodeId: "task-2-10",
      kind: "task" as any,
      conversationId: 2,
      source: "codememory_mark_requirement",
      sourceId: "task-2-10",
      content: "[TASK] Another session's",
    });

    const result = await apply([
      { kind: "task", op: "INVALIDATE", targetNodeId: "task-2-10", reason: "not mine" },
    ]);

    expect(await statusOf("task-2-10")).toBe("active");
    expect(result.counts.invalidated).toBe(0);
    expect(result.counts.skipped).toBe(1);
  });
});

describe("UPDATE", () => {
  it("adds the new statement and retires the one it replaces", async () => {
    const target = await seedTask("task-1-10", "[TASK] Ship extraction");

    const result = await apply([
      { kind: "task", op: "UPDATE", targetNodeId: target, text: "Ship extraction behind a flag" },
    ]);

    const tasks = await nodesOfKind("task");
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t: any) => t.content.includes("behind a flag"))).toBe(true);
    expect(await statusOf(target)).toBe("stale");
    expect(result.counts.updated).toBe(1);
  });
});

describe("revises: an earlier memory named in words", () => {
  it("retires a node this same batch created", async () => {
    // The case the candidate list cannot cover: both statements come from one
    // window, so the first does not exist yet when the list is built.
    const result = await apply([
      { kind: "decision", op: "ADD", text: "Send 200 characters per candidate" },
      {
        kind: "decision",
        op: "ADD",
        text: "Send titles only",
        revises: "Send 200 characters per candidate",
      },
    ]);

    const decisions = await nodesOfKind("decision");
    const first = decisions.find((d: any) => d.content.includes("200 characters"));
    expect(first.status).toBe("superseded");
    expect(result.counts.revisedInBatch).toBe(1);
  });

  it("adds without retiring anything when the text matches nothing", async () => {
    const result = await apply([
      { kind: "task", op: "ADD", text: "New task", revises: "something never recorded" },
    ]);

    expect(await nodesOfKind("task")).toHaveLength(1);
    expect(result.counts.revisedInBatch).toBe(0);
  });
});
