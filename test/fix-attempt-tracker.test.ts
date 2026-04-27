import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import { LifecycleResolver } from "../src/lifecycle-resolver.js";
import { FixAttemptTracker } from "../src/fix-attempt-tracker.js";
import type { JsonlMessage } from "../src/hooks/jsonl-watcher.js";

let dbDir: string;
let db: any;
let memoryStore: MemoryNodeStore;
let tracker: FixAttemptTracker;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-attempt-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  memoryStore = createMemoryNodeStore(db);
  tracker = new FixAttemptTracker(
    db,
    memoryStore,
    new LifecycleResolver(memoryStore)
  );
  await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')");
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("FixAttemptTracker", () => {
  it("creates a fix_attempt span and resolves the matching failure after successful validation", async () => {
    await memoryStore.upsertNode({
      nodeId: "failure-login",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-login",
      content: "[FAILURE] src/auth/login.ts failed under npm test",
      tags: [
        { tagType: "kind", tagValue: "failure", weight: 2 },
        { tagType: "file", tagValue: "src/auth/login.ts", weight: 2 },
      ],
    });

    await tracker.observeToolUses(editMessage(), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 1,
      messageId: 101,
    });
    await tracker.observeToolUses(bashUseMessage(), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 2,
      messageId: 102,
    });
    await tracker.observeToolResults(bashResultMessage(false), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 3,
      messageId: 103,
    });

    const attempts = await db.all("SELECT * FROM attempt_spans");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("closed");
    expect(attempts[0].outcome).toBe("succeeded");

    const fixNode = await memoryStore.getNode(attempts[0].fixAttemptNodeId);
    expect(fixNode?.kind).toBe("fix_attempt");
    expect(fixNode?.status).toBe("resolved");
    expect(fixNode?.metadata.outcome).toBe("succeeded");

    const failure = await memoryStore.getNode("failure-login");
    expect(failure?.status).toBe("resolved");
    expect(failure?.metadata.resolvedByFixAttempt).toBe(fixNode?.nodeId);

    const relations = await memoryStore.getRelationsForNode(fixNode!.nodeId, "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "resolves",
          toNodeId: "failure-login",
        }),
      ])
    );
  });

  it("marks a fix_attempt as failed and links the new failure as causedBy", async () => {
    await tracker.observeToolUses(editMessage(), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 1,
      messageId: 101,
    });
    await tracker.observeToolUses(bashUseMessage(), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 2,
      messageId: 102,
    });
    await memoryStore.upsertNode({
      nodeId: "failure-new",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-new",
      content: "[FAILURE] npm test still fails",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });

    await tracker.observeToolResults(bashResultMessage(true), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 3,
      messageId: 103,
      failureNodeIds: ["failure-new"],
    });

    const attempts = await db.all("SELECT * FROM attempt_spans");
    expect(attempts[0].outcome).toBe("failed");
    const fixNode = await memoryStore.getNode(attempts[0].fixAttemptNodeId);
    expect(fixNode?.status).toBe("active");
    expect(fixNode?.metadata.outcome).toBe("failed");

    const relations = await memoryStore.getRelationsForNode("failure-new", "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "causedBy",
          toNodeId: fixNode?.nodeId,
        }),
      ])
    );
  });

  it("keeps collecting nearby validation commands and marks mixed results as partial", async () => {
    await memoryStore.upsertNode({
      nodeId: "failure-login",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-login",
      content: "[FAILURE] src/auth/login.ts failed under npm test",
      tags: [
        { tagType: "kind", tagValue: "failure", weight: 2 },
        { tagType: "file", tagValue: "src/auth/login.ts", weight: 2 },
      ],
    });

    await tracker.observeToolUses(editMessage(), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 1,
      messageId: 101,
    });
    await tracker.observeToolUses(bashUseMessage("bash-test", "npm test"), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 2,
      messageId: 102,
    });
    await tracker.observeToolResults(bashResultMessage("bash-test", false), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 3,
      messageId: 103,
    });
    expect((await memoryStore.getNode("failure-login"))?.status).toBe("resolved");

    await tracker.observeToolUses(bashUseMessage("bash-build", "npm run build"), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 4,
      messageId: 104,
    });
    await memoryStore.upsertNode({
      nodeId: "failure-build",
      kind: "failure",
      conversationId: 1,
      source: "test",
      sourceId: "failure-build",
      content: "[FAILURE] npm run build failed",
      tags: [{ tagType: "kind", tagValue: "failure", weight: 2 }],
    });
    await tracker.observeToolResults(bashResultMessage("bash-build", true), {
      conversationId: 1,
      sessionId: "sess-A",
      seq: 5,
      messageId: 105,
      failureNodeIds: ["failure-build"],
    });

    const attempts = await db.all("SELECT * FROM attempt_spans");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("closed");
    expect(attempts[0].outcome).toBe("partial");
    expect(JSON.parse(attempts[0].commandsRun)).toEqual(
      expect.arrayContaining(["npm test", "npm run build"])
    );

    const fixNode = await memoryStore.getNode(attempts[0].fixAttemptNodeId);
    expect(fixNode?.status).toBe("active");
    expect(fixNode?.metadata.outcome).toBe("partial");
    expect((fixNode?.metadata.validationResults as any[])).toHaveLength(2);

    const reopened = await memoryStore.getNode("failure-login");
    expect(reopened?.status).toBe("active");
    expect(reopened?.metadata.reopened).toBe(true);

    const relations = await memoryStore.getRelationsForNode("failure-build", "from");
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "causedBy",
          toNodeId: fixNode?.nodeId,
        }),
      ])
    );
  });
});

function editMessage(): JsonlMessage {
  return {
    id: "msg-edit",
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: {
      parts: [
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "src/auth/login.ts",
            old_string: "old",
            new_string: "new",
          },
        },
      ],
    },
  };
}

function bashUseMessage(id = "bash-1", command = "npm test"): JsonlMessage {
  return {
    id: `msg-bash-use-${id}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: {
      parts: [
        {
          type: "tool_use",
          id,
          name: "Bash",
          input: { command },
        },
      ],
    },
  };
}

function bashResultMessage(idOrIsError: string | boolean, maybeIsError?: boolean): JsonlMessage {
  const id = typeof idOrIsError === "string" ? idOrIsError : "bash-1";
  const isError = typeof idOrIsError === "boolean" ? idOrIsError : maybeIsError === true;
  return {
    id: `msg-bash-result-${id}`,
    type: "user",
    role: "user",
    content: "",
    timestamp: Date.now(),
    metadata: {
      parts: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: isError ? "Tests: 1 failed" : "Tests: 10 passed",
        },
      ],
    },
  };
}
