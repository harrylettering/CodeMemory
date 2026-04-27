import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import { LifecycleResolver } from "../src/lifecycle-resolver.js";

let dbDir: string;
let db: any;
let memoryStore: MemoryNodeStore;
let resolver: LifecycleResolver;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-lifecycle-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  memoryStore = createMemoryNodeStore(db);
  resolver = new LifecycleResolver(memoryStore);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("LifecycleResolver", () => {
  it("resolves a single strong active failure match after a succeeded fix attempt", async () => {
    const failureNode = await memoryStore.createFailureNode({
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
    await seedFixAttempt("fix-attempt-1");

    const result = await resolver.resolveFailuresForSucceededAttempt({
      conversationId: 1,
      fixAttemptNodeId: "fix-attempt-1",
      files: ["src/auth/login.ts"],
      commands: ["npm test"],
      evidenceMessageId: 9,
    });

    expect(result.action).toBe("applied");
    expect(result.targetNodeIds).toEqual([failureNode.nodeId]);

    const failure = await memoryStore.getNode(failureNode.nodeId);
    expect(failure?.status).toBe("resolved");
    expect(failure?.metadata.resolvedByFixAttempt).toBe("fix-attempt-1");

    const relations = await memoryStore.getRelationsForNode("fix-attempt-1", "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "resolves",
          toNodeId: failureNode.nodeId,
          evidenceMessageId: 9,
        }),
      ])
    );

    const events = await memoryStore.getLifecycleEvents(failureNode.nodeId);
    expect(events[0]).toEqual(
      expect.objectContaining({
        eventType: "resolve_failure_after_fix_attempt",
        fromStatus: "active",
        toStatus: "resolved",
      })
    );
  });

  it("writes a pending update instead of mutating when failure matches are ambiguous", async () => {
    await seedFailure("failure-login-a", "src/auth/login.ts", 1);
    await seedFailure("failure-login-b", "src/auth/login.ts", 1);
    await seedFixAttempt("fix-attempt-ambiguous");

    const result = await resolver.resolveFailuresForSucceededAttempt({
      conversationId: 1,
      fixAttemptNodeId: "fix-attempt-ambiguous",
      files: ["src/auth/login.ts"],
      commands: ["npm test"],
      evidenceMessageId: 10,
    });

    expect(result.action).toBe("pending");
    expect((await memoryStore.getNode("failure-login-a"))?.status).toBe("active");
    expect((await memoryStore.getNode("failure-login-b"))?.status).toBe("active");

    const pending = await memoryStore.getPendingUpdates();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(
      expect.objectContaining({
        transition: "resolve_failure",
        eventType: "resolve_failure_after_fix_attempt",
        toStatus: "resolved",
        status: "pending",
      })
    );
    expect(pending[0].targetCandidates.map((candidate) => candidate.nodeId)).toEqual(
      expect.arrayContaining(["failure-login-a", "failure-login-b"])
    );
  });

  it("reopens a resolved failure when a matching new failure recurs", async () => {
    const oldFailure = await memoryStore.createFailureNode({
      conversationId: 1,
      sessionId: "sess-A",
      seq: 1,
      type: "test_fail",
      signature: "AssertionError expected 200",
      raw: "AssertionError: expected 200, got 500",
      filePath: "src/auth/login.ts",
      command: "npm test",
      weight: 1,
    });
    await memoryStore.updateNodeStatus({
      nodeId: oldFailure.nodeId,
      toStatus: "resolved",
      eventType: "resolve_failure",
      reason: "fixed earlier",
      metadata: { resolution: "fixed earlier", resolved: true },
      lifecycle: { resolvedBy: "user_signal" },
    });
    expect((await memoryStore.getNode(oldFailure.nodeId))?.status).toBe(
      "resolved"
    );

    const newFailure = await memoryStore.createFailureNode({
      conversationId: 1,
      sessionId: "sess-A",
      seq: 30,
      type: "test_fail",
      signature: "AssertionError expected 200",
      raw: "AssertionError: expected 200, got 500 again",
      filePath: "src/auth/login.ts",
      command: "npm test",
      weight: 1,
    });

    const result = await resolver.reopenFailure({
      conversationId: 1,
      files: ["src/auth/login.ts"],
      commands: ["npm test"],
      signatures: ["AssertionError expected 200"],
      newFailureNodeId: newFailure.nodeId,
      evidenceMessageId: 31,
    });

    expect(result.action).toBe("applied");
    expect(result.targetNodeIds).toEqual([oldFailure.nodeId]);
    const reopened = await memoryStore.getNode(oldFailure.nodeId);
    expect(reopened?.status).toBe("active");
    expect(reopened?.metadata.reopened).toBe(true);

    const relations = await memoryStore.getRelationsForNode(newFailure.nodeId, "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "relatedTo",
          toNodeId: oldFailure.nodeId,
        }),
      ])
    );
  });

  it("marks summary anchors stale through the resolver", async () => {
    await memoryStore.upsertNode({
      nodeId: "summary-leaf-stale",
      kind: "summary",
      conversationId: 1,
      source: "summary_dag",
      sourceId: "leaf-stale",
      summaryId: "leaf-stale",
      content: "Root cause: stale auth summary",
      tags: [{ tagType: "kind", tagValue: "summary_anchor", weight: 2 }],
    });

    const result = await resolver.markSummaryStale({
      nodeId: "summary-leaf-stale",
      reason: "covered by better memory node",
    });

    expect(result.action).toBe("applied");
    const summary = await memoryStore.getNode("summary-leaf-stale");
    expect(summary?.status).toBe("stale");
    const events = await memoryStore.getLifecycleEvents("summary-leaf-stale");
    expect(events[0]).toEqual(
      expect.objectContaining({
        eventType: "stale_summary",
        toStatus: "stale",
        reason: "covered by better memory node",
      })
    );
  });
});

async function seedFailure(nodeId: string, file: string, conversationId: number) {
  await memoryStore.upsertNode({
    nodeId,
    kind: "failure",
    conversationId,
    source: "test",
    sourceId: nodeId,
    content: `[FAILURE] Test failed for ${file}`,
    tags: [
      { tagType: "kind", tagValue: "failure", weight: 2 },
      { tagType: "file", tagValue: file, weight: 2 },
    ],
  });
}

async function seedFixAttempt(nodeId: string) {
  await memoryStore.upsertNode({
    nodeId,
    kind: "fix_attempt",
    conversationId: 1,
    source: "test",
    sourceId: nodeId,
    content: `[FIX_ATTEMPT] ${nodeId}`,
    tags: [{ tagType: "kind", tagValue: "fix_attempt", weight: 2 }],
  });
}
