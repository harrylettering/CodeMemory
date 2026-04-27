/**
 * Context assembler tests.
 *
 * Locks in the budget-aware packing semantics:
 *   - Empty conversation → empty result, not truncated.
 *   - Budget=0 with items present → empty result, truncated=true.
 *   - All items fit → all returned in `ordinal` order.
 *   - Item that would push past the budget is skipped (skip-and-continue),
 *     `truncated=true`. Smaller later items still get included.
 *   - Mixed message + summary items both round-trip, with the summary
 *     wrapper included in the token tally.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { CodeMemoryContextAssembler } from "../src/assembler.js";

let dbDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-assembler-"));
  originalDbEnv = process.env.CODEMEMORY_DATABASE_PATH;
  process.env.CODEMEMORY_DATABASE_PATH = join(dbDir, "codememory.db");
});

afterEach(() => {
  if (originalDbEnv === undefined) delete process.env.CODEMEMORY_DATABASE_PATH;
  else process.env.CODEMEMORY_DATABASE_PATH = originalDbEnv;
  rmSync(dbDir, { recursive: true, force: true });
});

async function buildStores() {
  const db = await createCodeMemoryDatabaseConnection(process.env.CODEMEMORY_DATABASE_PATH!);
  return {
    db,
    conversationStore: new ConversationStore(db),
    summaryStore: new SummaryStore(db),
  };
}

async function seedConversation(opts: {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  sessionId: string;
  messages: Array<{ role: "user" | "assistant"; content: string; tokenCount: number }>;
  summaries?: Array<{ content: string; tokenCount: number }>;
  /** Order of context items by kind+index (e.g. ["m0","s0","m1"]). Defaults to all messages then all summaries. */
  itemOrder?: string[];
}) {
  const conv = await opts.conversationStore.getOrCreateConversation({
    sessionId: opts.sessionId,
  });

  const messageIds: number[] = [];
  for (const m of opts.messages) {
    const inserted = await opts.conversationStore.insertMessage({
      conversationId: conv.conversationId,
      role: m.role,
      content: m.content,
      tokenCount: m.tokenCount,
      tier: "L",
      parts: [{ partType: "text", textContent: m.content }],
    });
    messageIds.push(inserted.messageId);
  }

  const summaryIds: string[] = [];
  for (let i = 0; i < (opts.summaries?.length ?? 0); i++) {
    const s = opts.summaries![i];
    const sid = `leaf-${conv.conversationId}-test-${i}`;
    await opts.summaryStore.getDatabase().run(
      `INSERT INTO summaries (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount)
       VALUES (?, ?, 'leaf', 0, datetime('now'), datetime('now'), 1, ?, ?)`,
      [sid, conv.conversationId, s.content, s.tokenCount]
    );
    summaryIds.push(sid);
  }

  // Build context items in requested order.
  const order = opts.itemOrder ?? [
    ...opts.messages.map((_, i) => `m${i}`),
    ...(opts.summaries ?? []).map((_, i) => `s${i}`),
  ];
  const items = order.map((tag) => {
    if (tag.startsWith("m")) {
      return { itemType: "message" as const, messageId: messageIds[parseInt(tag.slice(1))] };
    }
    return { itemType: "summary" as const, summaryId: summaryIds[parseInt(tag.slice(1))] };
  });
  await opts.summaryStore.replaceContextItems(conv.conversationId, items);

  return { conversationId: conv.conversationId, messageIds, summaryIds };
}

