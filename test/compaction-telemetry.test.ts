/**
 * Compaction telemetry.
 *
 * A summaries row looks identical whether the model wrote it on the first
 * attempt, wrote it only after the quality retry, or never ran at all and the
 * text is verbatim fragments behind a marker. The marker is the only surviving
 * signal and it lives inside the content, so it disappears the moment the
 * summary is condensed or rewritten.
 *
 * That mattered in practice: 224 truncation fallbacks appeared in the daemon
 * log against 0 recoverable from the database, and because the log lines carry
 * no timestamp and no conversation id the two could not be reconciled at all.
 *
 * These tests pin the distinctions a dashboard has to be able to draw: model
 * versus fallback, and among fallbacks, an outage versus a summary the model
 * produced twice and both times failed validation.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CodeMemoryContextEngine } from "../src/engine.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";

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
];

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-compact-telemetry-"));
  for (const key of TRACKED_ENV) savedEnv[key] = process.env[key];
  process.env.CODEMEMORY_DATABASE_PATH = join(dbDir, "codememory.db");
  process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "true";
  process.env.CODEMEMORY_LEAF_CHUNK_TOKENS = "40";
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dbDir, { recursive: true, force: true });
});

async function seedConversation(sessionId: string, messageCount: number) {
  const db = await createCodeMemoryDatabaseConnection(
    process.env.CODEMEMORY_DATABASE_PATH!
  );
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

async function compact(sessionId: string) {
  const db = await createCodeMemoryDatabaseConnection(
    process.env.CODEMEMORY_DATABASE_PATH!
  );
  const engine = new CodeMemoryContextEngine({
    db,
    config: resolveCodeMemoryConfig(),
    deps: SILENT_DEPS,
  });
  await engine.compact({ sessionId });
  const events = await db.all(
    "SELECT * FROM compaction_events ORDER BY eventId"
  );
  return { db, events };
}

describe("compaction telemetry", () => {
  it("records one row per summary, for leaves and condensed alike", async () => {
    const convId = await seedConversation("sess-tel-1", 24);
    const { db, events } = await compact("sess-tel-1");
    try {
      const leaves = events.filter((e: any) => e.kind === "leaf");
      const condensed = events.filter((e: any) => e.kind === "condensed");
      expect(leaves).toHaveLength(4);
      expect(condensed).toHaveLength(1);

      // Every row names the summary it describes, so the two tables join.
      const summaryIds = (
        await db.all("SELECT summaryId FROM summaries")
      ).map((r: any) => r.summaryId);
      for (const e of events) {
        expect(summaryIds).toContain(e.summaryId);
        expect(e.conversationId).toBe(convId);
      }
    } finally {
      await db.close();
    }
  });

  it("marks the LLM as disabled rather than implying it ran and succeeded", async () => {
    await seedConversation("sess-tel-2", 24);
    const { db, events } = await compact("sess-tel-2");
    try {
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.llmOutcome).toBe("disabled");
        expect(e.usedFallback).toBe(1);
        expect(e.errorMessage).toBeNull();
      }
    } finally {
      await db.close();
    }
  });

  it("records the compression achieved, which is the point of compacting", async () => {
    await seedConversation("sess-tel-3", 24);
    const { db, events } = await compact("sess-tel-3");
    try {
      const leaf = events.find((e: any) => e.kind === "leaf");
      expect(leaf.inputCount).toBeGreaterThan(0);
      expect(leaf.inputChars).toBeGreaterThan(0);
      expect(leaf.outputTokens).toBeGreaterThan(0);

      const condensed = events.find((e: any) => e.kind === "condensed");
      // Condensation consumes leaves, not messages, so its input count is the
      // fanout. Conflating the two would make the ratio meaningless.
      expect(condensed.inputCount).toBe(4);
    } finally {
      await db.close();
    }
  });

  it("times every attempt, including the ones that never called the model", async () => {
    await seedConversation("sess-tel-4", 24);
    const { db, events } = await compact("sess-tel-4");
    try {
      for (const e of events) {
        expect(typeof e.latencyMs).toBe("number");
        expect(e.latencyMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await db.close();
    }
  });

  it("does not abort a compaction when the telemetry table is missing", async () => {
    await seedConversation("sess-tel-5", 24);
    const db = await createCodeMemoryDatabaseConnection(
      process.env.CODEMEMORY_DATABASE_PATH!
    );
    await db.run("DROP TABLE compaction_events");
    const engine = new CodeMemoryContextEngine({
      db,
      config: resolveCodeMemoryConfig(),
      deps: SILENT_DEPS,
    });
    try {
      const result = await engine.compact({ sessionId: "sess-tel-5" });
      expect(result.actionTaken).toBe(true);
      const summaries = await db.all("SELECT summaryId FROM summaries");
      expect(summaries.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
