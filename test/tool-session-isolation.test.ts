/**
 * Model-callable tools are bounded too.
 *
 * `codememory_grep` and its siblings do not go through searchByPlan, so
 * bounding the store leaves them as an open door. Worse, the door is one the
 * model can walk through on its own.
 *
 * Their schemas never exposed `conversationId`, which reads as safe and is
 * not: the handler passed `params` straight through, so the field arrived
 * undefined and the query fell back to searching every conversation. The fix
 * is to inject the live session at the wiring layer, never to accept it from
 * the model. A parameter the caller supplies is a boundary the caller can drop.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createCodeMemoryGrepTool } from "../src/tools/codememory-grep-tool.js";

let dbDir: string;
let db: any;
let conversationStore: ConversationStore;
let summaryStore: SummaryStore;

const SILENT = {
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
} as any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-tool-iso-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  conversationStore = new ConversationStore(db);
  summaryStore = new SummaryStore(db);

  for (const [conversationId, sessionId] of [[1, "sess-mine"], [2, "sess-theirs"]] as const) {
    await db.run(
      "INSERT INTO conversations (conversationId, sessionId) VALUES (?, ?)",
      [conversationId, sessionId]
    );
    await conversationStore.insertMessage({
      conversationId,
      role: "user",
      content: `zzsentinelzz belongs to conversation ${conversationId}`,
      tokenCount: 10,
      tier: "S",
      parts: [{ partType: "text", textContent: "zzsentinelzz" }],
    });
  }
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("codememory_grep is bounded by the live session", () => {
  it("does not reach another conversation's messages", async () => {
    const tool = await createCodeMemoryGrepTool(
      conversationStore,
      summaryStore,
      SILENT,
      () => "sess-mine"
    );

    const result: any = await tool.call({
      query: "zzsentinelzz",
      mode: "full_text",
      scope: "messages",
    });

    const conversations = new Set(
      result.messages.map((m: any) => m.conversationId)
    );
    // Non-empty, or the assertion below would pass vacuously.
    expect(result.messages.length).toBeGreaterThan(0);
    expect(conversations.has(2)).toBe(false);
  });

  it("returns nothing when the live session cannot be resolved", async () => {
    const tool = await createCodeMemoryGrepTool(
      conversationStore,
      summaryStore,
      SILENT,
      () => undefined
    );

    const result: any = await tool.call({
      query: "zzsentinelzz",
      mode: "full_text",
      scope: "messages",
    });

    expect(result.messages).toHaveLength(0);
  });

  it("does not let the model name a conversation", async () => {
    const tool = await createCodeMemoryGrepTool(
      conversationStore,
      summaryStore,
      SILENT,
      () => "sess-mine"
    );

    // The schema is the contract the model sees. Adding this key back later
    // would silently reopen the door, so the absence is asserted rather than
    // assumed.
    expect(Object.keys(tool.params.properties)).not.toContain("conversationId");

    const result: any = await tool.call({
      query: "zzsentinelzz",
      mode: "full_text",
      scope: "messages",
      conversationId: 2,
    } as any);

    const conversations = new Set(
      result.messages.map((m: any) => m.conversationId)
    );
    expect(result.messages.length).toBeGreaterThan(0);
    expect(conversations.has(2)).toBe(false);
  });
});