describe("CodeMemoryContextAssembler.pack", () => {
  it("returns empty result for a conversation with no context items", async () => {
    const { db, conversationStore, summaryStore } = await buildStores();
    try {
      const conv = await conversationStore.getOrCreateConversation({ sessionId: "sess-empty" });
      const assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);

      const result = await assembler.pack(conv.conversationId, { tokenBudget: 1000 });

      expect(result.messages).toEqual([]);
      expect(result.estimatedTokens).toBe(0);
      expect(result.truncated).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("flags truncation but returns nothing when tokenBudget=0 and items exist", async () => {
    const { db, conversationStore, summaryStore } = await buildStores();
    try {
      await seedConversation({
        conversationStore,
        summaryStore,
        sessionId: "sess-zero",
        messages: [{ role: "user", content: "hello", tokenCount: 5 }],
      });
      const conv = await conversationStore.getOrCreateConversation({ sessionId: "sess-zero" });
      const assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);

      const result = await assembler.pack(conv.conversationId, { tokenBudget: 0 });

      expect(result.messages).toEqual([]);
      expect(result.estimatedTokens).toBe(0);
      expect(result.truncated).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("includes all items in ordinal order when budget is large", async () => {
    const { db, conversationStore, summaryStore } = await buildStores();
    try {
      await seedConversation({
        conversationStore,
        summaryStore,
        sessionId: "sess-fits",
        messages: [
          { role: "user", content: "first user", tokenCount: 10 },
          { role: "assistant", content: "first asst", tokenCount: 12 },
          { role: "user", content: "second user", tokenCount: 8 },
        ],
      });
      const conv = await conversationStore.getOrCreateConversation({ sessionId: "sess-fits" });
      const assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);

      const result = await assembler.pack(conv.conversationId, { tokenBudget: 1000 });

      expect(result.messages).toHaveLength(3);
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(result.messages.map((m) => m.content)).toEqual([
        "first user",
        "first asst",
        "second user",
      ]);
      expect(result.truncated).toBe(false);
      // Each message: stored tokenCount + 4 overhead. Sum = 10+12+8 + 12 = 42.
      expect(result.estimatedTokens).toBe(42);
    } finally {
      await db.close();
    }
  });

  it("skips an oversize item but still includes smaller later items (truncated=true)", async () => {
    const { db, conversationStore, summaryStore } = await buildStores();
    try {
      await seedConversation({
        conversationStore,
        summaryStore,
        sessionId: "sess-mixed-sizes",
        messages: [
          { role: "user", content: "tiny first", tokenCount: 5 },
          { role: "assistant", content: "GIANT".repeat(100), tokenCount: 500 },
          { role: "user", content: "tiny last", tokenCount: 6 },
        ],
      });
      const conv = await conversationStore.getOrCreateConversation({
        sessionId: "sess-mixed-sizes",
      });
      const assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);

      // Budget 50 fits the two tiny ones (5+4 + 6+4 = 19) but not the giant (500+4).
      const result = await assembler.pack(conv.conversationId, { tokenBudget: 50 });

      expect(result.messages).toHaveLength(2);
      expect(result.messages.map((m) => m.content)).toEqual(["tiny first", "tiny last"]);
      expect(result.truncated).toBe(true);
      expect(result.estimatedTokens).toBe(19);
    } finally {
      await db.close();
    }
  });

  it("packs mixed message + summary items with summary prefix tokens counted", async () => {
    const { db, conversationStore, summaryStore } = await buildStores();
    try {
      const seeded = await seedConversation({
        conversationStore,
        summaryStore,
        sessionId: "sess-mixed",
        messages: [{ role: "user", content: "follow-up", tokenCount: 8 }],
        summaries: [{ content: "earlier-context", tokenCount: 20 }],
        itemOrder: ["s0", "m0"],
      });
      const assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);

      const result = await assembler.pack(seeded.conversationId, { tokenBudget: 1000 });

      expect(result.messages).toHaveLength(2);

      const [first, second] = result.messages;
      expect(first.kind).toBe("summary");
      expect(first.role).toBe("system");
      expect(first.content.startsWith("[SUMMARY] ")).toBe(true);
      expect(first.content.endsWith("earlier-context")).toBe(true);

      expect(second.kind).toBe("message");
      expect(second.role).toBe("user");
      expect(second.content).toBe("follow-up");

      expect(result.truncated).toBe(false);
      // summary: 20 (stored) + 4 overhead + 3 prefix tokens (ceil(10/4)) = 27
      // message: 8 + 4 = 12 → total 39
      expect(result.estimatedTokens).toBe(39);
    } finally {
      await db.close();
    }
  });
});
