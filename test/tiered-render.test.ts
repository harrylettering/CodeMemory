/**
 * Render a node in full only when the prompt asked for it.
 *
 * The planner adds kind tags (`kind=task`, `kind=constraint`, ...) to nearly
 * every prompt, so every active task matches every prompt. Replaying 120 real
 * prompts: 43% of injected characters came from nodes matched on their kind
 * alone, and in 54 of 112 turns nothing matched on anything else -- the whole
 * injection was kind matches. That is why no prompt was ever answered with an
 * empty injection.
 *
 * A node the prompt matched on a file, symbol, topic or phrase keeps its full
 * snippet. A kind-only match becomes one short line: enough to say the task
 * exists, not enough to crowd out what was asked for. It keeps the
 * `- (kind, status, score N)` prefix, which is what the scorer uses to
 * recognize CodeMemory's own output (test/recall-echo.test.ts).
 *
 * Not index-plus-fetch: across 235 transcripts the model never once invoked a
 * CodeMemory skill on its own, so a design that needs it to fetch the full
 * text would in practice recall less, not better.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore, type MemoryNodeStore } from "../src/store/memory-store.js";
import { MemoryRetrievalEngine } from "../src/memory-retrieval.js";
import { createFastRetrievalPlan } from "../src/retrieval-plan.js";

let dbDir: string;
let db: any;
let store: MemoryNodeStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-tiered-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = createMemoryNodeStore(db);
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

// A marker between the short line's 80 characters and the full render's
// 340-character cap: visible only when the node is rendered in full. Real task
// nodes run to that cap, so the fixtures are long too.
const FILLER = " and then a long explanation that keeps going past any short index line";
const ASKED = "[TASK] Fix the retrieval ranking" + FILLER + " ASKED-MID" + FILLER.repeat(4);
const UNASKED = "[TASK] Migrate the billing exporter" + FILLER + " UNASKED-MID" + FILLER.repeat(4);

async function addTask(nodeId: string, content: string, topic: string) {
  await store.upsertNode({
    nodeId,
    kind: "task",
    conversationId: 1,
    source: "codememory_mark_requirement",
    sourceId: nodeId,
    content,
    tags: [
      { tagType: "kind", tagValue: "task", weight: 2.0 },
      { tagType: "topic", tagValue: topic, weight: 1.5 },
    ],
  });
}

async function render(prompt: string) {
  const result = await new MemoryRetrievalEngine(store).retrieve({
    plan: createFastRetrievalPlan(prompt),
    conversationId: 1,
  });
  return result;
}

function lineFor(markdown: string, marker: string): string {
  const head = marker.slice(0, 30);
  const line = markdown.split("\n").find((l) => l.includes(head));
  if (!line) throw new Error(`no line for ${head} in:\n${markdown}`);
  return line;
}

describe("tiered rendering", () => {
  it("keeps the full snippet for a node the prompt matched on its topic", async () => {
    await addTask("task-asked", ASKED, "retrieval");
    await addTask("task-unasked", UNASKED, "billing");

    const result = await render("检索失败是怎么修的");
    // Precondition: both were injected, one by topic and one by kind alone.
    const byId = new Map(result.nodes.map((c) => [c.node.nodeId, c]));
    expect(byId.get("task-asked")?.matchedTags.some((t) => t.tagType !== "kind")).toBe(true);
    expect(byId.get("task-unasked")?.matchedTags.every((t) => t.tagType === "kind")).toBe(true);

    expect(lineFor(result.markdown, ASKED)).toContain("ASKED-MID");
  });

  it("shortens a node that matched on its kind alone", async () => {
    await addTask("task-asked", ASKED, "retrieval");
    await addTask("task-unasked", UNASKED, "billing");

    const result = await render("检索失败是怎么修的");
    const line = lineFor(result.markdown, UNASKED);
    expect(line).not.toContain("UNASKED-MID");
    expect(line).toContain("Migrate the billing exporter");
    // Still recognizable as CodeMemory's own output.
    expect(line).toMatch(/^- \(task, active, score -?[\d.]+\) /);
  });

  it("injects less in a turn where nothing was asked for", async () => {
    await addTask("task-unasked", UNASKED, "billing");
    await addTask("task-unasked-2", UNASKED.replace("billing", "search"), "search");

    const result = await render("当前的任务是什么");
    expect(result.nodes.length).toBe(2);
    expect(result.markdown).not.toContain("UNASKED-MID");
    // Two unasked tasks now cost less than one used to.
    expect(result.markdown.length).toBeLessThan(UNASKED.length);
  });
});
