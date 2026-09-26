/**
 * Extraction, end to end through the compaction call.
 *
 * The three prose kinds have never had a live producer: mark skills are never
 * invoked on their own, and the re-import extractor only runs on re-import. On
 * the live database all 88 decision/task/constraint nodes came from two
 * re-imports, and none in the last nine days.
 *
 * This is the path that produces them during ordinary work: the window's
 * dialogue and its existing memories go into the summary call, and what comes
 * back is written through the same lifecycle the mark skills use.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
let prompts: string[];

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

async function addToolNoise(n: number) {
  for (let i = 0; i < n; i++) await add("assistant", "M", `[Edit] src/file${i}.ts ${"x".repeat(200)}`);
}

function compactor(reply: string) {
  return new AsyncCompactor(
    db,
    { ...resolveCodeMemoryConfig(), compactionDisableLlm: false } as any,
    SILENT,
    {
      runCompletion: async (prompt: string) => {
        prompts.push(prompt);
        return reply;
      },
    }
  );
}

const header = (memories: unknown[]) =>
  `${JSON.stringify({ anchor: false, kinds: [], memories })}\n\nA summary of the window.`;

async function nodes(kind: string) {
  return db.all("SELECT * FROM memory_nodes WHERE kind = ?", kind);
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-x2e-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  conversationId = (await store.getOrCreateConversation({ sessionId: "sess-x2e" })).conversationId;
  prompts = [];
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("a compaction call that extracts", () => {
  it("asks for memories and stores what comes back", async () => {
    await add("user", "S", "用 tool_use_id 关联 agent 身份", ["user_input"]);
    await addToolNoise(60);

    await compactor(
      header([{ kind: "decision", op: "ADD", text: "用 tool_use_id 关联 agent 身份，不用环境变量" }])
    ).forceCompact(conversationId);

    // The instruction reached the model...
    expect(prompts.join("\n")).toContain("memories");
    // ...and the answer reached the store.
    const decisions = await nodes("decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toContain("tool_use_id");
    expect(decisions[0].conversationId).toBe(conversationId);
  });

  it("shows the model what this session already knows", async () => {
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.createTaskNode({
      conversationId,
      task: "Add sourceUuid column",
      content: "[TASK] Add sourceUuid column Details: dedupe transcript lines",
    } as any);
    await add("user", "S", "sourceUuid 已经合并了", ["user_input"]);
    await addToolNoise(60);

    await compactor(header([])).forceCompact(conversationId);

    const prompt = prompts.join("\n");
    expect(prompt).toContain("Add sourceUuid column");
    // Titles only: the rationale after `Details:` costs tokens on every call.
    expect(prompt).not.toContain("dedupe transcript lines");
  });

  it("retires a task the window finished, naming it by the id it was shown", async () => {
    const memoryStore = createMemoryNodeStore(db);
    const task = await memoryStore.createTaskNode({
      conversationId,
      task: "Add sourceUuid column",
      content: "[TASK] Add sourceUuid column",
    } as any);
    await add("user", "S", "sourceUuid 那个任务做完了", ["user_input"]);
    await addToolNoise(60);

    await compactor(
      header([{ kind: "task", op: "INVALIDATE", targetNodeId: task.nodeId, reason: "merged" }])
    ).forceCompact(conversationId);

    const row = await db.get("SELECT status FROM memory_nodes WHERE nodeId = ?", task.nodeId);
    expect(row.status).toBe("stale");
  });

  it("refuses an id it was never shown", async () => {
    const memoryStore = createMemoryNodeStore(db);
    const task = await memoryStore.createTaskNode({
      conversationId,
      task: "Untouched",
      content: "[TASK] Untouched",
    } as any);
    // An older window was already compacted, so this node is not a "recent
    // write", and nothing surfaced it in this window either.
    await db.run("UPDATE memory_nodes SET updatedAt = '2020-01-01T00:00:00.000Z' WHERE nodeId = ?", task.nodeId);
    await db.run(
      `INSERT INTO summaries (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount, createdAt)
       VALUES ('leaf-old', ?, 'leaf', 0, '2021-01-01', '2021-01-02', 1, 'older window', 10, '2021-01-02T00:00:00.000Z')`,
      conversationId
    );
    await add("user", "S", "随便说点什么", ["user_input"]);
    await addToolNoise(60);

    await compactor(
      header([{ kind: "task", op: "INVALIDATE", targetNodeId: task.nodeId, reason: "guessed" }])
    ).forceCompact(conversationId);

    const row = await db.get("SELECT status FROM memory_nodes WHERE nodeId = ?", task.nodeId);
    expect(row.status).toBe("active");
  });

  it("asks for nothing when the window has no dialogue", async () => {
    // 16% of real windows are pure tool calls. They must not pay for the
    // instruction, the candidate list, or the dialogue section.
    await addToolNoise(60);

    await compactor(header([])).forceCompact(conversationId);

    expect(prompts.join("\n")).not.toContain("memories");
  });

  it("ignores memories reported for a window with no dialogue", async () => {
    // Nothing was said there, so a reported decision can only have been
    // invented from tool calls -- which the instruction forbids, and which
    // the instruction was not even sent for this window.
    await addToolNoise(60);

    await compactor(
      header([{ kind: "decision", op: "ADD", text: "Invented from edits alone" }])
    ).forceCompact(conversationId);

    expect(await nodes("decision")).toEqual([]);
  });

  it("still writes the summary when extraction comes back empty", async () => {
    await add("user", "S", "继续", ["user_input"]);
    await addToolNoise(60);

    await compactor("Just a summary, no JSON header at all.").forceCompact(conversationId);

    const summaries = await db.get("SELECT COUNT(*) n FROM summaries");
    expect(summaries.n).toBeGreaterThan(0);
    expect(await nodes("decision")).toEqual([]);
  });
});

describe("what the run reports", () => {
  it("records the extraction outcome next to the compaction", async () => {
    await add("user", "S", "决定：只发标题", ["user_input"]);
    await addToolNoise(60);

    await compactor(
      header([
        { kind: "decision", op: "ADD", text: "只发标题，不发内容" },
        { kind: "task", op: "INVALIDATE", targetNodeId: "task-9-99", reason: "invented" },
      ])
    ).forceCompact(conversationId);

    const row = await db.get(
      "SELECT extractionAdded, extractionRejected, candidateCount FROM compaction_events ORDER BY eventId DESC LIMIT 1"
    );
    expect(row.extractionAdded).toBe(1);
    expect(row.extractionRejected).toBe(1);
    expect(row.candidateCount).toBe(0);
  });
});
