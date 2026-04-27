import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { lookupForPreToolUse, scoreMatch } from "../src/failure-lookup.js";
import { extractSymbol } from "../src/negexp/signature.js";
import { CodeMemoryCheckPriorFailuresTool } from "../src/tools/codememory-check-prior-failures-tool.js";

describe("Failure-node Symbol-Level Retrieval", () => {
  let tempDir: string;
  let db: Awaited<ReturnType<typeof createCodeMemoryDatabaseConnection>>;
  let memoryStore: ReturnType<typeof createMemoryNodeStore>;
  let checkTool: CodeMemoryCheckPriorFailuresTool;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codememory-test-"));
    const dbPath = join(tempDir, "test.db");
    db = await createCodeMemoryDatabaseConnection(dbPath);
    memoryStore = createMemoryNodeStore(db);
    checkTool = new CodeMemoryCheckPriorFailuresTool(memoryStore);
    await db.run(
      `INSERT INTO conversations (sessionId, createdAt, updatedAt)
       VALUES (?, ?, ?)`,
      ["test-session", new Date().toISOString(), new Date().toISOString()]
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Symbol extraction from errors", () => {
    const testCases = [
      {
        name: "TypeScript property does not exist error",
        error:
          "src/auth/login.ts:45:3 - error TS2339: Property 'handleLogin' does not exist on type 'AuthService'.",
        expectedSymbol: "handleLogin",
      },
      {
        name: "JavaScript TypeError - cannot read property",
        error: "TypeError: Cannot read property 'getFullName' of undefined",
        expectedSymbol: "getFullName",
      },
      {
        name: "JavaScript ReferenceError - function not defined",
        error: "ReferenceError: processPayment is not defined",
        expectedSymbol: "processPayment",
      },
      {
        name: "Python AttributeError",
        error: "AttributeError: 'User' object has no attribute 'get_profile'",
        expectedSymbol: "get_profile",
      },
      {
        name: "Python NameError",
        error: "NameError: name 'calculate_total' is not defined",
        expectedSymbol: "calculate_total",
      },
    ];
    it.each(testCases)("extracts symbol from $name", ({ error, expectedSymbol }) => {
      expect(extractSymbol(error)).toBe(expectedSymbol);
    });
  });

  describe("Symbol-based retrieval", () => {
    beforeEach(async () => {
      const records = [
        {
          seq: 1,
          type: "type_error",
          signature: "test-sig-1",
          raw: "TypeError: Cannot read property 'handleLogin' of undefined",
          filePath: "/repo/src/auth/login.ts",
          symbol: "handleLogin",
          attemptedFix: "Tried to call handleLogin with missing user context",
        },
        {
          seq: 2,
          type: "runtime_error",
          signature: "test-sig-2",
          raw: "AttributeError: 'User' object has no attribute 'get_profile'",
          filePath: "/repo/src/user/profile.ts",
          symbol: "get_profile",
          attemptedFix: "Tried to access get_profile on User object",
        },
        {
          seq: 3,
          type: "test_fail",
          signature: "test-sig-3",
          raw: "Error: Test failed in processPayment",
          command: "npm test",
          symbol: "processPayment",
          attemptedFix: "Tried to run payment processing test",
        },
        {
          seq: 4,
          type: "bash_nonzero",
          signature: "test-sig-4",
          raw: "error: cannot find function `get_user` in this scope",
          command: "cargo build",
          symbol: "get_user",
          attemptedFix: "Tried to build Rust project",
        },
      ];
      for (const r of records) {
        await memoryStore.createFailureNode({
          conversationId: 1,
          sessionId: "test-session",
          weight: 1.0,
          ...r,
        });
      }
    });

    it("retrieves failures by exact symbol match", async () => {
      const candidates = await memoryStore.findFailuresByAnchors({
        symbols: ["handleLogin"],
        statuses: ["active"],
      });
      expect(candidates.length).toBe(1);
      expect(candidates[0].node.metadata.symbol).toBe("handleLogin");
      expect(candidates[0].node.metadata.filePath).toBe(
        "/repo/src/auth/login.ts"
      );
    });

    it("returns empty array for non-existent symbols", async () => {
      const candidates = await memoryStore.findFailuresByAnchors({
        symbols: ["nonExistentFunction"],
        statuses: ["active"],
      });
      expect(candidates.length).toBe(0);
    });

    it("scores symbol matches above the confidence floor", async () => {
      const candidates = await memoryStore.findFailuresByAnchors({
        symbols: ["handleLogin"],
        statuses: ["active"],
      });
      expect(candidates.length).toBe(1);
      const node = candidates[0].node;
      const score = scoreMatch(node, {
        filePath: node.metadata.filePath as string,
      });
      expect(score).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("Symbol retrieval via codememory_check_prior_failures tool", () => {
    beforeEach(async () => {
      await memoryStore.createFailureNode({
        conversationId: 1,
        sessionId: "test-session",
        seq: 1,
        type: "type_error",
        signature: "test-sig-1",
        raw: "TypeError: Cannot read property 'validateUserInput' of undefined",
        filePath: "/repo/src/utils/validation.ts",
        symbol: "validateUserInput",
        attemptedFix: "Tried to validate user input without proper context",
        weight: 1.0,
      });
    });

    it("returns symbol matches when querying by symbol", async () => {
      const result = await checkTool.check({ symbol: "validateUserInput" });
      expect(result.found).toBe(true);
      expect(result.count).toBe(1);
      expect(result.failures[0].symbol).toBe("validateUserInput");
      expect(result.markdown).toContain("validateUserInput");
    });

    it("filters low-confidence symbol matches via age decay", async () => {
      const oldNode = await memoryStore.createFailureNode({
        conversationId: 1,
        sessionId: "test-session",
        seq: 2,
        type: "type_error",
        signature: "test-sig-2",
        raw: "TypeError: Cannot read property 'oldFunction' of undefined",
        filePath: "/repo/src/legacy/old.ts",
        symbol: "oldFunction",
        attemptedFix: "Old deprecated function call",
        weight: 0.5,
      });
      // Age the node well past the half-life so weight*decay drops below 0.6.
      const oldDate = new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000
      ).toISOString();
      await db.run(`UPDATE memory_nodes SET createdAt = ? WHERE nodeId = ?`, [
        oldDate,
        oldNode.nodeId,
      ]);

      const result = await checkTool.check({ symbol: "oldFunction" });
      expect(result.found).toBe(false);
      expect(result.reason).toContain("below confidence threshold");
    });
  });

  describe("Symbol integration in lookupForPreToolUse", () => {
    beforeEach(async () => {
      await memoryStore.createFailureNode({
        conversationId: 1,
        sessionId: "test-session",
        seq: 1,
        type: "type_error",
        signature: "test-sig-1",
        raw: "TypeError: Cannot read property 'formatResponse' of undefined",
        filePath: "/repo/src/utils/format.ts",
        symbol: "formatResponse",
        attemptedFix: "Tried to format API response with invalid data",
        weight: 1.0,
      });
    });

    it("includes symbol matches when looking up by file path", async () => {
      const result = await lookupForPreToolUse(memoryStore, "Edit", {
        file_path: "/repo/src/utils/format.ts",
      });
      expect(result.shouldInject).toBe(true);
      expect(result.markdown).toContain("formatResponse");
      expect(result.reason).toBe("Found relevant prior failures");
    });

    it("includes symbol matches when looking up by command", async () => {
      await memoryStore.createFailureNode({
        conversationId: 1,
        sessionId: "test-session",
        seq: 2,
        type: "test_fail",
        signature: "test-sig-2",
        raw: "Error: Test failed for processPayment function",
        command: "npm run test:payment",
        symbol: "processPayment",
        attemptedFix: "Tried to run payment tests",
        weight: 1.0,
      });
      const result = await lookupForPreToolUse(memoryStore, "Bash", {
        command: "npm run test:payment",
      });
      expect(result.shouldInject).toBe(true);
      expect(result.markdown).toContain("processPayment");
    });
  });

  describe("Cross-language symbol support", () => {
    const testRecords = [
      {
        symbol: "getUser",
        lang: "TypeScript",
        error: "TypeError: getUser is not a function",
        filePath: "/repo/src/user.ts",
      },
      {
        symbol: "get_user",
        lang: "Python",
        error: "AttributeError: 'User' object has no attribute 'get_user'",
        filePath: "/repo/src/user.py",
      },
    ];
    beforeEach(async () => {
      for (const [idx, record] of testRecords.entries()) {
        await memoryStore.createFailureNode({
          conversationId: 1,
          sessionId: "test-session",
          seq: idx + 1,
          type: "type_error",
          signature: `test-sig-${idx}`,
          raw: record.error,
          filePath: record.filePath,
          symbol: record.symbol,
          attemptedFix: `Test ${record.lang} function`,
          weight: 1.0,
        });
      }
    });

    it("retrieves snake_case symbols for Python", async () => {
      const candidates = await memoryStore.findFailuresByAnchors({
        symbols: ["get_user"],
        statuses: ["active"],
      });
      expect(candidates.length).toBe(1);
      expect(candidates[0].node.metadata.symbol).toBe("get_user");
      expect(candidates[0].node.metadata.filePath).toBe("/repo/src/user.py");
    });

    it("retrieves camelCase symbols for TypeScript", async () => {
      const candidates = await memoryStore.findFailuresByAnchors({
        symbols: ["getUser"],
        statuses: ["active"],
      });
      expect(candidates.length).toBe(1);
      expect(candidates[0].node.metadata.symbol).toBe("getUser");
      expect(candidates[0].node.metadata.filePath).toBe("/repo/src/user.ts");
    });
  });
});
