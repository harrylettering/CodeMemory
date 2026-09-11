/**
 * Write-side telemetry.
 *
 * Everything the scorer keeps is recoverable from conversation_messages.
 * Everything it discards is not: an N-tier message is dropped before any
 * write, so the share of a session rejected as noise — the number that says
 * whether the filter is earning its place — had no denominator at all.
 *
 * Key-memory extraction has the mirror-image gap. It runs one model call per
 * transcript chunk and catches per-chunk failures so a partial rebuild
 * survives. That is the right behavior, and it means a run that reports twelve
 * memories may have lost eight chunks without saying so.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { extractKeyMemories } from "../src/memory/extract-key-memories.js";

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-ingest-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const ingestionEvents = () =>
  db.all("SELECT * FROM ingestion_events ORDER BY eventId");

describe("ingestion telemetry", () => {
  it("records a dropped message, which is written nowhere else", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordIngestion({
      conversationId: 1,
      sessionId: "s1",
      role: "assistant",
      tier: "N",
      tags: ["tool_result", "duplicate"],
      rawChars: 4200,
      storedChars: 0,
      stored: false,
    });

    const [row] = await ingestionEvents();
    expect(row.tier).toBe("N");
    expect(row.stored).toBe(0);
    expect(row.messageId).toBeNull();
    // The tags are the rule that rejected it.
    expect(JSON.parse(row.tags)).toContain("duplicate");
  });

  it("makes the noise-rejection rate computable", async () => {
    const store = createMemoryNodeStore(db, {});
    const tiers: Array<"S" | "M" | "L" | "N"> = ["S", "M", "M", "L", "N", "N", "N"];
    for (const [i, tier] of tiers.entries()) {
      await store.recordIngestion({
        conversationId: 1,
        sessionId: "s1",
        messageId: tier === "N" ? null : i,
        role: "assistant",
        tier,
        rawChars: 1000,
        storedChars: tier === "N" ? 0 : 200,
        stored: tier !== "N",
      });
    }

    const rows = await ingestionEvents();
    const dropped = rows.filter((r: any) => r.tier === "N").length;
    expect(rows).toHaveLength(7);
    expect(dropped).toBe(3);
  });

  it("keeps raw and stored size apart, so tier compression is measurable", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordIngestion({
      conversationId: 1,
      sessionId: "s1",
      messageId: 7,
      role: "assistant",
      tier: "M",
      tags: ["mutation"],
      rawChars: 8000,
      storedChars: 120,
      stored: true,
    });

    const [row] = await ingestionEvents();
    // M keeps mutation metadata, not the text. Without both numbers there is
    // no way to say what the tier actually saved.
    expect(row.rawChars).toBe(8000);
    expect(row.storedChars).toBe(120);
  });

  it("flags subagent traffic so it can be separated from the main thread", async () => {
    const store = createMemoryNodeStore(db, {});
    await store.recordIngestion({
      conversationId: 1,
      sessionId: "s1",
      messageId: 1,
      role: "assistant",
      tier: "S",
      rawChars: 500,
      storedChars: 500,
      stored: true,
      subagent: true,
    });

    const [row] = await ingestionEvents();
    expect(row.subagent).toBe(1);
  });

  it("never fails an ingest because telemetry could not be written", async () => {
    const store = createMemoryNodeStore(db, {});
    await db.run("DROP TABLE ingestion_events");
    await expect(
      store.recordIngestion({
        conversationId: 1,
        tier: "S",
        rawChars: 1,
        storedChars: 1,
        stored: true,
      })
    ).resolves.toBeUndefined();
  });
});

describe("extraction telemetry", () => {
  const transcript = Array.from(
    { length: 40 },
    (_, i) => `[USER] question ${i}\n[ASSISTANT] answer ${i}`
  ).join("\n");

  it("reports every chunk, including the ones that failed", async () => {
    const seen: any[] = [];
    let call = 0;
    await extractKeyMemories(transcript, {
      chunkChars: 200,
      maxChunks: 5,
      runCompletion: async () => {
        call += 1;
        if (call === 2) throw new Error("claude --print timed out after 180000ms");
        return JSON.stringify({
          items: [
            { kind: "decision", statement: `d${call}`, rationale: "because" },
          ],
        });
      },
      onChunk: (r) => {
        seen.push(r);
      },
    });

    expect(seen.length).toBeGreaterThan(1);
    const failed = seen.filter((r) => r.outcome === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0].errorMessage).toContain("timed out");
    // A partial run still returns what the other chunks produced.
    expect(seen.filter((r) => r.outcome === "ok").length).toBeGreaterThan(0);
  });

  it("separates a model that answered unparseably from one that failed", async () => {
    const seen: any[] = [];
    await extractKeyMemories(transcript, {
      chunkChars: 400,
      maxChunks: 2,
      runCompletion: async () => "I'm not sure what you want.",
      onChunk: (r) => {
        seen.push(r);
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.outcome).toBe("parse_empty");
      expect(r.errorMessage).toBeUndefined();
    }
  });

  it("persists per-chunk rows that roll up into one run", async () => {
    const store = createMemoryNodeStore(db, {});
    const runId = "extract-1-999";
    for (let i = 0; i < 3; i++) {
      await store.recordExtraction({
        runId,
        conversationId: 1,
        sessionId: "s1",
        chunkIndex: i,
        chunkCount: 3,
        chunkChars: 24_000,
        sourceRawChars: 3_700_000,
        sourceProseChars: 81_000,
        outcome: i === 1 ? "error" : "ok",
        itemCount: i === 1 ? 0 : 4,
        decisionCount: i === 1 ? 0 : 2,
        taskCount: i === 1 ? 0 : 1,
        constraintCount: i === 1 ? 0 : 1,
        revisesCount: i === 1 ? 0 : 1,
        errorMessage: i === 1 ? "quota exhausted" : null,
        latencyMs: 43_000,
      });
    }

    const rows = await db.all(
      "SELECT * FROM extraction_events WHERE runId = ? ORDER BY chunkIndex",
      runId
    );
    expect(rows).toHaveLength(3);
    // The headline number is 8 memories, from 2 of 3 chunks. Reporting only
    // the total hides the third of the transcript that was never read.
    expect(rows.reduce((s: number, r: any) => s + r.itemCount, 0)).toBe(8);
    expect(rows.filter((r: any) => r.outcome === "error")).toHaveLength(1);
    // The prose filter's reduction is carried on every row of the run.
    expect(rows[0].sourceRawChars).toBe(3_700_000);
    expect(rows[0].sourceProseChars).toBe(81_000);
  });
});
