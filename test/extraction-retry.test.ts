/**
 * A window whose call fell back still owes an extraction.
 *
 * When `claude --print` fails, compaction writes a truncation summary and
 * moves on -- the messages are marked covered, so nothing revisits them. The
 * summary survives that; the extraction does not, and the window's decisions
 * are lost for good.
 *
 * Steady-state fallback is about 5% (2 of 39 calls since 09-19), but it
 * arrives in bursts: a re-import ran 45 compactions in a day and 36 of them
 * hit the session limit. Without a retry, a burst silently costs a day of
 * decisions.
 *
 * The retry is bounded: one window per compaction run, two attempts per
 * window, and only for windows that actually fell back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
let calls: string[];

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

async function addWindow(label: string) {
  await add("user", "S", `决定：${label}`, ["user_input"]);
  for (let i = 0; i < 40; i++) await add("assistant", "M", `[Edit] ${label}-${i}.ts ${"x".repeat(200)}`);
}

function compactor(reply: (prompt: string) => Promise<string>) {
  return new AsyncCompactor(
    db,
    { ...resolveCodeMemoryConfig(), compactionDisableLlm: false } as any,
    SILENT,
    {
      runCompletion: async (prompt: string) => {
        calls.push(prompt);
        return reply(prompt);
      },
    }
  );
}

const failing = async () => {
  throw new Error("claude --print exited with code 1: You've hit your session limit");
};

const reply = (text: string) =>
  `${JSON.stringify({ anchor: false, kinds: [], memories: [{ kind: "decision", op: "ADD", text }] })}\n\nSummary.`;

/**
 * Answers by which window it is looking at, so a retry of the first window is
 * distinguishable from the second window's own call. A stub that answers the
 * same thing to everything makes these tests pass without any retry at all.
 */
const answeringPerWindow = async (prompt: string) =>
  prompt.includes("first") ? reply("第一个窗口的决定") : reply("第二个窗口的决定");

const decisions = () => db.all("SELECT * FROM memory_nodes WHERE kind = 'decision'");
const summaries = () => db.all("SELECT * FROM summaries");
const events = () =>
  db.all("SELECT usedFallback, extractionAdded, extractionRetries FROM compaction_events ORDER BY eventId");

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-retry-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  conversationId = (await store.getOrCreateConversation({ sessionId: "sess-retry" })).conversationId;
  calls = [];
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("a window whose call fell back", () => {
  it("is extracted on a later run, without being summarized again", async () => {
    await addWindow("first");
    await compactor(failing).forceCompact(conversationId);

    // Precondition: the summary exists, the extraction does not.
    expect((await summaries()).length).toBe(1);
    expect(await decisions()).toEqual([]);
    expect((await events())[0].usedFallback).toBe(1);

    await addWindow("second");
    calls = [];
    await compactor(answeringPerWindow).forceCompact(conversationId);

    // Two calls: the second window's own summary, and the retry of the first.
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.includes("first"))).toBe(true);

    const stored = await decisions();
    // The decision recovered from the *first* window, which no longer has a
    // call of its own -- its messages are already marked covered.
    expect(stored.some((d: any) => d.content.includes("第一个窗口的决定"))).toBe(true);
    // Two summaries: the first window's and the second's. The retry re-reads
    // the first window but must not write a third.
    expect((await summaries()).length).toBe(2);
  });

  it("is not retried again once a retry succeeded", async () => {
    await addWindow("first");
    await compactor(failing).forceCompact(conversationId);
    await addWindow("second");
    await compactor(answeringPerWindow).forceCompact(conversationId);

    const settled = (await events())[0];
    // Precondition: the retry actually recovered something.
    expect(settled.extractionAdded).toBeGreaterThan(0);
    const retriesWhenSettled = settled.extractionRetries;

    await addWindow("third");
    await compactor(answeringPerWindow).forceCompact(conversationId);

    // A later window's batch may well re-read the first window's leftovers --
    // the fresh tail defers them -- so the prompts are not the evidence. The
    // event is: a settled window is never picked up again.
    expect((await events())[0].extractionRetries).toBe(retriesWhenSettled);
  });

  it("does not spend a second call on a window whose first retry worked", async () => {
    // The retry runs at the end of the same run, so a window can settle with
    // one retry left in its budget. Without checking whether anything was
    // extracted, the next run would pay for it again.
    await addWindow("first");
    let call = 0;
    await compactor(async (prompt) => {
      call++;
      if (call === 1) return failing();
      return prompt.includes("first") ? reply("首轮补做就成功") : reply("其他");
    }).forceCompact(conversationId);

    const settled = (await events())[0];
    expect(settled.extractionAdded).toBeGreaterThan(0);
    expect(settled.extractionRetries).toBe(1);

    await addWindow("second");
    await compactor(answeringPerWindow).forceCompact(conversationId);

    expect((await events())[0].extractionRetries).toBe(1);
  });

  it("gives up after a second failure instead of retrying forever", async () => {
    await addWindow("first");
    await compactor(failing).forceCompact(conversationId);
    await addWindow("second");
    await compactor(failing).forceCompact(conversationId);
    await addWindow("third");
    await compactor(failing).forceCompact(conversationId);

    const rows = await events();
    const retried = rows.filter((e: any) => (e.extractionRetries ?? 0) > 0);
    // Precondition: retries were actually attempted, or the bound below is
    // satisfied by a system that never retries at all.
    expect(retried.length).toBeGreaterThan(0);
    for (const row of retried) expect(row.extractionRetries).toBeLessThanOrEqual(2);
  });

  it("is not retried once its extraction has run", async () => {
    await addWindow("first");
    await compactor(answeringPerWindow).forceCompact(conversationId);
    await addWindow("second");
    calls = [];
    await compactor(answeringPerWindow).forceCompact(conversationId);

    // One call for the second window's own summary, and no retry call.
    expect(calls.length).toBe(1);
  });
});
