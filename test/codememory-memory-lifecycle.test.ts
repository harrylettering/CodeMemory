import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { LifecycleResolver } from "../src/lifecycle-resolver.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import { CodeMemoryMemoryLifecycleTool } from "../src/tools/codememory-memory-lifecycle-tool.js";

let dbDir: string;
let db: any;
let memoryStore: MemoryNodeStore;
let tool: CodeMemoryMemoryLifecycleTool;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-memory-lifecycle-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  memoryStore = createMemoryNodeStore(db);
  tool = new CodeMemoryMemoryLifecycleTool(
    memoryStore,
    new LifecycleResolver(memoryStore)
  );
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("CodeMemoryMemoryLifecycleTool", () => {
  it("inspects node state with tags, events, and relations", async () => {
    await memoryStore.upsertNode({
      nodeId: "failure-tool",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-tool",
      content: "[FAILURE] npm test failed",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.updateNodeStatus({
      nodeId: "failure-tool",
      toStatus: "resolved",
      eventType: "resolve_failure",
      reason: "fixed in test",
    });

    const result = await tool.run({
      action: "inspect_node",
      nodeId: "failure-tool",
    });

    expect(result.ok).toBe(true);
    expect(result.node?.status).toBe("resolved");
    expect(result.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "status", tagValue: "resolved" }),
      ])
    );
    expect(result.events?.[0]).toEqual(
      expect.objectContaining({ eventType: "resolve_failure" })
    );
  });

  it("runs stale maintenance through the admin tool", async () => {
    await memoryStore.upsertNode({
      nodeId: "summary-tool-old",
      kind: "summary",
      conversationId: 1,
      source: "summary_dag",
      sourceId: "leaf-tool-old",
      summaryId: "leaf-tool-old",
      content: "Root cause: old summary",
      tags: [{ tagType: "kind", tagValue: "summary_anchor", weight: 2 }],
    });
    await db.run(
      "UPDATE memory_nodes SET updatedAt = ? WHERE nodeId = ?",
      ["2026-01-01T00:00:00.000Z", "summary-tool-old"]
    );

    const result = await tool.run({
      action: "stale_maintenance",
      summaryOlderThanDays: 1,
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.staleNodeIds).toEqual(["summary-tool-old"]);
  });

  it("resolves task nodes and supersedes constraint nodes through lifecycle actions", async () => {
    await memoryStore.upsertNode({
      nodeId: "task-open",
      kind: "task",
      conversationId: 1,
      source: "test",
      sourceId: "task-open",
      content: "[TASK] Finish the auth refactor",
      tags: [{ tagType: "kind", tagValue: "task", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "constraint-old",
      kind: "constraint",
      conversationId: 1,
      source: "test",
      sourceId: "constraint-old",
      content: "[CONSTRAINT] Keep the login response stable",
      tags: [{ tagType: "kind", tagValue: "constraint", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "constraint-new",
      kind: "constraint",
      conversationId: 1,
      source: "test",
      sourceId: "constraint-new",
      content: "[CONSTRAINT] Keep the login response stable and preserve status codes",
      tags: [{ tagType: "kind", tagValue: "constraint", weight: 2 }],
    });

    const resolved = await tool.run({
      action: "resolve_node",
      nodeId: "task-open",
      reason: "auth refactor completed",
    });
    expect(resolved.ok).toBe(true);
    expect((await memoryStore.getNode("task-open"))?.status).toBe("resolved");
    const taskEvents = await memoryStore.getLifecycleEvents("task-open");
    expect(taskEvents[0]).toEqual(
      expect.objectContaining({
        eventType: "resolve_task",
        toStatus: "resolved",
        reason: "auth refactor completed",
      })
    );

    const superseded = await tool.run({
      action: "supersede_node",
      oldNodeId: "constraint-old",
      newNodeId: "constraint-new",
      reason: "narrowed the constraint to include status code semantics",
    });
    expect(superseded.ok).toBe(true);
    expect((await memoryStore.getNode("constraint-old"))?.status).toBe("superseded");
    expect((await memoryStore.getNode("constraint-new"))?.supersedesNodeId).toBe(
      "constraint-old"
    );
    const constraintEvents = await memoryStore.getLifecycleEvents("constraint-old");
    expect(constraintEvents[0]).toEqual(
      expect.objectContaining({
        eventType: "supersede_constraint",
        toStatus: "superseded",
      })
    );
  });
});
