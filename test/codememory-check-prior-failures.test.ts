/**
 * Tests for `codememory_check_prior_failures` — verifies the model-callable
 * failure lookup honors filePath / command / symbol pivots and the same
 * confidence floor as the PreToolUse daemon path.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { CodeMemoryCheckPriorFailuresTool } from "../src/tools/codememory-check-prior-failures-tool.js";

let dbDir: string;
let db: any;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-check-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
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
  nodeIdOverride?: string;
}

async function seed(input: SeedInput = {}) {
  const memoryStore = createMemoryNodeStore(db);
  return memoryStore.createFailureNode({
    conversationId: input.conversationId ?? 1,
    sessionId: "sess-A",
    seq: input.seq ?? 1,
    type: input.type ?? "type_error",
    signature: input.signature ?? "TS2345 argument not assignable",
    raw:
      input.raw ?? "src/foo.ts(12,3): error TS2345: Argument not assignable",
    filePath: input.filePath ?? "/repo/src/foo.ts",
    command: input.command,
    symbol: input.symbol,
    attemptedFix:
      input.attemptedFix ?? "[Edit] /repo/src/foo.ts — added wrong type",
    weight: input.weight ?? 1.0,
    nodeIdOverride: input.nodeIdOverride,
  });
}

function newTool() {
  return new CodeMemoryCheckPriorFailuresTool(createMemoryNodeStore(db));
}

describe("CodeMemoryCheckPriorFailuresTool", () => {
  it("finds a seeded failure by filePath and reports confidence", async () => {
    await seed();

    const result = await newTool().check({ filePath: "/repo/src/foo.ts" });

    expect(result.found).toBe(true);
    expect(result.count).toBe(1);
    expect(result.failures[0].filePath).toBe("/repo/src/foo.ts");
    expect(result.failures[0].type).toBe("type_error");
    expect(result.failures[0].confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.markdown).toContain("/repo/src/foo.ts");
  });

  it("returns found=false for an unrelated filePath", async () => {
    await seed();
    const result = await newTool().check({
      filePath: "/repo/src/unrelated.ts",
    });

    expect(result.found).toBe(false);
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  it("matches commands via the two-token prefix rule", async () => {
    await seed({
      filePath: undefined,
      command: "npm test -- --watchAll=false",
      type: "exit_error",
      signature: "npm test failed exit code 1",
      raw: "npm ERR! code ELIFECYCLE",
    });

    const result = await newTool().check({ command: "npm test" });

    expect(result.found).toBe(true);
    expect(result.failures[0].command).toContain("npm test");
  });

  it("filters resolved failures", async () => {
    await seed();
    const memoryStore = createMemoryNodeStore(db);
    await memoryStore.resolveFailureNodesByTarget({
      conversationId: 1,
      target: { filePath: "/repo/src/foo.ts" },
      resolution: "fixed via zod parse",
    });

    const result = await newTool().check({ filePath: "/repo/src/foo.ts" });

    expect(result.found).toBe(false);
  });

  it("takes the symbol-only path when no filePath/command is given", async () => {
    await seed({ symbol: "validateUser", filePath: "/repo/src/auth.ts" });

    const result = await newTool().check({ symbol: "validateUser" });

    expect(result.found).toBe(true);
    expect(result.failures[0].symbol).toBe("validateUser");
    expect(result.markdown).toContain("validateUser");
  });

  it("returns a helpful reason when no target is provided", async () => {
    const result = await newTool().check({});

    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/filePath|command|symbol/);
    expect(result.failures).toHaveLength(0);
  });

  it("caps returned failures by the `limit` param (max 5)", async () => {
    for (let i = 0; i < 6; i++) {
      await seed({
        filePath: "/repo/src/hot.ts",
        signature: `sig-${i}`,
        raw: `occurrence ${i}`,
        seq: i + 1,
      });
    }

    const result = await newTool().check({
      filePath: "/repo/src/hot.ts",
      limit: 10, // should be clamped to 5
    });

    expect(result.failures.length).toBeLessThanOrEqual(5);
  });

  it("filters symbol matches below the confidence floor", async () => {
    const node = await seed({ symbol: "staleSymbol" });
    // Ancient record: decayed well below MIN_CONFIDENCE=0.6.
    const oldMs = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year old
    await db.run(`UPDATE memory_nodes SET createdAt = ? WHERE nodeId = ?`, [
      new Date(oldMs).toISOString(),
      node.nodeId,
    ]);

    const result = await newTool().check({ symbol: "staleSymbol" });

    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/confidence|No prior failures/);
  });
});
