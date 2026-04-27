/**
 * Unified compaction pipeline test.
 *
 * Topology after the daemon-socket refactor:
 *   - PreCompact hook    → curl socket /compact → daemon.compactor.forceCompact
 *   - SessionEnd hook    → curl socket /compact → daemon.compactor.forceCompact
 *   - codememory_compact tool   → engine.compact       → AsyncCompactor.forceCompact
 *   - Threshold ingest   → compactor.maybeCompact (auto)
 *
 * All four converge on `AsyncCompactor.forceCompact` (or the threshold
 * variant). This test exercises the tool path — `engine.compact` — which
 * is the only force path still invoked in-process. Invariants covered
 * here apply to all four because they share the same compactor.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CodeMemoryContextEngine } from "../src/engine.js";
import { resolveCodeMemoryConfig } from "../src/db/config.js";
import { TRUNCATION_FALLBACK_MARKER } from "../src/compaction/compactor.js";

let dbDir: string;
let originalDbEnv: string | undefined;
let originalDisableLlm: string | undefined;
let originalLeafTargetTokens: string | undefined;
let originalSummaryOverageFactor: string | undefined;
let originalPath: string | undefined;

const SILENT_DEPS = {
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  complete: async () => ({ content: [] }),
} as any;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-compact-"));
  originalDbEnv = process.env.CODEMEMORY_DATABASE_PATH;
  originalDisableLlm = process.env.CODEMEMORY_COMPACTION_DISABLE_LLM;
  originalLeafTargetTokens = process.env.CODEMEMORY_LEAF_TARGET_TOKENS;
  originalSummaryOverageFactor = process.env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR;
  originalPath = process.env.PATH;
  process.env.CODEMEMORY_DATABASE_PATH = join(dbDir, "codememory.db");
  // Force the truncation fallback so tests never spawn `claude --print`.
  process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "true";
});

afterEach(() => {
  if (originalDbEnv === undefined) delete process.env.CODEMEMORY_DATABASE_PATH;
  else process.env.CODEMEMORY_DATABASE_PATH = originalDbEnv;
  if (originalDisableLlm === undefined) delete process.env.CODEMEMORY_COMPACTION_DISABLE_LLM;
  else process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = originalDisableLlm;
  if (originalLeafTargetTokens === undefined) delete process.env.CODEMEMORY_LEAF_TARGET_TOKENS;
  else process.env.CODEMEMORY_LEAF_TARGET_TOKENS = originalLeafTargetTokens;
  if (originalSummaryOverageFactor === undefined) delete process.env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR;
  else process.env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR = originalSummaryOverageFactor;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(dbDir, { recursive: true, force: true });
});

async function buildEngine() {
  const db = await createCodeMemoryDatabaseConnection(process.env.CODEMEMORY_DATABASE_PATH!);
  const config = resolveCodeMemoryConfig();
  const engine = new CodeMemoryContextEngine({ db, config, deps: SILENT_DEPS });
  return { db, engine };
}

async function seedConversation(
  sessionId: string,
  messageCount: number,
  tier: "S" | "M" | "L" = "L",
  contentForIndex: (index: number) => string = (i) =>
    `message body ${i} with enough content to cost a few tokens each`
) {
  const db = await createCodeMemoryDatabaseConnection(process.env.CODEMEMORY_DATABASE_PATH!);
  const store = new ConversationStore(db);
  const conv = await store.getOrCreateConversation({ sessionId });
  for (let i = 0; i < messageCount; i++) {
    await store.insertMessage({
      conversationId: conv.conversationId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: contentForIndex(i),
      tokenCount: 50,
      tier,
      parts: [{ partType: "text", textContent: contentForIndex(i) }],
    });
  }
  await db.close();
  return conv.conversationId;
}

describe("engine.compact (shared by tool + daemon force-compact)", () => {
  it("returns a no-op when the session has no conversation", async () => {
    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "ghost-session" });
      expect(result.actionTaken).toBe(false);
      expect(result.tokensBefore).toBe(0);
      expect(result.tokensAfter).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("compacts M/L messages past the fresh-tail window into a summary", async () => {
    // 25 L-tier messages, fresh-tail default is 20 → ~5 compactable.
    const convId = await seedConversation("sess-real", 25, "L");

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-real" });
      expect(result.actionTaken).toBe(true);
      expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);

      // Result must carry the created summaryId + level so the tool
      // response has something real to hand back to the user (the old
      // contract advertised these fields but they were always undefined).
      expect(result.createdSummaryId).toMatch(/^leaf-/);
      expect(result.level).toBe("leaf");

      const summary = await db.get(
        "SELECT summaryId, kind FROM summaries WHERE conversationId = ?",
        convId
      );
      expect(summary).toBeTruthy();
      expect(summary.kind).toBe("leaf");
      expect(summary.summaryId).toBe(result.createdSummaryId);

      const linkedCount = await db.get(
        "SELECT COUNT(*) as n FROM summary_messages WHERE summaryId = ?",
        summary.summaryId
      );
      expect(linkedCount.n).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it("is a no-op when everything is inside the fresh-tail window", async () => {
    // 10 messages, all inside the freshTail=20 window → nothing compactable.
    await seedConversation("sess-small", 10, "L");

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-small" });
      expect(result.actionTaken).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("skips S-tier messages (only M/L are compactable)", async () => {
    // 30 S-tier messages — S-tier is the skeleton and must never be compacted.
    await seedConversation("sess-s-only", 30, "S");

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-s-only" });
      expect(result.actionTaken).toBe(false);
      expect(result.tokensBefore).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("retries an overlong LLM summary and stores only the validated rewrite", async () => {
    process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "false";
    process.env.CODEMEMORY_LEAF_TARGET_TOKENS = "20";
    process.env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR = "1";

    const fakeBin = join(dbDir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = join(fakeBin, "claude");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (input.includes('Previous summary failed validation')) {",
        "    process.stdout.write('Short validated summary: keep the auth change and rerun tests.');",
        "  } else {",
        "    process.stdout.write('x'.repeat(2000));",
        "  }",
        "});",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    const convId = await seedConversation("sess-quality-retry", 25, "L");

    const { db, engine } = await buildEngine();
    try {
      const result = await engine.compact({ sessionId: "sess-quality-retry" });
      expect(result.actionTaken).toBe(true);

      const summary = await db.get(
        "SELECT content, tokenCount FROM summaries WHERE conversationId = ? AND kind = 'leaf'",
        convId
      );
      expect(summary.content).toBe(
        "Short validated summary: keep the auth change and rerun tests."
      );
      expect(summary.content.startsWith(TRUNCATION_FALLBACK_MARKER)).toBe(false);
      expect(summary.tokenCount).toBeLessThanOrEqual(20);
    } finally {
      await db.close();
    }
  });

  it("bounds truncation fallback content by target tokens and overage factor", async () => {
    process.env.CODEMEMORY_LEAF_TARGET_TOKENS = "20";
    process.env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR = "1";

    const convId = await seedConversation("sess-quality-fallback", 25, "L");

    const { db, engine } = await buildEngine();
    try {
      await engine.compact({ sessionId: "sess-quality-fallback" });

      const summary = await db.get(
        "SELECT content, tokenCount FROM summaries WHERE conversationId = ? AND kind = 'leaf'",
        convId
      );
      expect(summary.content.startsWith(TRUNCATION_FALLBACK_MARKER)).toBe(true);
      expect(summary.tokenCount).toBeLessThanOrEqual(20);
    } finally {
      await db.close();
    }
  });

  it("only creates summary anchor memory for high-value compaction summaries", async () => {
    const lowConvId = await seedConversation("sess-low-anchor", 25, "L");
    const highConvId = await seedConversation(
      "sess-high-anchor",
      25,
      "L",
      (i) =>
        `message ${i}: root cause failed in src/auth/login.ts and the fix was to refresh auth token`
    );

    const { db, engine } = await buildEngine();
    try {
      await engine.compact({ sessionId: "sess-low-anchor" });
      await engine.compact({ sessionId: "sess-high-anchor" });

      const lowAnchorCount = await db.get(
        "SELECT COUNT(*) as n FROM memory_nodes WHERE conversationId = ? AND source = 'summary_dag'",
        lowConvId
      );
      expect(lowAnchorCount.n).toBe(0);

      const highAnchor = await db.get(
        "SELECT nodeId, kind, summaryId, metadata FROM memory_nodes WHERE conversationId = ? AND source = 'summary_dag'",
        highConvId
      );
      expect(highAnchor).toBeTruthy();
      expect(highAnchor.kind).toBe("summary");
      expect(highAnchor.summaryId).toMatch(/^leaf-/);
      expect(JSON.parse(highAnchor.metadata).anchorType).toBe("summary_anchor");

      const tags = await db.all(
        "SELECT tagType, tagValue FROM memory_tags WHERE nodeId = ?",
        highAnchor.nodeId
      );
      expect(tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tagType: "kind", tagValue: "summary_anchor" }),
          expect.objectContaining({
            tagType: "file",
            tagValue: expect.stringMatching(/^[0-9a-f]{8}:src\/auth\/login\.ts$/),
          }),
        ])
      );
    } finally {
      await db.close();
    }
  });

  it("respects LLM-emitted anchor=false metadata even when content matches the legacy regex", async () => {
    process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "false";

    const fakeBin = join(dbDir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = join(fakeBin, "claude");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        // Body contains "root cause failed" keywords that the legacy regex would
        // anchor on. The structured metadata says otherwise and must win.
        "  process.stdout.write('{\"anchor\":false,\"kinds\":[],\"reason\":\"routine logs\"}\\n\\nThe root cause failed surface area is just routine logging churn; nothing durable.');",
        "});",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    const convId = await seedConversation(
      "sess-meta-deny",
      25,
      "L",
      (i) => `message ${i}: root cause failed in src/auth/login.ts`
    );

    const { db, engine } = await buildEngine();
    try {
      await engine.compact({ sessionId: "sess-meta-deny" });
      const anchorCount = await db.get(
        "SELECT COUNT(*) as n FROM memory_nodes WHERE conversationId = ? AND source = 'summary_dag'",
        convId
      );
      expect(anchorCount.n).toBe(0);

      const summary = await db.get(
        "SELECT content FROM summaries WHERE conversationId = ? AND kind = 'leaf'",
        convId
      );
      // The JSON header must be stripped from the persisted summary body.
      expect(summary.content.startsWith("{")).toBe(false);
      expect(summary.content).toContain("routine logging churn");
    } finally {
      await db.close();
    }
  });

  it("creates a summary anchor when LLM emits anchor=true even on bland-looking content", async () => {
    process.env.CODEMEMORY_COMPACTION_DISABLE_LLM = "false";

    const fakeBin = join(dbDir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = join(fakeBin, "claude");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        // No regex keyword in the body; only the JSON metadata flag carries the
        // signal. Used to verify the metadata path can ELEVATE bland summaries.
        "  process.stdout.write('{\"anchor\":true,\"kinds\":[\"decision\"],\"reason\":\"chose pnpm over npm\"}\\n\\nTeam settled on pnpm for the workspace; lockfile migrated; CI updated accordingly.');",
        "});",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    const convId = await seedConversation(
      "sess-meta-allow",
      25,
      "L",
      (i) => `message ${i}: bumped pnpm version and migrated lockfile`
    );

    const { db, engine } = await buildEngine();
    try {
      await engine.compact({ sessionId: "sess-meta-allow" });
      const anchor = await db.get(
        "SELECT nodeId, summaryId FROM memory_nodes WHERE conversationId = ? AND source = 'summary_dag'",
        convId
      );
      expect(anchor).toBeTruthy();
      expect(anchor.summaryId).toMatch(/^leaf-/);

      const summary = await db.get(
        "SELECT content FROM summaries WHERE summaryId = ?",
        anchor.summaryId
      );
      expect(summary.content.startsWith("{")).toBe(false);
      expect(summary.content).toContain("pnpm");
    } finally {
      await db.close();
    }
  });
});
