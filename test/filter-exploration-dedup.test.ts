/**
 * Unit tests for Filter/Score #5 — exploration dedup fixes:
 *   (a) time window (stale targets outside the window re-qualify as L)
 *   (b) cross-daemon persistence via the explored_targets table
 *   (c) Grep key now includes path/glob/type, not just pattern
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  scoreMessage,
  createSessionState,
  type ScorerSessionState,
} from "../src/filter/scorer.js";
import {
  loadExploredTargets,
  flushExploredTargets,
} from "../src/filter/explored-targets-store.js";
import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import type { JsonlMessage, RawMessagePart } from "../src/hooks/jsonl-watcher.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let state: ScorerSessionState;

beforeEach(() => {
  state = createSessionState();
});

function assistantToolUse(
  toolName: string,
  input: any,
  id: string = "tu_" + Math.random()
): JsonlMessage {
  const parts: RawMessagePart[] = [
    { type: "tool_use", name: toolName, input, id },
  ];
  return {
    id: `a-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("(a) time-window dedup", () => {
  it("same Read within window → second one is N", () => {
    const t0 = 1_000_000;
    const first = scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0, exploredTargetWindowMs: 30 * 60 * 1000 }
    );
    expect(first.tier).toBe("L");
    const second = scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0 + 60_000, exploredTargetWindowMs: 30 * 60 * 1000 }
    );
    expect(second.tier).toBe("N");
  });

  it("same Read past window → second one re-qualifies as L", () => {
    const t0 = 1_000_000;
    const windowMs = 30 * 60 * 1000;
    const first = scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0, exploredTargetWindowMs: windowMs }
    );
    expect(first.tier).toBe("L");
    const later = scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0 + windowMs + 1, exploredTargetWindowMs: windowMs }
    );
    expect(later.tier).toBe("L");
  });

  it("lastSeenAt is NOT refreshed on a duplicate hit (otherwise the window would never expire)", () => {
    const t0 = 1_000_000;
    const windowMs = 30 * 60 * 1000;
    scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0, exploredTargetWindowMs: windowMs }
    );
    // Duplicate hit at t0+10min — should NOT refresh lastSeen
    scoreMessage(
      assistantToolUse("Read", { file_path: "/a.ts" }),
      state,
      { nowMs: t0 + 10 * 60 * 1000, exploredTargetWindowMs: windowMs }
    );
    const stored = state.exploredTargets.get("Read:/a.ts");
    expect(stored).toBe(t0);
  });
});

describe("(c) Grep key includes path/glob/type", () => {
  it("same pattern, different paths → both qualify as L", () => {
    const t0 = 1_000_000;
    const a = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", path: "/src/a" }),
      state,
      { nowMs: t0, exploredTargetWindowMs: 30 * 60 * 1000 }
    );
    expect(a.tier).toBe("L");
    const b = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", path: "/src/b" }),
      state,
      { nowMs: t0 + 1000, exploredTargetWindowMs: 30 * 60 * 1000 }
    );
    expect(b.tier).toBe("L");
  });

  it("same pattern, different glob → both qualify as L", () => {
    const t0 = 1_000_000;
    const a = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", glob: "*.ts" }),
      state,
      { nowMs: t0 }
    );
    expect(a.tier).toBe("L");
    const b = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", glob: "*.tsx" }),
      state,
      { nowMs: t0 + 1000 }
    );
    expect(b.tier).toBe("L");
  });

  it("same pattern + same path + same glob → second is N", () => {
    const t0 = 1_000_000;
    const input = { pattern: "foo", path: "/src", glob: "*.ts" };
    const a = scoreMessage(assistantToolUse("Grep", input), state, { nowMs: t0 });
    expect(a.tier).toBe("L");
    const b = scoreMessage(assistantToolUse("Grep", input), state, { nowMs: t0 + 1000 });
    expect(b.tier).toBe("N");
  });

  it("same pattern, different type filter → both qualify as L", () => {
    const t0 = 1_000_000;
    const a = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", type: "js" }),
      state,
      { nowMs: t0 }
    );
    const b = scoreMessage(
      assistantToolUse("Grep", { pattern: "foo", type: "py" }),
      state,
      { nowMs: t0 + 1000 }
    );
    expect(a.tier).toBe("L");
    expect(b.tier).toBe("L");
  });
});

describe("(b) persistence round-trip via explored_targets table", () => {
  let tmp: string;
  let db: any;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "codememory-explored-"));
    db = await createCodeMemoryDatabaseConnection(join(tmp, "test.db"));
    // conversation with id 1 must exist for FK
    await db.run(
      `INSERT INTO conversations (conversationId, sessionId) VALUES (?, ?)`,
      1,
      "s1"
    );
  });

  afterEach(async () => {
    try {
      await db?.close();
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("flushExploredTargets persists dirty entries and clears dirty set", async () => {
    const s = createSessionState();
    s.exploredTargets.set("Read:/a.ts", 1_000);
    s._dirtyTargets.add("Read:/a.ts");
    await flushExploredTargets(db, 1, s);
    expect(s._dirtyTargets.size).toBe(0);

    const rows = await db.all(
      `SELECT target, lastSeenAt FROM explored_targets WHERE conversationId = 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("Read:/a.ts");
    expect(rows[0].lastSeenAt).toBe(1_000);
  });

  it("loadExploredTargets rehydrates entries within window", async () => {
    // Two entries: one fresh (should load), one stale (should skip)
    const nowMs = 10_000_000;
    const fresh = nowMs - 60_000; // 1 min ago
    const stale = nowMs - 60 * 60 * 1000; // 1 hour ago
    await db.run(
      `INSERT INTO explored_targets (conversationId, target, lastSeenAt) VALUES (1, 'Read:/fresh.ts', ?)`,
      fresh
    );
    await db.run(
      `INSERT INTO explored_targets (conversationId, target, lastSeenAt) VALUES (1, 'Read:/stale.ts', ?)`,
      stale
    );

    const loaded = await loadExploredTargets(
      db,
      1,
      30 * 60 * 1000,
      nowMs
    );
    expect(loaded.has("Read:/fresh.ts")).toBe(true);
    expect(loaded.has("Read:/stale.ts")).toBe(false);
  });

  it("end-to-end: daemon restart preserves dedup across session", async () => {
    const nowMs = 10_000_000;
    const windowMs = 30 * 60 * 1000;

    // --- "daemon 1" — score a Read, flush
    const s1 = createSessionState();
    scoreMessage(
      assistantToolUse("Read", { file_path: "/persisted.ts" }),
      s1,
      { nowMs, exploredTargetWindowMs: windowMs }
    );
    await flushExploredTargets(db, 1, s1);

    // --- "daemon 2" — fresh state, rehydrate, then score the same Read
    const s2 = createSessionState();
    const loaded = await loadExploredTargets(db, 1, windowMs, nowMs + 60_000);
    for (const [k, v] of loaded) s2.exploredTargets.set(k, v);

    const second = scoreMessage(
      assistantToolUse("Read", { file_path: "/persisted.ts" }),
      s2,
      { nowMs: nowMs + 60_000, exploredTargetWindowMs: windowMs }
    );
    expect(second.tier).toBe("N");
  });

  it("upsert semantics: flushing twice updates lastSeenAt in place", async () => {
    const s = createSessionState();
    s.exploredTargets.set("Read:/a.ts", 1_000);
    s._dirtyTargets.add("Read:/a.ts");
    await flushExploredTargets(db, 1, s);

    s.exploredTargets.set("Read:/a.ts", 2_000);
    s._dirtyTargets.add("Read:/a.ts");
    await flushExploredTargets(db, 1, s);

    const rows = await db.all(
      `SELECT target, lastSeenAt FROM explored_targets WHERE conversationId = 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSeenAt).toBe(2_000);
  });
});
