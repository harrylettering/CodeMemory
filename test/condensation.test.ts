/**
 * Condensation pass tests (Phase 6).
 *
 * Covers `AsyncCompactor.runCondensation` (invoked end-of-runCompaction):
 *   - N >= condensedMinFanout un-parented leaves → 1 condensed row,
 *     correct descendantCount, span, summary_parents links.
 *   - N < condensedMinFanout un-parented leaves → no condensed row.
 *   - Truncation-fallback marker present when LLM is disabled.
 *   - Re-running condensation after leaves already have parents → no
 *     duplicate parent rows.
 *
 * LLM is forced off via CODEMEMORY_COMPACTION_DISABLE_LLM=true so the test never
 * spawns `claude --print`. Leaf batch size is pinned small via
 * CODEMEMORY_LEAF_CHUNK_TOKENS so we can produce many leaves with few messages.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CodeMemoryContextEngine } from "../src/engine.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";
import { TRUNCATION_FALLBACK_MARKER } from "../src/compaction/compactor.js";

let dbDir: string;
const savedEnv: Record<string, string | undefined> = {};

const SILENT_DEPS = {
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  complete: async () => ({ content: [] }),
} as any;

const TRACKED_ENV = [
  "CODEMEMORY_DATABASE_PATH",
  "CODEMEMORY_COMPACTION_DISABLE_LLM",
  "CODEMEMORY_LEAF_CHUNK_TOKENS",
  "CODEMEMORY_CONDENSED_MIN_FANOUT",
  "CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT",
];

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-condense-"));
  for (const key of TRACKED_ENV) savedEnv[key] = process.env[key];
  process.env.CODEMEMORY_DATABASE_PATH = join(dbDir, "codememory.db");
  process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "true";
  // One 50-token message per leaf batch, so seeding N compactable messages
  // yields N leaves.
  process.env.CODEMEMORY_LEAF_CHUNK_TOKENS = "40";
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dbDir, { recursive: true, force: true });
});

async function buildEngine() {
  const db = await createCodeMemoryDatabaseConnection(process.env.CODEMEMORY_DATABASE_PATH!);
  const config = resolveCodeMemoryConfig();
  const engine = new CodeMemoryContextEngine({ db, config, deps: SILENT_DEPS });
  return { db, engine };
}

async function seedConversation(sessionId: string, messageCount: number) {
  const db = await createCodeMemoryDatabaseConnection(process.env.CODEMEMORY_DATABASE_PATH!);
  const store = new ConversationStore(db);
  const conv = await store.getOrCreateConversation({ sessionId });
  for (let i = 0; i < messageCount; i++) {
    await store.insertMessage({
      conversationId: conv.conversationId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message body ${i} with enough content to cost a few tokens each`,
      tokenCount: 50,
      tier: "L",
      parts: [{ partType: "text", textContent: `message ${i}` }],
    });
  }
  await db.close();
  return conv.conversationId;
}

describe("runCondensation (Phase 6)", () => {
  it("condenses N>=minFanout un-parented leaves into a single condensed summary", async () => {
    // freshTail defaults to 20, so 24 messages → 4 compactable → 4 leaves
    // (CODEMEMORY_LEAF_CHUNK_TOKENS=40 means 1 msg/batch). minFanout default = 4.
    const convId = await seedConversation("sess-condense", 24);

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-condense" });

      expect(result.actionTaken).toBe(true);
      expect(result.condensed).toBe(true);
      expect(result.level).toBe("condensed");
      expect(result.createdSummaryId).toMatch(/^cond-/);

      const leafRows = await db.all(
        "SELECT summaryId, earliestAt, latestAt FROM summaries WHERE conversationId = ? AND kind = 'leaf' ORDER BY earliestAt",
        convId
      );
      expect(leafRows.length).toBe(4);

      const condRow = await db.get(
        "SELECT summaryId, kind, depth, descendantCount, earliestAt, latestAt, content FROM summaries WHERE conversationId = ? AND kind = 'condensed'",
        convId
      );
      expect(condRow).toBeTruthy();
      expect(condRow.kind).toBe("condensed");
      expect(condRow.depth).toBe(1);
      expect(condRow.summaryId).toBe(result.createdSummaryId);
      // descendantCount sums leaf descendantCount (each leaf covers 1 msg here)
      expect(condRow.descendantCount).toBe(4);
      expect(condRow.earliestAt).toBe(leafRows[0].earliestAt);
      expect(condRow.latestAt).toBe(leafRows[leafRows.length - 1].latestAt);

      // All 4 leaves linked to the condensed parent.
      const parentLinks = await db.all(
        "SELECT summaryId FROM summary_parents WHERE parentSummaryId = ? ORDER BY position",
        condRow.summaryId
      );
      expect(parentLinks.length).toBe(4);
      expect(parentLinks.map((r: any) => r.summaryId).sort()).toEqual(
        leafRows.map((r: any) => r.summaryId).sort()
      );
    } finally {
      await db.close();
    }
  });

  it("skips condensation when fewer than minFanout leaves are un-parented", async () => {
    // 23 messages → 3 compactable → 3 leaves → below default minFanout (4).
    const convId = await seedConversation("sess-small", 23);

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-small" });

      expect(result.actionTaken).toBe(true);
      expect(result.condensed).toBe(false);
      expect(result.level).toBe("leaf");

      const cond = await db.get(
        "SELECT COUNT(*) as n FROM summaries WHERE conversationId = ? AND kind = 'condensed'",
        convId
      );
      expect(cond.n).toBe(0);

      // No parent links at all — all leaves stay un-parented for next pass.
      const parents = await db.get("SELECT COUNT(*) as n FROM summary_parents");
      expect(parents.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("labels truncation-fallback content so readers know it's not a real summary", async () => {
    await seedConversation("sess-fallback", 24);

    const { db, engine } = await buildEngine();
    try {
      await engine.compact({ sessionId: "sess-fallback" });

      const leaf = await db.get(
        "SELECT content FROM summaries WHERE kind = 'leaf' LIMIT 1"
      );
      expect(leaf.content.startsWith(TRUNCATION_FALLBACK_MARKER)).toBe(true);

      const cond = await db.get(
        "SELECT content FROM summaries WHERE kind = 'condensed' LIMIT 1"
      );
      expect(cond.content.startsWith(TRUNCATION_FALLBACK_MARKER)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("does not re-parent already-condensed leaves on a second compaction run", async () => {
    const convId = await seedConversation("sess-idempotent", 24);

    const { db, engine } = await buildEngine();
    try {
      const first = await engine.compact({ sessionId: "sess-idempotent" });
      expect(first.condensed).toBe(true);

      const afterFirst = await db.get(
        "SELECT COUNT(*) as n FROM summary_parents"
      );
      expect(afterFirst.n).toBe(4);

      // Second call: no new M/L messages to compact, and all leaves already
      // have parents → runCondensation must return no new condensed rows
      // and no new parent links.
      const second = await engine.compact({ sessionId: "sess-idempotent" });
      expect(second.actionTaken).toBe(false);

      const afterSecond = await db.get(
        "SELECT COUNT(*) as n FROM summary_parents"
      );
      expect(afterSecond.n).toBe(4);

      const condCount = await db.get(
        "SELECT COUNT(*) as n FROM summaries WHERE kind = 'condensed'"
      );
      expect(condCount.n).toBe(1);
    } finally {
      await db.close();
    }
  });
});
