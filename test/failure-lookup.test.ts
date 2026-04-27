/**
 * Integration test for the PreToolUse failure-lookup path.
 *
 * Spins up a temp SQLite DB, seeds a failure memory_node, then calls
 * `lookupForPreToolUse` exactly the way the daemon socket handler does.
 * Asserts the response shape, confidence floor, decay, and the daemon-
 * level auto-resolve / user-signal sweeps.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import {
  createMemoryNodeStore,
  type MemoryNodeRecord,
} from "../src/store/memory-store.js";
import {
  lookupForPreToolUse,
  decayFactor,
  scoreMatch,
} from "../src/failure-lookup.js";

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-failure-lookup-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  // Seed a conversation row so foreign keys are happy.
  await db.run(
    `INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')`
  );
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

interface SeedInput {
  conversationId?: number;
  seq?: number;
  type?: string;
  signature?: string;
  raw?: string;
  filePath?: string;
  command?: string;
  symbol?: string;
  attemptedFix?: string;
  weight?: number;
  sessionId?: string;
}

async function seed(input: SeedInput = {}) {
  const memoryStore = createMemoryNodeStore(db);
  // `??` would override an explicit `undefined`, but tests use
  // `filePath: undefined` to mean "command-only failure" — so prefer
  // `"key" in input` semantics for fields the tests want to clear.
  const filePath =
    "filePath" in input ? input.filePath : "/repo/src/foo.ts";
  return memoryStore.createFailureNode({
    conversationId: input.conversationId ?? 1,
    sessionId: input.sessionId ?? "sess-A",
    seq: input.seq ?? 1,
    type: input.type ?? "type_error",
    signature: input.signature ?? "TS2345 argument not assignable",
    raw:
      input.raw ?? "src/foo.ts(12,3): error TS2345: Argument not assignable",
    filePath,
    command: input.command,
    symbol: input.symbol,
    attemptedFix:
      input.attemptedFix ?? "[Edit] /repo/src/foo.ts — added wrong type",
    weight: input.weight ?? 1.0,
  });
}

describe("lookupForPreToolUse", () => {
  it("injects when an Edit hits a previously failed file", async () => {
    await seed();
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/foo.ts",
      old_string: "x",
      new_string: "y",
    });

    expect(response.shouldInject).toBe(true);
    expect(response.failures).toHaveLength(1);
    expect(response.markdown).toBeTruthy();
    expect(response.markdown).toContain("/repo/src/foo.ts");
    expect(response.markdown).toContain("type_error");
  });

  it("injects across sessions (the whole point of cross-session recall)", async () => {
    await seed({ sessionId: "sess-A" });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/foo.ts",
    });

    expect(response.shouldInject).toBe(true);
  });

  it("does NOT inject for unrelated file paths", async () => {
    await seed();
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/unrelated.ts",
    });

    expect(response.shouldInject).toBe(false);
    expect(response.failures).toHaveLength(0);
  });

  it("matches Bash commands by leading binary token", async () => {
    await seed({
      filePath: undefined,
      command: "npm test -- --watchAll=false",
      type: "exit_error",
      signature: "npm test failed exit code 1",
      raw: "npm ERR! code ELIFECYCLE",
    });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Bash", {
      command: "npm test",
    });

    expect(response.shouldInject).toBe(true);
    expect(response.markdown).toContain("npm test");
  });

  it("hides resolved failures", async () => {
    const node = await seed();
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.resolveFailureNodesByTarget({
      conversationId: 1,
      target: { filePath: "/repo/src/foo.ts" },
      resolution: "fixed via zod parse",
    });
    expect((await memoryStore.getNode(node.nodeId))?.status).toBe("resolved");

    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/foo.ts",
    });

    expect(response.shouldInject).toBe(false);
  });
});

describe("symbol-aware retrieval", () => {
  it("renders the symbol in the markdown when present", async () => {
    await seed({ symbol: "validateUser" });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/foo.ts",
    });
    expect(response.shouldInject).toBe(true);
    expect(response.markdown).toContain("validateUser");
    expect(response.markdown).toContain("::");
  });
});

describe("confidence threshold", () => {
  it("suppresses cross-subcommand Bash matches (git push vs git status)", async () => {
    await seed({
      filePath: undefined,
      command: "git push origin main",
      type: "exit_error",
      signature: "git push rejected non fast forward",
      raw: "! [rejected]    main -> main (non-fast-forward)",
    });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Bash", {
      command: "git status",
    });

    expect(response.shouldInject).toBe(false);
  });

  it("suppresses weak single-token matches", async () => {
    await seed({
      filePath: undefined,
      command: "ls -la /nonexistent",
      type: "file_not_found",
      signature: "ls cannot access No such file or directory",
      raw: "ls: cannot access '/nonexistent': No such file or directory",
    });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Bash", {
      command: "ls",
    });

    expect(response.shouldInject).toBe(false);
  });

  it("keeps strong two-token Bash matches", async () => {
    await seed({
      filePath: undefined,
      command: "npm test -- --watchAll=false",
      type: "exit_error",
      signature: "npm test failed",
      raw: "FAIL src/foo.test.ts",
    });
    const memoryStore = createMemoryNodeStore(db);

    const response = await lookupForPreToolUse(memoryStore, "Bash", {
      command: "npm test",
    });

    expect(response.shouldInject).toBe(true);
  });
});

describe("time-decay", () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it("decayFactor: fresh = 1.0", () => {
    const now = Date.now();
    expect(decayFactor(new Date(now).toISOString(), now)).toBeCloseTo(1.0, 3);
  });

  it("decayFactor: 30 days ≈ 0.5 (one half-life)", () => {
    const now = Date.now();
    const created = new Date(now - 30 * MS_PER_DAY).toISOString();
    expect(decayFactor(created, now)).toBeCloseTo(0.5, 2);
  });

  it("decayFactor: 90 days ≈ 0.125 (three half-lives)", () => {
    const now = Date.now();
    const created = new Date(now - 90 * MS_PER_DAY).toISOString();
    expect(decayFactor(created, now)).toBeCloseTo(0.125, 2);
  });

  it("decayFactor: missing createdAt → 1.0 (no decay)", () => {
    expect(decayFactor(undefined)).toBe(1.0);
  });

  it("scoreMatch: 90-day-old filePath match drops below threshold", () => {
    const now = Date.now();
    const ancient = makeNode({
      createdAt: new Date(now - 90 * MS_PER_DAY).toISOString(),
      filePath: "/repo/foo.ts",
    });
    expect(scoreMatch(ancient, { filePath: "/repo/foo.ts" }, now)).toBeLessThan(
      0.6
    );
  });

  it("scoreMatch: week-old filePath match still above threshold", () => {
    const now = Date.now();
    const week = makeNode({
      createdAt: new Date(now - 7 * MS_PER_DAY).toISOString(),
      filePath: "/repo/foo.ts",
    });
    expect(scoreMatch(week, { filePath: "/repo/foo.ts" }, now)).toBeGreaterThan(
      0.6
    );
  });

  it("end-to-end: stale failure gets filtered by lookup", async () => {
    const node = await seed();
    const oldDate = new Date(Date.now() - 120 * MS_PER_DAY).toISOString();
    await db.run(`UPDATE memory_nodes SET createdAt = ? WHERE nodeId = ?`, [
      oldDate,
      node.nodeId,
    ]);

    const memoryStore = createMemoryNodeStore(db);
    const response = await lookupForPreToolUse(memoryStore, "Edit", {
      file_path: "/repo/src/foo.ts",
    });

    expect(response.shouldInject).toBe(false);
    expect(response.reason).toMatch(/below confidence/i);
  });
});

describe("autoResolveStaleFailureNodes", () => {
  it("marks active failures past the staleness window", async () => {
    await seed({ seq: 5 });
    const memoryStore = createMemoryNodeStore(db);

    const n = await memoryStore.autoResolveStaleFailureNodes({
      conversationId: 1,
      currentSeq: 100,
      olderThanSeqs: 50,
      resolution: "auto: stale",
    });
    expect(n).toBe(1);

    const row = await db.get(
      `SELECT status, json_extract(metadata, '$.resolution') AS resolution FROM memory_nodes WHERE kind='failure' AND conversationId=1`
    );
    expect(row.status).toBe("resolved");
    expect(row.resolution).toContain("auto");
  });

  it("does NOT auto-resolve recent failures", async () => {
    await seed({ seq: 90 });
    const memoryStore = createMemoryNodeStore(db);

    const n = await memoryStore.autoResolveStaleFailureNodes({
      conversationId: 1,
      currentSeq: 100,
      olderThanSeqs: 50,
      resolution: "auto: stale",
    });
    expect(n).toBe(0);
  });

  it("does NOT auto-resolve when a later occurrence on the same signature exists", async () => {
    await seed({ seq: 5, signature: "same-sig" });
    await seed({ seq: 80, signature: "same-sig" });
    const memoryStore = createMemoryNodeStore(db);

    const n = await memoryStore.autoResolveStaleFailureNodes({
      conversationId: 1,
      currentSeq: 100,
      olderThanSeqs: 50,
      resolution: "auto: stale",
    });
    expect(n).toBe(0);
  });
});

describe("resolveFailureNodesByTarget — user signal", () => {
  it("resolves matching active failures by filePath", async () => {
    await seed();
    const memoryStore = createMemoryNodeStore(db);

    const n = await memoryStore.resolveFailureNodesByTarget({
      conversationId: 1,
      target: { filePath: "/repo/src/foo.ts" },
      resolution: "user said fixed",
    });
    expect(n).toBe(1);

    const row = await db.get(
      `SELECT status FROM memory_nodes WHERE kind='failure' AND conversationId=1`
    );
    expect(row.status).toBe("resolved");
  });

  it("resolves matching failures by command leading token", async () => {
    await seed({
      filePath: undefined,
      command: "npm test --foo",
    });
    const memoryStore = createMemoryNodeStore(db);

    const n = await memoryStore.resolveFailureNodesByTarget({
      conversationId: 1,
      target: { command: "npm test" },
      resolution: "user said fixed",
    });
    expect(n).toBe(1);
  });
});

function makeNode(input: {
  createdAt: string;
  filePath?: string;
  command?: string;
  weight?: number;
}): MemoryNodeRecord {
  return {
    nodeId: "test-node",
    kind: "failure",
    status: "active",
    confidence: input.weight ?? 1.0,
    conversationId: 1,
    sessionId: null,
    source: "test",
    sourceId: "test-node",
    sourceToolUseId: null,
    summaryId: null,
    content: "",
    metadata: {
      filePath: input.filePath,
      command: input.command,
      weight: input.weight ?? 1.0,
    },
    supersedesNodeId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastUsedAt: null,
    useCount: 0,
  };
}
