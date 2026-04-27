import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { CodeMemoryExpansionEngine } from "../src/expansion.js";

let dbDir: string;
let db: any;
let expansion: CodeMemoryExpansionEngine;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-expand-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  expansion = new CodeMemoryExpansionEngine(new ConversationStore(db), new SummaryStore(db));
  await db.run("INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')");
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("CodeMemoryExpansionEngine DAG traversal", () => {
  it("expands condensed summaries to their leaf children", async () => {
    await insertSummary("leaf-1", "leaf", 0, "leaf one");
    await insertSummary("leaf-2", "leaf", 0, "leaf two");
    await insertSummary("cond-1", "condensed", 1, "condensed");
    await db.run(
      "INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)",
      ["leaf-1", "cond-1", 0]
    );
    await db.run(
      "INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)",
      ["leaf-2", "cond-1", 1]
    );

    const result = await expansion.expand({
      summaryId: "cond-1",
      depth: 1,
      includeMessages: false,
      tokenCap: 1000,
    });

    expect(result.found).toBe(true);
    expect(result.children.map((child) => child.summaryId)).toEqual(["leaf-1", "leaf-2"]);
  });

  it("reports missing summary ids instead of silently returning empty success", async () => {
    const result = await expansion.expand({ summaryId: "missing", depth: 1 });

    expect(result.found).toBe(false);
    expect(result.reason).toBe("summary_not_found");
    expect(result.children).toEqual([]);
    expect(result.messages).toEqual([]);
  });
});

async function insertSummary(
  summaryId: string,
  kind: "leaf" | "condensed",
  depth: number,
  content: string
) {
  await db.run(
    `INSERT INTO summaries (
       summaryId, conversationId, kind, depth, earliestAt, latestAt,
       descendantCount, content, tokenCount
     ) VALUES (?, 1, ?, ?, ?, ?, 1, ?, ?)`,
    [
      summaryId,
      kind,
      depth,
      "2026-04-22T00:00:00.000Z",
      "2026-04-22T00:00:00.000Z",
      content,
      Math.ceil(content.length / 4),
    ]
  );
}
