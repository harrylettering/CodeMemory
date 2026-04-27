/**
 * Tests for `CodeMemoryMarkDecisionTool` — verifies decisions are materialized as
 * Memory Nodes with the expected tags, that `sourceToolUseId` provides
 * idempotency, and that supersession links are written correctly.
 *
 * Note: this tool no longer writes to `conversation_messages`. Under the
 * Skill → daemon path, the matching S-tier message row is produced by the
 * JSONL watcher when it sees the Skill `tool_use` block. This file therefore
 * only asserts memory_nodes side-effects.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CodeMemoryMarkDecisionTool } from "../src/tools/codememory-mark-decision-tool.js";
import {
  createMemoryNodeStore,
  type MemoryNodeStore,
} from "../src/store/memory-store.js";

let dbDir: string;
let db: any;
let store: ConversationStore;
let memoryStore: MemoryNodeStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-mark-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  memoryStore = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("CodeMemoryMarkDecisionTool", () => {
  it("creates a decision Memory Node with the expected content and tags", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);

    const result = await tool.mark({
      decision: "Use zod for runtime validation in src/auth/login.ts",
      rationale: "Types alone don't catch malformed API payloads",
    });

    expect(result.ok).toBe(true);
    expect(result.conversationId).toBeTypeOf("number");
    expect(result.memoryNodeId).toBeTypeOf("string");

    const node = await memoryStore.getNode(result.memoryNodeId!);
    expect(node?.kind).toBe("decision");
    expect(node?.content).toContain("[DECISION] Use zod for runtime validation");
    expect(node?.content).toContain("Rationale:");

    const tags = await memoryStore.getTags(result.memoryNodeId!);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "kind", tagValue: "decision" }),
        expect.objectContaining({
          tagType: "file",
          tagValue: expect.stringMatching(/^[0-9a-f]{8}:src\/auth\/login\.ts$/),
        }),
      ])
    );
  });

  it("renders alternatives_rejected into the node content", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);

    const result = await tool.mark({
      decision: "Pick SQLite over Postgres for local dev",
      rationale: "Zero-config + single-file on dev machines",
      alternatives_rejected: [
        "Postgres — needs docker in every dev env",
        "LevelDB — no SQL ergonomics",
      ],
    });

    const node = await memoryStore.getNode(result.memoryNodeId!);
    expect(node?.content).toContain("Rejected:");
    expect(node?.content).toContain("- Postgres — needs docker");
    expect(node?.content).toContain("- LevelDB — no SQL ergonomics");
  });

  it("rejects when `decision` is missing", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);
    const result = await tool.mark({
      decision: "",
      rationale: "whatever",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/required/i);
  });

  it("rejects when `rationale` is missing", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);
    const result = await tool.mark({
      decision: "Do the thing",
      rationale: "   ",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/required/i);
  });

  it("rejects when no sessionId is resolvable", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => undefined, memoryStore);
    const result = await tool.mark({
      decision: "x",
      rationale: "y",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/session/i);
  });

  it("rejects when the memory store is not wired in", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A");
    const result = await tool.mark({
      decision: "x",
      rationale: "y",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/memory store/i);
  });

  it("prefers the explicit sessionId override over the ambient one", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);

    const result = await tool.mark({
      decision: "Route to B",
      rationale: "explicit override",
      sessionId: "sess-B",
    });

    expect(result.ok).toBe(true);
    const conv = await db.get(
      "SELECT sessionId FROM conversations WHERE conversationId = ?",
      result.conversationId
    );
    expect(conv.sessionId).toBe("sess-B");
  });

  it("collapses retries with the same sourceToolUseId onto the same node", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);
    const sourceToolUseId = "toolu_01ABCDEF";

    const first = await tool.mark({
      decision: "Use zod for runtime validation",
      rationale: "Types alone don't catch malformed API payloads",
      sourceToolUseId,
    });
    const second = await tool.mark({
      decision: "Use zod for runtime validation",
      rationale: "Types alone don't catch malformed API payloads",
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

  it("can explicitly supersede an older decision Memory Node", async () => {
    const tool = new CodeMemoryMarkDecisionTool(store, () => "sess-A", memoryStore);

    const oldDecision = await tool.mark({
      decision: "Keep auth validation in the route handler",
      rationale: "It was closest to the login endpoint",
      sourceToolUseId: "toolu_old",
    });
    const newDecision = await tool.mark({
      decision: "Move auth validation into the shared validator",
      rationale: "Other endpoints now need the same checks",
      supersedesNodeId: oldDecision.memoryNodeId,
      sourceToolUseId: "toolu_new",
    });

    expect(newDecision.memoryNodeId).toBeTypeOf("string");
    const oldNode = await memoryStore.getNode(oldDecision.memoryNodeId!);
    const newNode = await memoryStore.getNode(newDecision.memoryNodeId!);
    expect(oldNode?.status).toBe("superseded");
    expect(newNode?.supersedesNodeId).toBe(oldDecision.memoryNodeId);

    const relations = await memoryStore.getRelationsForNode(
      newDecision.memoryNodeId!,
      "from"
    );
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationType: "supersedes",
          toNodeId: oldDecision.memoryNodeId,
        }),
      ])
    );
  });
});
