/**
 * Tests for `CodeMemoryMarkRequirementTool` — verifies durable tasks / constraints
 * are materialized as Memory Nodes with the right tags, that
 * `sourceToolUseId` provides idempotency, and that supersession links
 * are written correctly.
 *
 * Note: this tool no longer writes to `conversation_messages`. The matching
 * S-tier conversation row is produced by the JSONL watcher when it sees the
 * Skill `tool_use` block.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CodeMemoryMarkRequirementTool } from "../src/tools/codememory-mark-requirement-tool.js";
import {
  createMemoryNodeStore,
  type MemoryNodeStore,
} from "../src/store/memory-store.js";

let dbDir: string;
let db: any;
let store: ConversationStore;
let memoryStore: MemoryNodeStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-requirement-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  memoryStore = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("CodeMemoryMarkRequirementTool", () => {
  it("creates task and constraint Memory Nodes with the expected tags", async () => {
    const tool = new CodeMemoryMarkRequirementTool(
      store,
      () => "sess-A",
      memoryStore
    );

    const task = await tool.mark({
      kind: "task",
      requirement: "Finish the auth refactor in src/auth/login.ts",
      details: "Move validation into the shared validator.",
      acceptance_criteria: ["npm test passes"],
    });
    const constraint = await tool.mark({
      kind: "constraint",
      requirement: "Do not change the login response shape",
      details: "Existing clients depend on the current payload keys.",
    });

    expect(task.ok).toBe(true);
    expect(constraint.ok).toBe(true);

    const taskNode = await memoryStore.getNode(task.memoryNodeId!);
    const constraintNode = await memoryStore.getNode(constraint.memoryNodeId!);
    expect(taskNode?.kind).toBe("task");
    expect(taskNode?.content).toContain("[TASK] Finish the auth refactor");
    expect(taskNode?.content).toContain("Acceptance criteria:");
    expect(constraintNode?.kind).toBe("constraint");
    expect(constraintNode?.content).toContain("[CONSTRAINT] Do not change the login response shape");

    const tags = await memoryStore.getTags(task.memoryNodeId!);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "kind", tagValue: "task" }),
        expect.objectContaining({
          tagType: "file",
          tagValue: expect.stringMatching(/^[0-9a-f]{8}:src\/auth\/login\.ts$/),
        }),
      ])
    );
  });

  it("collapses retries with the same sourceToolUseId onto the same node", async () => {
    const tool = new CodeMemoryMarkRequirementTool(
      store,
      () => "sess-A",
      memoryStore
    );
    const sourceToolUseId = "toolu_req_01";

    const first = await tool.mark({
      kind: "task",
      requirement: "Finish the auth refactor",
      sourceToolUseId,
    });
    const second = await tool.mark({
      kind: "task",
      requirement: "Finish the auth refactor",
      sourceToolUseId,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.memoryNodeId).toBe(first.memoryNodeId);

    const row = await db.get(
      "SELECT COUNT(*) AS n FROM memory_nodes WHERE sourceToolUseId = ?",
      sourceToolUseId
    );
    expect(row.n).toBe(1);
  });

  it("can supersede an older task when a new requirement replaces it", async () => {
    const tool = new CodeMemoryMarkRequirementTool(
      store,
      () => "sess-A",
      memoryStore
    );

    const oldTask = await tool.mark({
      kind: "task",
      requirement: "Finish the auth refactor in src/auth/login.ts",
      sourceToolUseId: "toolu_req_old",
    });
    const newTask = await tool.mark({
      kind: "task",
      requirement:
        "Finish the auth refactor in src/auth/login.ts with shared validation",
      details: "The latest scope includes moving validation into shared code.",
      supersedesNodeId: oldTask.memoryNodeId,
      sourceToolUseId: "toolu_req_new",
    });

    expect(newTask.ok).toBe(true);
    expect((await memoryStore.getNode(oldTask.memoryNodeId!))?.status).toBe(
      "superseded"
    );
    expect(
      (await memoryStore.getNode(newTask.memoryNodeId!))?.supersedesNodeId
    ).toBe(oldTask.memoryNodeId);
  });

  it("rejects when the memory store is not wired in", async () => {
    const tool = new CodeMemoryMarkRequirementTool(store, () => "sess-A");
    const result = await tool.mark({
      kind: "task",
      requirement: "Finish something",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/memory store/i);
  });

  it("rejects missing requirement text or missing session routing", async () => {
    const tool = new CodeMemoryMarkRequirementTool(
      store,
      () => undefined,
      memoryStore
    );

    const missingText = await tool.mark({
      kind: "task",
      requirement: "  ",
    });
    expect(missingText.ok).toBe(false);
    expect(missingText.reason).toMatch(/required/i);

    const missingSession = await tool.mark({
      kind: "constraint",
      requirement: "Do not remove auth checks",
    });
    expect(missingSession.ok).toBe(false);
    expect(missingSession.reason).toMatch(/session/i);
  });
});
