/**
 * Staleness for tasks.
 *
 * Every other memory kind has a way to leave the active set. A failure is
 * resolved, a decision is superseded, a summary anchor ages out. A task has
 * none: a finished task is simply never mentioned again, so it stays `active`
 * and keeps being recalled as the thing you are currently working on.
 *
 * Measured on a real database before this rule existed: 20 active tasks, the
 * three oldest dated two weeks earlier, two of which had shipped.
 *
 * `stale` rather than `resolved` is deliberate. Nothing in the transcript says
 * whether the task was completed or abandoned, only that nothing has referred
 * to it in a long time, and `resolved` would assert the first.
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
import { MemoryRetrievalEngine } from "../src/memory-retrieval.js";
import { createFastRetrievalPlan } from "../src/retrieval-plan.js";

let dbDir: string;
let db: any;
let memoryStore: MemoryNodeStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-stale-task-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  memoryStore = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const NOW = "2026-04-23T00:00:00.000Z";
const LONG_AGO = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-04-21T00:00:00.000Z";

async function addNode(
  nodeId: string,
  kind: string,
  updatedAt: string,
  extra: { useCount?: number; lastUsedAt?: string; status?: string } = {}
) {
  await memoryStore.upsertNode({
    nodeId,
    kind: kind as any,
    conversationId: 1,
    source: "codememory_mark_requirement",
    sourceId: nodeId,
    content: `[${kind.toUpperCase()}] ${nodeId}`,
  });
  await db.run(
    "UPDATE memory_nodes SET updatedAt = ?, useCount = ?, lastUsedAt = ?, status = ? WHERE nodeId = ?",
    [
      updatedAt,
      extra.useCount ?? 0,
      extra.lastUsedAt ?? null,
      extra.status ?? "active",
      nodeId,
    ]
  );
}

describe("stale task maintenance", () => {
  it("retires an active task nothing has touched in a long time", async () => {
    await addNode("task-old", "task", LONG_AGO);

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).toContain("task-old");
    const node = await memoryStore.getNode("task-old");
    expect(node?.status).toBe("stale");
    // Not `resolved`: nothing here knows whether it was finished.
    expect(node?.status).not.toBe("resolved");
  });

  it("records why it was retired", async () => {
    await addNode("task-old", "task", LONG_AGO);
    await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    const events = await memoryStore.getLifecycleEvents("task-old");
    expect(events[0]?.eventType).toBe("stale_node");
    expect(events[0]?.reason).toContain("active task untouched");
  });

  it("leaves a recent task alone", async () => {
    await addNode("task-recent", "task", RECENT);

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).not.toContain("task-recent");
    expect((await memoryStore.getNode("task-recent"))?.status).toBe("active");
  });

  it("keeps an old task that is still being recalled and used", async () => {
    // A long-running goal that retrieval keeps surfacing is still current,
    // however old the node is. lastUsedAt newer than updatedAt is the signal.
    await addNode("task-live", "task", LONG_AGO, {
      useCount: 6,
      lastUsedAt: RECENT,
    });

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).not.toContain("task-live");
    expect((await memoryStore.getNode("task-live"))?.status).toBe("active");
  });

  it("retires a task whose last use is itself long past, however often it was used", async () => {
    // The zombies already in a live database: use counts of 94-116 from the
    // era when every injection counted, and a lastUsedAt that is newer than
    // updatedAt. Once injections stop counting, lastUsedAt freezes -- but it
    // stays newer than updatedAt forever, so "not used since its last update"
    // never becomes true and these tasks would never leave. Untouched has to
    // mean neither updated nor used within the window.
    const MONTH_AGO = "2026-03-20T00:00:00.000Z";
    await addNode("task-zombie", "task", LONG_AGO, {
      useCount: 116,
      lastUsedAt: MONTH_AGO,
    });

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).toContain("task-zombie");
  });

  it("does not touch an equally old active decision", async () => {
    // Decisions are exempt by design: "why we chose node:sqlite" does not stop
    // being true because nobody mentioned it for a month.
    await addNode("decision-old", "decision", LONG_AGO);
    await addNode("task-old", "task", LONG_AGO);

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).toContain("task-old");
    expect(result.staleNodeIds).not.toContain("decision-old");
    expect((await memoryStore.getNode("decision-old"))?.status).toBe("active");
  });

  it("does not touch an equally old active constraint", async () => {
    await addNode("constraint-old", "constraint", LONG_AGO);

    const result = await memoryStore.runStaleMaintenance({
      now: NOW,
      activeTaskOlderThanDays: 14,
      limit: 10,
    });

    expect(result.staleNodeIds).not.toContain("constraint-old");
  });

  it("defaults to 14 days when the caller sets no policy", async () => {
    await addNode("task-old", "task", LONG_AGO);
    await addNode("task-recent", "task", RECENT);

    const result = await memoryStore.runStaleMaintenance({ now: NOW, limit: 10 });

    expect(result.staleNodeIds).toContain("task-old");
    expect(result.staleNodeIds).not.toContain("task-recent");
  });
});

describe("what counts as using a task", () => {
  // The rule above spares a task that is "still being used", and use was
  // counted every time retrieval injected a node. But the planner adds
  // `kind=task` to nearly every prompt, so an active task is injected on every
  // turn whether or not the prompt has anything to do with it -- and each
  // injection counted as use. The two shipped tasks this rule was written for
  // had use counts of 94 to 116 and never qualified as stale: being a zombie
  // is what kept them alive. Measured after the 0.6.0 install, 1 of 19 active
  // tasks went stale.
  //
  // Use now means the prompt matched the node on something other than its
  // kind: a file, a symbol, a topic, a phrase from its content.
  async function addTask(nodeId: string, topic: string) {
    await memoryStore.upsertNode({
      nodeId,
      kind: "task",
      conversationId: 1,
      source: "codememory_mark_requirement",
      sourceId: nodeId,
      content: `[TASK] ${nodeId}`,
      tags: [
        { tagType: "kind", tagValue: "task", weight: 2.0 },
        { tagType: "topic", tagValue: topic, weight: 1.5 },
      ],
    });
  }

  async function useCount(nodeId: string): Promise<number> {
    const row = await db.get("SELECT useCount FROM memory_nodes WHERE nodeId = ?", nodeId);
    return row.useCount;
  }

  async function ask(prompt: string) {
    const engine = new MemoryRetrievalEngine(memoryStore);
    return engine.retrieve({ plan: createFastRetrievalPlan(prompt), conversationId: 1 });
  }

  it("does not count an injection that matched only the kind", async () => {
    await addTask("task-shipped", "retrieval");

    const result = await ask("当前的任务是什么");
    // Precondition: it was injected. Without this the test passes when
    // retrieval simply finds nothing, which proves nothing about counting.
    expect(result.nodes.map((c) => c.node.nodeId)).toContain("task-shipped");

    expect(await useCount("task-shipped")).toBe(0);
  });

  it("counts an injection the prompt asked for by topic", async () => {
    await addTask("task-live", "retrieval");

    const result = await ask("mon-rag 的检索失败是怎么修的");
    expect(result.nodes.map((c) => c.node.nodeId)).toContain("task-live");

    expect(await useCount("task-live")).toBe(1);
  });

  it("lets a task injected every turn, but never asked for, go stale", async () => {
    await addTask("task-zombie", "retrieval");
    for (let i = 0; i < 5; i++) await ask("当前的任务是什么");
    await db.run("UPDATE memory_nodes SET updatedAt = ? WHERE nodeId = ?", [LONG_AGO, "task-zombie"]);

    const result = await memoryStore.runStaleMaintenance({
      now: new Date().toISOString(),
      activeTaskOlderThanDays: 14,
      limit: 10,
    } as any);

    const row = await db.get("SELECT status FROM memory_nodes WHERE nodeId = ?", "task-zombie");
    expect(row.status).toBe("stale");
    expect(result).toBeDefined();
  });
});
