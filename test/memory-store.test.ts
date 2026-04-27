import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createFastRetrievalPlan } from "../src/retrieval-plan.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";

let dbDir: string;
let db: any;
let memoryStore: MemoryNodeStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-memory-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  memoryStore = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("MemoryNodeStore", () => {
  it("matches Memory Nodes by RetrievalPlan tags and prefers current conversation", async () => {
    await memoryStore.upsertNode({
      nodeId: "decision-1",
      kind: "decision",
      conversationId: 2,
      source: "test",
      sourceId: "1",
      content: "[DECISION] Keep login validation in src/auth/login.ts",
      tags: [
        { tagType: "kind", tagValue: "decision", weight: 2 },
        { tagType: "file", tagValue: "src/auth/login.ts", weight: 2 },
        { tagType: "topic", tagValue: "auth", weight: 1 },
      ],
    });
    await memoryStore.upsertNode({
      nodeId: "decision-2",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "2",
      content: "[DECISION] Older auth choice",
      tags: [
        { tagType: "kind", tagValue: "decision", weight: 2 },
        { tagType: "file", tagValue: "src/auth/login.ts", weight: 2 },
        { tagType: "topic", tagValue: "auth", weight: 1 },
      ],
    });

    const plan = createFastRetrievalPlan("之前 src/auth/login.ts 的决策是什么");
    const results = await memoryStore.searchByPlan(plan, { conversationId: 2 });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].node.nodeId).toBe("decision-1");
    expect(results[0].matchedTags.some((tag) => tag.tagType === "file")).toBe(true);
  });

  it("creates task / constraint nodes and prioritizes them for continuation prompts", async () => {
    const taskNode = await memoryStore.createTaskNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 11,
      task: "Complete the login refactor in src/auth/login.ts",
      details: "Keep the handler shape stable while moving validation into shared code.",
      acceptanceCriteria: ["npm test passes", "login handler response shape stays unchanged"],
    });
    const constraintNode = await memoryStore.createConstraintNode({
      conversationId: 1,
      sessionId: "sess-A",
      messageId: 12,
      constraint: "Do not change the public login response contract",
      details: "Clients still expect the current JSON payload.",
      acceptanceCriteria: ["status code semantics remain the same"],
    });

    expect(taskNode.kind).toBe("task");
    expect(constraintNode.kind).toBe("constraint");

    const plan = createFastRetrievalPlan("继续下一步，别改坏 login 的返回");
    const results = await memoryStore.searchByPlan(plan, { conversationId: 1, limit: 4 });

    expect(results.map((result) => result.node.nodeId)).toEqual(
      expect.arrayContaining([taskNode.nodeId, constraintNode.nodeId])
    );
    expect(results[0].node.kind === "task" || results[0].node.kind === "constraint").toBe(true);

    const constraintTags = await memoryStore.getTags(constraintNode.nodeId);
    expect(constraintTags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "kind", tagValue: "constraint" }),
        expect.objectContaining({ tagType: "topic", tagValue: "auth" }),
      ])
    );
  });

  it("creates failure nodes directly and resolves them by target", async () => {
    const node = await memoryStore.createFailureNode({
      conversationId: 1,
      sessionId: "sess-A",
      seq: 3,
      type: "test_fail",
      signature: "AssertionError expected 200",
      raw: "AssertionError: expected 200, got 500",
      filePath: "src/auth/login.ts",
      command: "npm test",
      weight: 1,
    });
    expect(node.kind).toBe("failure");

    const plan = createFastRetrievalPlan(
      "请修改 src/auth/login.ts 并重新跑 npm test, 之前失败过"
    );
    const results = await memoryStore.searchByPlan(plan, { conversationId: 1 });
    expect(results[0].node.nodeId).toBe(node.nodeId);

    const resolvedCount = await memoryStore.resolveFailureNodesByTarget({
      conversationId: 1,
      target: { filePath: "src/auth/login.ts", command: "npm test" },
      resolution: "fixed by updating login handler",
    });
    expect(resolvedCount).toBe(1);

    const updated = await memoryStore.getNode(node.nodeId);
    expect(updated?.status).toBe("resolved");
    expect(updated?.metadata.resolution).toBe("fixed by updating login handler");
    const tags = await memoryStore.getTags(node.nodeId);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "status", tagValue: "resolved" }),
      ])
    );
    const events = await memoryStore.getLifecycleEvents(node.nodeId);
    expect(events[0]).toEqual(
      expect.objectContaining({
        fromStatus: "active",
        toStatus: "resolved",
        eventType: "resolve_failure",
        reason: "fixed by updating login handler",
      })
    );
  });

  it("indexes only the semantic command prefix, not the full command or overly broad heads", async () => {
    const buildAttempt = await memoryStore.createFixAttemptNode({
      attemptId: "go-build",
      conversationId: 1,
      outcome: "failed",
      touchedFiles: ["cmd/api/main.go"],
      commandsRun: ["go build ./cmd/api"],
    });
    await memoryStore.createFixAttemptNode({
      attemptId: "go-test",
      conversationId: 1,
      outcome: "failed",
      touchedFiles: ["cmd/api/main_test.go"],
      commandsRun: ["go test ./..."],
    });

    const buildTags = await memoryStore.getTags(buildAttempt.nodeId);
    const commandTags = buildTags.filter((tag) => tag.tagType === "command");
    expect(commandTags).toEqual([
      expect.objectContaining({ tagType: "command", tagValue: "go build" }),
    ]);
    expect(commandTags.some((tag) => tag.tagValue === "go")).toBe(false);
    expect(
      commandTags.some((tag) => tag.tagValue === "go build ./cmd/api")
    ).toBe(false);

    const results = await memoryStore.searchByPlan(
      createFastRetrievalPlan("go build ./cmd/api 失败了"),
      { conversationId: 1, limit: 10 }
    );
    const unrelated = results.find((result) => result.node.nodeId === "fix-attempt-go-test");

    expect(results[0]?.node.nodeId).toBe("fix-attempt-go-build");
    expect(
      unrelated?.matchedTags.some((tag) => tag.tagType === "command")
    ).toBe(false);
  });

  it("indexes summary anchors with a summary_anchor tag while keeping summary kind compatibility", async () => {
    const node = await memoryStore.createSummaryNode({
      summaryId: "leaf-1",
      conversationId: 1,
      kind: "leaf",
      depth: 0,
      earliestAt: "2026-04-22T00:00:00.000Z",
      latestAt: "2026-04-22T00:01:00.000Z",
      descendantCount: 3,
      content:
        "Root cause: src/auth/login.ts failed because the auth token was not refreshed.",
      tokenCount: 20,
      createdAt: "2026-04-22T00:02:00.000Z",
    });

    expect(node.kind).toBe("summary");
    expect(node.metadata.anchorType).toBe("summary_anchor");

    const tags = await memoryStore.getTags(node.nodeId);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "kind", tagValue: "summary_anchor" }),
        expect.objectContaining({
          tagType: "file",
          tagValue: expect.stringMatching(/^[0-9a-f]{8}:src\/auth\/login\.ts$/),
        }),
      ])
    );
    const relations = await memoryStore.getRelationsForNode(node.nodeId, "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: node.nodeId,
          toNodeId: "leaf-1",
          relationType: "derivedFromSummary",
          evidenceSummaryId: "leaf-1",
        }),
      ])
    );

    const plan = createFastRetrievalPlan("之前 src/auth/login.ts 的根因是什么");
    const results = await memoryStore.searchByPlan(plan, { conversationId: 1 });
    expect(results.some((result) => result.node.nodeId === "summary-leaf-1")).toBe(true);
  });

  it("supersedes decisions through explicit node anchors and writes lifecycle records", async () => {
    await memoryStore.upsertNode({
      nodeId: "decision-old",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "old",
      content: "[DECISION] Keep auth validation in the route handler",
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "decision-new",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "new",
      content: "[DECISION] Move auth validation into the shared validator",
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });

    const ok = await memoryStore.supersedeDecision({
      oldNodeId: "decision-old",
      newNodeId: "decision-new",
      reason: "validation moved to shared layer",
      evidenceMessageId: 42,
    });

    expect(ok).toBe(true);
    const oldNode = await memoryStore.getNode("decision-old");
    const newNode = await memoryStore.getNode("decision-new");
    expect(oldNode?.status).toBe("superseded");
    expect(oldNode?.metadata.supersededBy).toBe("decision-new");
    expect(newNode?.supersedesNodeId).toBe("decision-old");

    const tags = await memoryStore.getTags("decision-old");
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "status", tagValue: "superseded" }),
      ])
    );

    const relations = await memoryStore.getRelationsForNode("decision-new", "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "decision-new",
          toNodeId: "decision-old",
          relationType: "supersedes",
          evidenceMessageId: 42,
        }),
      ])
    );

    const events = await memoryStore.getLifecycleEvents("decision-old");
    expect(events[0]).toEqual(
      expect.objectContaining({
        fromStatus: "active",
        toStatus: "superseded",
        eventType: "supersede_decision",
        reason: "validation moved to shared layer",
        evidenceMessageId: 42,
      })
    );
  });

  it("batches relation lookups for multiple nodes without dropping per-node grouping", async () => {
    await memoryStore.upsertNode({
      nodeId: "task-batch",
      kind: "task",
      conversationId: 1,
      source: "test",
      sourceId: "task-batch",
      content: "[TASK] Continue auth refactor",
      tags: [{ tagType: "kind", tagValue: "task", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "decision-batch",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-batch",
      content: "[DECISION] Use the shared validator",
      tags: [{ tagType: "kind", tagValue: "decision", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "failure-batch",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-batch",
      content: "[FAILURE] stale token still broke the login flow",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.addRelation({
      fromNodeId: "task-batch",
      toNodeId: "decision-batch",
      relationType: "relatedTo",
      confidence: 0.92,
    });
    await memoryStore.addRelation({
      fromNodeId: "decision-batch",
      toNodeId: "failure-batch",
      relationType: "relatedTo",
      confidence: 0.88,
    });

    const relations = await memoryStore.getRelationsForNodes(
      ["task-batch", "decision-batch"],
      "both"
    );

    expect(relations.get("task-batch")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "task-batch",
          toNodeId: "decision-batch",
          relationType: "relatedTo",
        }),
      ])
    );
    expect(relations.get("decision-batch")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "task-batch",
          toNodeId: "decision-batch",
          relationType: "relatedTo",
        }),
        expect.objectContaining({
          fromNodeId: "decision-batch",
          toNodeId: "failure-batch",
          relationType: "relatedTo",
        }),
      ])
    );
  });

  it("applies or dismisses pending updates through explicit node anchors", async () => {
    await memoryStore.upsertNode({
      nodeId: "failure-pending-a",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "pending-a",
      content: "[FAILURE] src/auth/login.ts failed",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await memoryStore.upsertNode({
      nodeId: "failure-pending-b",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "pending-b",
      content: "[FAILURE] src/auth/login.ts also failed",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });

    const pending = await memoryStore.addPendingUpdate({
      transition: "resolve_failure",
      eventType: "resolve_failure_after_fix_attempt",
      targetCandidates: [
        { nodeId: "failure-pending-a", score: 4.2 },
        { nodeId: "failure-pending-b", score: 4.1 },
      ],
      fromStatus: "active",
      toStatus: "resolved",
      confidence: 0.72,
      reason: "ambiguous matched failures",
      evidenceMessageId: 77,
      metadata: { fixAttemptNodeId: "fix-attempt-77" },
    });

    const ambiguous = await memoryStore.applyPendingUpdate({
      pendingId: pending.pendingId,
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reason).toMatch(/multiple target candidates/);

    const applied = await memoryStore.applyPendingUpdate({
      pendingId: pending.pendingId,
      targetNodeId: "failure-pending-a",
      reason: "reviewed candidate evidence",
    });
    expect(applied.ok).toBe(true);
    expect(applied.node?.status).toBe("resolved");
    expect(applied.pending?.status).toBe("applied");

    const events = await memoryStore.getLifecycleEvents("failure-pending-a");
    expect(events[0]).toEqual(
      expect.objectContaining({
        eventType: "resolve_failure_after_fix_attempt",
        toStatus: "resolved",
        reason: "reviewed candidate evidence",
        evidenceMessageId: 77,
      })
    );
    expect(events[0].metadata).toEqual(
      expect.objectContaining({
        pendingUpdateId: pending.pendingId,
        fixAttemptNodeId: "fix-attempt-77",
      })
    );

    const dismissible = await memoryStore.addPendingUpdate({
      transition: "resolve_failure",
      eventType: "resolve_failure_after_fix_attempt",
      targetNodeId: "failure-pending-b",
      fromStatus: "active",
      toStatus: "resolved",
      confidence: 0.68,
      reason: "weak match",
    });
    const dismissed = await memoryStore.dismissPendingUpdate({
      pendingId: dismissible.pendingId,
      reason: "wrong failure",
    });

    expect(dismissed.ok).toBe(true);
    expect(dismissed.pending?.status).toBe("dismissed");
    expect(dismissed.pending?.metadata.dismissedReason).toBe("wrong failure");
    expect((await memoryStore.getNode("failure-pending-b"))?.status).toBe("active");
  });

  it("marks old low-use summary anchors stale during maintenance", async () => {
    await memoryStore.upsertNode({
      nodeId: "summary-old",
      kind: "summary",
      conversationId: 1,
      source: "summary_dag",
      sourceId: "leaf-old",
      summaryId: "leaf-old",
      content: "Root cause: old stale summary",
      tags: [{ tagType: "kind", tagValue: "summary_anchor", weight: 2 }],
    });
    await db.run(
      "UPDATE memory_nodes SET updatedAt = ? WHERE nodeId = ?",
      ["2026-01-01T00:00:00.000Z", "summary-old"]
    );

    const result = await memoryStore.runStaleMaintenance({
      now: "2026-04-23T00:00:00.000Z",
      summaryOlderThanDays: 10,
      limit: 10,
    });

    expect(result.staleNodeIds).toEqual(["summary-old"]);
    const summary = await memoryStore.getNode("summary-old");
    expect(summary?.status).toBe("stale");
    const events = await memoryStore.getLifecycleEvents("summary-old");
    expect(events[0]?.eventType).toBe("stale_summary");
  });

  it("falls back to content/queryVariant matching when tags are sparse", async () => {
    await memoryStore.upsertNode({
      nodeId: "decision-content-only",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "content-only",
      content:
        "[DECISION] GraphQL cache invalidation stays close to the mutation resolver.",
      tags: [],
    });

    const plan = createFastRetrievalPlan(
      "之前 GraphQL cache invalidation 为什么这么决定"
    );
    const results = await memoryStore.searchByPlan(plan, { conversationId: 1 });

    expect(results.map((result) => result.node.nodeId)).toContain(
      "decision-content-only"
    );
    const hit = results.find((result) => result.node.nodeId === "decision-content-only");
    expect(hit?.matchedTags.some((tag) => tag.tagType === "text")).toBe(true);
  });

  it("rejects empty or evidence-free nodes and bounds oversized content", async () => {
    await expect(
      memoryStore.upsertNode({
        nodeId: "empty",
        kind: "decision",
        source: "test",
        sourceId: "1",
        content: "   ",
      })
    ).rejects.toThrow(/content is required/);

    await expect(
      memoryStore.upsertNode({
        nodeId: "no-evidence",
        kind: "decision",
        source: "test",
        content: "A decision without evidence",
      })
    ).rejects.toThrow(/requires sourceId or summaryId/);

    const longContent = "x".repeat(6500);
    const node = await memoryStore.upsertNode({
      nodeId: "long",
      kind: "decision",
      source: "test",
      sourceId: "long-source",
      content: longContent,
    });

    expect(node.content.length).toBeLessThan(longContent.length);
    expect(node.content).toContain("[memory node content truncated]");
    expect(node.metadata.quality).toEqual({ contentTruncated: true });
  });
});
