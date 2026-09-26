/**
 * The end of a session has to be compacted too.
 *
 * `runCompaction` always holds back the last `compactionFreshTailCount` (20)
 * M/L messages so an active window keeps its detail. SessionEnd's final
 * compaction went through the same path, so those 20 messages were never
 * summarized -- and, once extraction rides compaction, never read for
 * decisions or tasks either. A session's conclusions sit exactly there.
 *
 * Nothing is fresh once the session is over, so the final call says so.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { AsyncCompactor } from "../src/compaction/compactor.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

let dbDir: string;
let db: any;
let store: ConversationStore;
let conversationId: number;

async function addToolMessages(n: number) {
  for (let i = 0; i < n; i++) {
    await store.insertMessage({
      conversationId,
      role: "assistant",
      content: `[Edit] src/file${i}.ts ${"x".repeat(200)}`,
      tokenCount: 50,
      tier: "M",
      parts: [{ partType: "text", textContent: "x" }],
    });
  }
}

function compactor() {
  return new AsyncCompactor(
    db,
    { ...resolveCodeMemoryConfig(), compactionDisableLlm: true } as any,
    SILENT
  );
}

async function coveredMessages(): Promise<number> {
  const row = await db.get("SELECT COUNT(*) AS n FROM summary_messages");
  return row.n;
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-final-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  conversationId = (await store.getOrCreateConversation({ sessionId: "sess-final" }))
    .conversationId;
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("final compaction", () => {
  it("covers every message, including the fresh tail", async () => {
    await addToolMessages(25);

    await compactor().forceCompact(conversationId, { includeFreshTail: true });

    expect(await coveredMessages()).toBe(25);
  });

  it("compacts a short session that an ordinary run would skip entirely", async () => {
    // 15 messages, all inside the 20-message fresh tail.
    await addToolMessages(15);

    expect(await compactor().forceCompact(conversationId)).toEqual([]);
    expect(await coveredMessages()).toBe(0);

    await compactor().forceCompact(conversationId, { includeFreshTail: true });

    expect(await coveredMessages()).toBe(15);
  });

  it("still holds back the tail on an ordinary compaction", async () => {
    await addToolMessages(25);

    await compactor().forceCompact(conversationId);

    expect(await coveredMessages()).toBe(5);
  });
});

describe("the SessionEnd hook asks for it", () => {
  it("final-compact.sh marks the request as final", () => {
    const script = readFileSync(
      resolve(__dirname, "../hooks/scripts/final-compact.sh"),
      "utf8"
    );
    expect(script).toMatch(/final:\s*true/);
  });
});
