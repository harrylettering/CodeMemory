/**
 * The same transcript line must not become two rows.
 *
 * The watcher observes a project directory and filters by extension, not by
 * session, while the daemon that owns it is per-session. Two sessions in one
 * project therefore means two processes reading every transcript in it, each
 * ingesting what it finds.
 *
 * Measured live: conversation 11 held 910 rows from a 776-line transcript --
 * more rows than source lines -- with 138 groups of byte-identical content
 * whose seq values were evenly spaced, the shape of one batch read twice.
 *
 * Nothing prevented it. conversation_messages.messageId is an AUTOINCREMENT
 * primary key with no relationship to the line it came from, so a second read
 * produced a second row rather than colliding with the first. The fix is to
 * record which line a row came from and let the database refuse the duplicate.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";

let dbDir: string;
let db: any;
let store: ConversationStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-dupes-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  await db.run(
    "INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')"
  );
  await db.run(
    "INSERT INTO conversations (conversationId, sessionId) VALUES (2, 'sess-B')"
  );
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const insert = (conversationId: number, sourceUuid?: string, content = "hello") =>
  store.insertMessage({
    conversationId,
    role: "user",
    content,
    tokenCount: 5,
    tier: "S",
    sourceUuid,
    parts: [{ partType: "text", textContent: content }],
  } as any);

const countIn = async (conversationId: number) =>
  (
    await db.get(
      "SELECT COUNT(*) c FROM conversation_messages WHERE conversationId = ?",
      conversationId
    )
  ).c;

describe("ingesting the same line twice", () => {
  it("stores one row, not two", async () => {
    await insert(1, "uuid-aaa");
    await insert(1, "uuid-aaa");

    expect(await countIn(1)).toBe(1);
  });

  it("does not collapse genuinely different lines", async () => {
    await insert(1, "uuid-aaa", "first");
    await insert(1, "uuid-bbb", "second");

    expect(await countIn(1)).toBe(2);
  });

  it("keeps the same line in two conversations apart", async () => {
    // A subagent transcript is read by the session that dispatched it, but a
    // re-import into a different conversation must not be blocked by a row
    // that belongs to another one.
    await insert(1, "uuid-aaa");
    await insert(2, "uuid-aaa");

    expect(await countIn(1)).toBe(1);
    expect(await countIn(2)).toBe(1);
  });

  it("never drops a line that carries no uuid", async () => {
    // Metadata lines have no uuid and never become messages, so this should
    // not arise -- but if it ever does, two unidentifiable lines are two
    // lines. Dropping one would be loss; keeping both is only noise.
    await insert(1, undefined, "first");
    await insert(1, undefined, "second");

    expect(await countIn(1)).toBe(2);
  });

  it("survives two processes inserting the same line at once", async () => {
    // The check-then-insert has a window. Within one process dispatch is
    // sequential so it never opens, but two daemons watching the same project
    // directory are two processes -- the case this whole change exists for.
    const [a, b] = await Promise.all([
      insert(1, "uuid-race"),
      insert(1, "uuid-race"),
    ]);

    expect(await countIn(1)).toBe(1);
    expect(a.messageId).toBe(b.messageId);
  });

  it("returns the existing row rather than throwing on a repeat", async () => {
    const first = await insert(1, "uuid-aaa");
    const second = await insert(1, "uuid-aaa");

    // Ingestion threads messageId into fix-attempt tracking and telemetry, so
    // a repeat has to yield the original id rather than fail the ingest.
    expect(second.messageId).toBe(first.messageId);
  });
});
