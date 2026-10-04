/**
 * What the extraction telemetry has to answer.
 *
 * Riding the compaction call was chosen to avoid new calls, so the question it
 * must settle is whether the extra input paid for itself. That needs cost and
 * yield on the same row: how long the prompt actually was, where the candidate
 * memories came from, and what the model did with them.
 *
 * The candidate breakdown matters on its own. Source A (what prompt-time
 * retrieval surfaced) covers 85% of recent windows; if that share drops, the
 * fallback scan is carrying the feature and its weights -- which are guesses --
 * start to matter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { AsyncCompactor } from "../src/compaction/compactor.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

let dbDir: string;
let db: any;
let store: ConversationStore;
let conversationId: number;

async function add(role: "user" | "assistant", tier: "S" | "M", content: string, tags: string[] = []) {
  await store.insertMessage({
    conversationId,
    role,
    content,
    tokenCount: Math.ceil(content.length / 4),
    tier,
    tags,
    parts: [{ partType: "text", textContent: content }],
  });
}

function compactor() {
  return new AsyncCompactor(
    db,
    { ...resolveCodeMemoryConfig(), compactionDisableLlm: false } as any,
    SILENT,
    { runCompletion: async () => `{"anchor":false,"kinds":[],"memories":[]}\n\nSummary.` }
  );
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-xtel-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  conversationId = (await store.getOrCreateConversation({ sessionId: "sess-tel" })).conversationId;
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("cost, on the same row as yield", () => {
  it("records how long the prompt actually was, not just the transcript", async () => {
    await add("user", "S", "决定：只发标题", ["user_input"]);
    for (let i = 0; i < 60; i++) await add("assistant", "M", `[Edit] f${i}.ts ${"x".repeat(200)}`);

    await compactor().forceCompact(conversationId);

    const row = await db.get(
      "SELECT promptChars, inputChars FROM compaction_events ORDER BY eventId DESC LIMIT 1"
    );
    // The instructions and the candidate list are paid for too.
    expect(row.promptChars).toBeGreaterThan(row.inputChars);
  });

  it("breaks the candidate list down by where each one came from", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.createTaskNode({
      conversationId,
      task: "Freshly written task",
      content: "[TASK] Freshly written task",
    } as any);
    await add("user", "S", "这个任务做完了", ["user_input"]);
    for (let i = 0; i < 60; i++) await add("assistant", "M", `[Edit] f${i}.ts ${"x".repeat(200)}`);

    await compactor().forceCompact(conversationId);

    const row = await db.get(
      "SELECT candidateCount, candidateFromSurfaced, candidateFromRecent, candidateFromScan FROM compaction_events ORDER BY eventId DESC LIMIT 1"
    );
    expect(row.candidateCount).toBe(1);
    expect(row.candidateFromRecent).toBe(1);
    expect(row.candidateFromSurfaced).toBe(0);
    expect(row.candidateFromScan).toBe(0);
  });
});

describe("a retrieval event names the turn it belongs to", () => {
  it("stores the promptId so a compaction window can be matched to its turns", async () => {
    // Windows are matched to retrieval events by timestamp today, which is
    // approximate at the edges. The id is exact, and #24 already stores it on
    // every message.
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.recordRetrieval({
      conversationId,
      sessionId: "sess-tel",
      promptId: "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b",
      promptLength: 12,
      plannerSource: "fast",
      plannerAttempted: false,
      memoryNodeCount: 0,
      injectedChars: 0,
    } as any);

    const row = await db.get("SELECT promptId FROM retrieval_events ORDER BY eventId DESC LIMIT 1");
    expect(row.promptId).toBe("0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b");
  });
});

describe("the hook that supplies it", () => {
  it("forwards prompt_id to the daemon", () => {
    // The column is only as good as the value reaching it, and a field that is
    // declared, typed and never sent is this repo's most repeated bug.
    const script = readFileSync(
      resolve(__dirname, "../hooks/scripts/user-prompt-submit.sh"),
      "utf8"
    );
    expect(script).toContain(".prompt_id");
    expect(script).toMatch(/promptId/);
  });
});
