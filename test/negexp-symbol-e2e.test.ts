/**
 * End-to-end test for the symbol pivot.
 *
 * Covers the chain:
 *   raw error message
 *     → NegExpExtractor.extractFromErrorMessage
 *     → memoryStore.createFailureNode
 *     → memory_node row has metadata.symbol populated and a symbol tag
 *     → findFailuresByAnchors (symbols) finds it
 *     → codememory_check_prior_failures returns it via the symbol path
 *
 * If a future refactor accidentally drops the `symbol` field at any hop
 * in that chain, only this test catches it.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { NegExpExtractor } from "../src/negexp/extractor.js";
import type { JsonlMessage } from "../src/hooks/jsonl-watcher.js";
import { CodeMemoryCheckPriorFailuresTool } from "../src/tools/codememory-check-prior-failures-tool.js";

let dbDir: string;
let db: any;
let memoryStore: ReturnType<typeof createMemoryNodeStore>;
let extractor: NegExpExtractor;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-sym-e2e-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  await db.run(
    `INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')`
  );
  memoryStore = createMemoryNodeStore(db);
  extractor = new NegExpExtractor();
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function errorMsg(content: string, id = "msg-err"): JsonlMessage {
  return {
    id,
    type: "user",
    role: "user",
    content,
    timestamp: Date.now(),
    metadata: { sessionId: "sess-A", parts: [] },
  };
}

async function ingest(rawError: string, seq: number) {
  const extracted = extractor.extractFromErrorMessage(errorMsg(rawError), 1, seq);
  expect(extracted, `extractor returned null for: ${rawError.slice(0, 60)}`).not.toBeNull();
  const node = await memoryStore.createFailureNode({
    conversationId: 1,
    sessionId: "sess-A",
    seq,
    type: extracted!.type,
    signature: extracted!.signature,
    raw: extracted!.raw,
    symbol: extracted!.symbol,
    filePath: extracted!.filePath,
    command: extracted!.command,
    location: extracted!.location,
    attemptedFix: extracted!.attemptedFix,
    messageId: extracted!.messageId,
    weight: 1.0,
  });
  return { extracted, node };
}

describe("symbol pivot — end-to-end (extractor → memoryStore → tool)", () => {
  it("Python AttributeError lands as failure node with metadata.symbol=get_profile", async () => {
    const { node } = await ingest(
      "AttributeError: 'User' object has no attribute 'get_profile'",
      1
    );
    expect(node.metadata.symbol).toBe("get_profile");
  });

  it("Python NameError lands with metadata.symbol=calculate_total", async () => {
    const { node } = await ingest(
      "NameError: name 'calculate_total' is not defined",
      1
    );
    expect(node.metadata.symbol).toBe("calculate_total");
  });

  it("JS TypeError 'Cannot read properties...reading X' lands as symbol=X", async () => {
    const { node } = await ingest(
      "TypeError: Cannot read properties of undefined (reading 'getFullName')",
      1
    );
    expect(node.metadata.symbol).toBe("getFullName");
  });

  it("TS 'Property X does not exist' lands as symbol=X", async () => {
    const { node } = await ingest(
      "src/auth/login.ts:45:3 - error TS2339: Property 'handleLogin' does not exist on type 'AuthService'.",
      1
    );
    expect(node.metadata.symbol).toBe("handleLogin");
  });

  it("symbol is findable via findFailuresByAnchors", async () => {
    await ingest(
      "AttributeError: 'User' object has no attribute 'get_profile'",
      1
    );
    const candidates = await memoryStore.findFailuresByAnchors({
      symbols: ["get_profile"],
      statuses: ["active"],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].node.metadata.symbol).toBe("get_profile");
  });

  it("symbol is findable via codememory_check_prior_failures (symbol path)", async () => {
    extractor.observeMessage(
      {
        id: "msg-edit",
        type: "assistant",
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        metadata: {
          sessionId: "sess-A",
          parts: [
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: "/repo/src/utils/validation.ts",
                old_string: "x",
                new_string: "y",
              },
            },
          ],
        },
      } as any,
      1
    );
    await ingest(
      "TypeError: Cannot read properties of undefined (reading 'validateUserInput')",
      2
    );
    const tool = new CodeMemoryCheckPriorFailuresTool(memoryStore);
    const result = await tool.check({ symbol: "validateUserInput" });
    expect(result.found).toBe(true);
    expect(result.failures[0].symbol).toBe("validateUserInput");
    expect(result.failures[0].filePath).toBe("/repo/src/utils/validation.ts");
  });

  it("errors with no extractable symbol leave the field undefined (not crash)", async () => {
    const { node } = await ingest(
      "Error: ENOENT: no such file or directory, open '/x/y'",
      1
    );
    expect(node.metadata.symbol ?? null).toBeNull();
    expect(node.metadata.signature).toBeTruthy();
  });
});
