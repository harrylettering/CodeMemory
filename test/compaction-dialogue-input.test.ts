/**
 * What a compaction call gets to read.
 *
 * Compaction selects `tier IN ('M','L')` -- tool metadata. Decisions, tasks and
 * constraints are stated in prose, which is S tier, and S tier was filtered out
 * of the only LLM call this system makes over a window. Extraction rides that
 * call (see the plan's 5.2), so the window's own dialogue has to be in it.
 *
 * Also fixes the batch size unit. Batches were formed by `tokenCount * 4` as a
 * character estimate; measured on a live database the real ratio is 4.11 and
 * the `[ROLE] ` prefixes are not counted, so 82 of 136 leaf batches exceeded
 * the cap and had their tails cut off -- about 2% of characters never reached
 * the summary. Batching now counts the characters it actually sends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { AsyncCompactor, SUMMARY_PROMPT_PREFIX } from "../src/compaction/compactor.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

let dbDir: string;
let db: any;
let store: ConversationStore;
let conversationId: number;
let prompts: string[];

async function add(
  role: "user" | "assistant",
  tier: "S" | "M" | "L",
  content: string,
  tags: string[] = []
) {
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

/** Enough M-tier volume to cross the compaction threshold. */
async function addToolNoise(n: number, chars = 400) {
  for (let i = 0; i < n; i++) {
    await add("assistant", "M", `[Edit] src/file${i}.ts ${"x".repeat(chars)}`);
  }
}

function compactor(overrides: Record<string, unknown> = {}) {
  return new AsyncCompactor(
    db,
    { ...resolveCodeMemoryConfig(), compactionDisableLlm: false, ...overrides } as any,
    SILENT,
    {
      runCompletion: async (prompt: string) => {
        prompts.push(prompt);
        return "a summary of the window";
      },
    }
  );
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-dialogue-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  conversationId = (await store.getOrCreateConversation({ sessionId: "sess-dialogue" }))
    .conversationId;
  prompts = [];
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("the window's dialogue reaches the compaction call", () => {
  it("includes the user and assistant prose interleaved with the tool calls", async () => {
    await add("user", "S", "先把 agent_id 的标记方案规划出来", ["user_input"]);
    await addToolNoise(30);
    await add("assistant", "S", "方案是按 tool_use_id 关联，不用环境变量", ["assistant_longform"]);
    await addToolNoise(30);

    await compactor().forceCompact(conversationId);

    expect(prompts.length).toBeGreaterThan(0);
    const all = prompts.join("\n");
    expect(all).toContain("先把 agent_id 的标记方案规划出来");
    expect(all).toContain("按 tool_use_id 关联");
  });

  it("leaves out S-tier tool results, which the failure nodes already cover", async () => {
    await add("user", "S", "跑一下测试", ["user_input"]);
    await add("user", "S", "[tool_result] broken.ts(3,9): error TS2322: not assignable", [
      "tool_result",
      "error",
    ]);
    await addToolNoise(60);

    await compactor().forceCompact(conversationId);

    const all = prompts.join("\n");
    expect(all).toContain("跑一下测试");
    expect(all).not.toContain("TS2322");
  });

  it("adds nothing when the window has no dialogue at all", async () => {
    // 16% of real windows are pure tool calls. Nothing to extract there, so
    // they must not pay for a dialogue section.
    await addToolNoise(60);

    await compactor().forceCompact(conversationId);

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join("\n")).not.toContain("DIALOGUE");
  });

  it("keeps the most recent dialogue when it exceeds its budget", async () => {
    await add("assistant", "S", "OLDEST " + "老内容 ".repeat(400), ["assistant_longform"]);
    await add("assistant", "S", "NEWEST 最后的结论", ["assistant_longform"]);
    await addToolNoise(60);

    await compactor({ compactionDialogueChars: 600 }).forceCompact(conversationId);

    const all = prompts.join("\n");
    expect(all).toContain("NEWEST 最后的结论");
    expect(all).not.toContain("OLDEST");
  });
});

describe("batches are sized by the characters actually sent", () => {
  it("never renders a batch longer than the batch budget", async () => {
    // tokenCount deliberately understates the content, which is what happened
    // in production: the estimate said 4 chars per token, the real text was
    // longer, and the tail was cut off inside summarize().
    for (let i = 0; i < 40; i++) {
      await store.insertMessage({
        conversationId,
        role: "assistant",
        content: `[Bash] ${"y".repeat(1000)}`,
        tokenCount: 10, // a tenth of the truth
        tier: "M",
        parts: [{ partType: "text", textContent: "x" }],
      });
    }

    await compactor({ compactionBatchChars: 5000 }).forceCompact(conversationId);

    expect(prompts.length).toBeGreaterThan(1);
    for (const p of prompts) {
      expect(p).not.toContain("truncated for compaction");
    }
  });

  it("caps the whole prompt at compactionMaxInputChars", async () => {
    await add("user", "S", "问题描述 ".repeat(2000), ["user_input"]);
    await addToolNoise(60, 800);

    await compactor({
      compactionMaxInputChars: 12000,
      compactionBatchChars: 8000,
      compactionDialogueChars: 8000,
    }).forceCompact(conversationId);

    // The cap bounds the transcript, not the fixed instructions.
    for (const p of prompts) {
      const transcript = p.slice(p.indexOf(SUMMARY_PROMPT_PREFIX) + SUMMARY_PROMPT_PREFIX.length);
      const withoutMetadataInstruction = transcript.slice(transcript.indexOf("\n\n") + 2);
      expect(withoutMetadataInstruction.length).toBeLessThanOrEqual(12000);
    }
  });
});
