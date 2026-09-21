/**
 * CodeMemory must not learn from its own output.
 *
 * Printing recalled memory in a tool result -- the check-prior-failures tool,
 * a debugging query, a status command -- put the stored error text back into
 * the transcript. The scorer's inferred-error patterns then saw `error TS2322`
 * in a tool result that exited 0, promoted it to an error, and the extractor
 * wrote a new *active* failure node from it. Observed on a live database: the
 * same `broken.ts(3,9)` failure stored four times, the latest one minutes
 * after its predecessor was displayed. Every display is another copy, and
 * every copy is another candidate to display.
 *
 * The rendered forms are produced by the real renderers here, so a change to
 * either format breaks this test instead of silently reopening the loop.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scoreMessage, createSessionState } from "../src/filter/scorer.js";
import type { JsonlMessage, RawMessagePart } from "../src/hooks/jsonl-watcher.js";
import { renderFailureMarkdown } from "../src/failure-lookup.js";
import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { MemoryRetrievalEngine } from "../src/memory-retrieval.js";
import { createFastRetrievalPlan } from "../src/retrieval-plan.js";

const TS_ERROR = "broken.ts(3,9): error TS2322: Type 'number' is not assignable to type 'string'.";

function toolResult(text: string): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_result", content: text, tool_use_id: "orphan_id" },
  ];
  return {
    id: `user-${Math.random()}`,
    type: "user",
    role: "user",
    content: `[tool_result] ${text}`,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

function inferred(text: string): boolean {
  const tags = scoreMessage(toolResult(text), createSessionState()).tags;
  return tags.includes("error") || tags.includes("error_inferred");
}

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-echo-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function renderedRetrieval(): Promise<string> {
  const store = createMemoryNodeStore(db);
  await store.upsertNode({
    nodeId: "failure-echo",
    kind: "failure",
    conversationId: 1,
    source: "failure_extractor",
    sourceId: "failure-echo",
    content: `[FAILURE] type_error: ${TS_ERROR}`,
    tags: [
      { tagType: "kind", tagValue: "failure", weight: 2.1 },
      { tagType: "topic", tagValue: "retrieval", weight: 1.5 },
    ],
  });
  const result = await new MemoryRetrievalEngine(store).retrieve({
    plan: createFastRetrievalPlan("检索失败是怎么修的"),
    conversationId: 1,
  });
  return result.markdown;
}

describe("recalled memory in a tool result", () => {
  it("is precondition-checked: the raw error on its own is inferred", () => {
    // Without this, every assertion below passes if the pattern simply never
    // matched TS2322 at all.
    expect(inferred(TS_ERROR)).toBe(true);
  });

  it("does not count as a new error when it is a prior-failure warning", () => {
    const md = renderFailureMarkdown([
      {
        type: "type_error",
        filePath: "broken.ts",
        raw: TS_ERROR,
        createdAt: new Date().toISOString(),
      } as any,
    ]);
    expect(md).toContain("TS2322");
    expect(inferred(md)).toBe(false);
  });

  it("does not count as a new error when it is retrieval output", async () => {
    const md = await renderedRetrieval();
    expect(md).toContain("TS2322");
    expect(inferred(md)).toBe(false);
  });

  it("still lets a real error printed alongside it through", async () => {
    // Stripping has to remove the echo, not the whole result.
    const md = await renderedRetrieval();
    expect(inferred(`${md}\n\nsrc/app.ts(10,5): error TS2345: Argument of type 'x' is not assignable.`)).toBe(true);
  });

  it("is recognized when the result arrives as a list of text blocks", async () => {
    const md = await renderedRetrieval();
    const msg = toolResult(md);
    (msg.metadata!.parts as RawMessagePart[])[0].content = [{ type: "text", text: md }] as any;
    const tags = scoreMessage(msg, createSessionState()).tags;
    expect(tags).not.toContain("error_inferred");

    // And a real error in block form is still caught.
    (msg.metadata!.parts as RawMessagePart[])[0].content = [{ type: "text", text: TS_ERROR }] as any;
    expect(scoreMessage(msg, createSessionState()).tags).toContain("error_inferred");
  });
});
