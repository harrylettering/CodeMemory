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
