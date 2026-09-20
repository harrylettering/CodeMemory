/**
 * Which agent produced this.
 *
 * A subagent's work is ingested into the parent conversation -- correctly, it
 * is the parent's work -- but nothing recorded which agent did it. The message
 * layer carried a `sidechain` tag, a boolean that cannot tell two concurrent
 * subagents apart and never reached the memory nodes at all.
 *
 * That matters most on the write side. A subagent can call
 * codememory_mark_decision, and what it writes is indistinguishable from a
 * decision the main agent deliberated over. Failing to read something costs
 * information; failing to tell writes apart corrupts the basis for judgement.
 *
 * Identity comes from the transcript entry itself, verified against real
 * files: subagent entries carry `agentId` and `promptId`, main-agent entries
 * carry neither. Absence is the main agent's marker, so the column is
 * nullable and NULL means "not a subagent" -- the same convention sourceUuid
 * already uses.
 *
 * `promptId` is not redundant. Two subagents dispatched in one turn share a
 * promptId and differ by agentId; the pair is the identity, and the promptId
 * half is what makes concurrent dispatches separable.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeMemoryDatabaseConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { createMemoryNodeStore } from "../src/store/memory-store.js";
import { ProjectWatcher } from "../src/hooks/project-watcher-manager.js";

let dbDir: string;
let db: any;
let store: ConversationStore;

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-agent-"));
  db = await createCodeMemoryDatabaseConnection(join(dbDir, "codememory.db"));
  store = new ConversationStore(db);
  await db.run(
    "INSERT INTO conversations (conversationId, sessionId) VALUES (1, 'sess-A')"
  );
});

afterEach(async () => {
  if (db) await db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const insert = (
  sourceUuid: string,
  extra: { producerAgentId?: string; producerPromptId?: string } = {}
) =>
  store.insertMessage({
    conversationId: 1,
    role: "user",
    content: sourceUuid,
    tokenCount: 5,
    tier: "S",
    sourceUuid,
    parts: [{ partType: "text", textContent: sourceUuid }],
    ...extra,
  } as any);

const rowFor = async (sourceUuid: string) =>
  db.get(
    "SELECT producerAgentId, producerPromptId FROM conversation_messages WHERE sourceUuid = ?",
    sourceUuid
  );

describe("conversation_messages records the producing agent", () => {
  it("stores a subagent's id and prompt", async () => {
    await insert("u-sub", {
      producerAgentId: "a46733a66c860abb9",
      producerPromptId: "83be3dd3-391f-4018-81d0-9d8daa4e46a8",
    });

    const row = await rowFor("u-sub");
    expect(row.producerAgentId).toBe("a46733a66c860abb9");
    expect(row.producerPromptId).toBe("83be3dd3-391f-4018-81d0-9d8daa4e46a8");
  });

  it("stores NULL for the main agent, not a string", async () => {
    // `"undefined"` and `""` both read as truthy identities later. The column
    // has to be genuinely empty for "was this a subagent" to stay answerable.
    await insert("u-main");

    const row = await rowFor("u-main");
    expect(row.producerAgentId).toBeNull();
    expect(row.producerPromptId).toBeNull();
  });

  it("keeps two concurrent subagents apart", async () => {
    const sharedPrompt = "prompt-same-turn";
    await insert("u-a", { producerAgentId: "agent-a", producerPromptId: sharedPrompt });
    await insert("u-b", { producerAgentId: "agent-b", producerPromptId: sharedPrompt });

    expect((await rowFor("u-a")).producerAgentId).toBe("agent-a");
    expect((await rowFor("u-b")).producerAgentId).toBe("agent-b");
    // Same turn: the promptId alone cannot separate them, which is why both
    // fields are stored rather than just one.
    expect((await rowFor("u-a")).producerPromptId).toBe(sharedPrompt);
    expect((await rowFor("u-b")).producerPromptId).toBe(sharedPrompt);
  });
});

describe("the watcher reads the identity off the transcript", () => {
  let root: string;
  let projectDir: string;
  let savedHome: string | undefined;

  const SILENT = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  const SESSION = "sess-watch";

  const entry = (over: Record<string, unknown>) =>
    JSON.stringify({
      uuid: "u-1",
      type: "user",
      message: { role: "user", content: "hello" },
      sessionId: SESSION,
      timestamp: new Date().toISOString(),
      ...over,
    }) + "\n";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codememory-agent-w-"));
    savedHome = process.env.HOME;
    process.env.HOME = root;
    projectDir = join(root, ".claude", "projects", "-tmp-proj");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  async function collect(): Promise<any[]> {
    const seen: any[] = [];
    const w = new ProjectWatcher(SILENT, {
      projectPath: "/tmp/proj",
      sessionId: SESSION,
      pollInterval: 50,
      onMessage: (m) => seen.push(m),
    });
    await w.start();
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    return seen;
  }

  it("parses agentId and promptId off a subagent entry", async () => {
    const subagents = join(projectDir, SESSION, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-a46733a66c860abb9.jsonl"),
      entry({
        uuid: "u-sub",
        agentId: "a46733a66c860abb9",
        promptId: "83be3dd3-391f-4018-81d0-9d8daa4e46a8",
        isSidechain: true,
      })
    );

    const [msg] = await collect();
    expect(msg.agentId).toBe("a46733a66c860abb9");
    expect(msg.promptId).toBe("83be3dd3-391f-4018-81d0-9d8daa4e46a8");
  });

  it("leaves both undefined for a main-agent entry", async () => {
    // Real main-agent entries carry neither field. Asserting the parsed value
    // rather than "the write succeeded" is deliberate: this codebase has
    // produced three separate fields that were declared, passed, typechecked
    // and never arrived.
    writeFileSync(join(projectDir, `${SESSION}.jsonl`), entry({ uuid: "u-main" }));

    const [msg] = await collect();
    expect(msg.agentId).toBeUndefined();
    expect(msg.promptId).toBeUndefined();
  });
});

describe("memory_nodes records the producing agent", () => {
  const SUB = "a46733a66c860abb9";
  const PROMPT = "83be3dd3-391f-4018-81d0-9d8daa4e46a8";

  const producedBy = async (nodeId: string) =>
    db.get(
      "SELECT producerAgentId, producerPromptId FROM memory_nodes WHERE nodeId = ?",
      nodeId
    );

  // Enumerated by kind rather than by call site. The write points are spread
  // across five create* functions and it is the kinds, not the functions, that
  // have to come out distinguishable.
  const kinds = [
    "decision",
    "failure",
    "fix_attempt",
    "task",
    "constraint",
    "summary",
  ] as const;

  it.each(kinds)("carries the subagent identity on a %s node", async (kind) => {
    const store = createMemoryNodeStore(db);
    await store.upsertNode({
      nodeId: `${kind}-sub`,
      kind: kind as any,
      conversationId: 1,
      source: "test",
      sourceId: `${kind}-sub`,
      summaryId: kind === "summary" ? `leaf-${kind}` : undefined,
      content: `[${kind.toUpperCase()}] produced by a subagent`,
      producerAgentId: SUB,
      producerPromptId: PROMPT,
    } as any);

    const row = await producedBy(`${kind}-sub`);
    expect(row.producerAgentId).toBe(SUB);
    expect(row.producerPromptId).toBe(PROMPT);
  });

  it("leaves a main-agent node NULL so the two stay distinguishable", async () => {
    // This is the whole point. A subagent can call codememory_mark_decision,
    // and without this the result is indistinguishable from a decision the
    // main agent deliberated over.
    const store = createMemoryNodeStore(db);
    await store.upsertNode({
      nodeId: "decision-main",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-main",
      content: "[DECISION] deliberated by the main agent",
    } as any);
    await store.upsertNode({
      nodeId: "decision-sub",
      kind: "decision",
      conversationId: 1,
      source: "test",
      sourceId: "decision-sub",
      content: "[DECISION] marked in passing by a subagent",
      producerAgentId: SUB,
      producerPromptId: PROMPT,
    } as any);

    expect((await producedBy("decision-main")).producerAgentId).toBeNull();
    expect((await producedBy("decision-sub")).producerAgentId).toBe(SUB);

    const subagentDecisions = await db.all(
      "SELECT nodeId FROM memory_nodes WHERE kind = 'decision' AND producerAgentId IS NOT NULL"
    );
    expect(subagentDecisions.map((r: any) => r.nodeId)).toEqual(["decision-sub"]);
  });

  it("keeps two concurrent subagents' nodes apart", async () => {
    const store = createMemoryNodeStore(db);
    for (const agent of ["agent-a", "agent-b"]) {
      await store.upsertNode({
        nodeId: `failure-${agent}`,
        kind: "failure",
        conversationId: 1,
        source: "test",
        sourceId: `failure-${agent}`,
        content: "[FAILURE] boom",
        producerAgentId: agent,
        producerPromptId: "same-turn",
      } as any);
    }

    expect((await producedBy("failure-agent-a")).producerAgentId).toBe("agent-a");
    expect((await producedBy("failure-agent-b")).producerAgentId).toBe("agent-b");
  });
});

describe("the identity is inherited, not looked up", () => {
  it("a failure node carries the identity of the message it came from", async () => {
    // The chain that matters end to end: transcript entry -> message ->
    // failure node. Asserting it at the store boundary rather than mocking a
    // "current agent" is the point -- a global current-agent would be wrong by
    // construction the moment two subagents run at once.
    const store = createMemoryNodeStore(db);
    await store.createFailureNode({
      conversationId: 1,
      sessionId: "sess-A",
      seq: 1,
      type: "exit_error",
      signature: "boom",
      raw: "boom",
      filePath: "a.ts",
      weight: 1,
      producerAgentId: "a46733a66c860abb9",
      producerPromptId: "83be3dd3",
    } as any);

    const row = await db.get(
      "SELECT producerAgentId, producerPromptId FROM memory_nodes WHERE kind = 'failure'"
    );
    expect(row.producerAgentId).toBe("a46733a66c860abb9");
    expect(row.producerPromptId).toBe("83be3dd3");
  });

  it("a failure the main agent hit stays NULL", async () => {
    const store = createMemoryNodeStore(db);
    await store.createFailureNode({
      conversationId: 1,
      sessionId: "sess-A",
      seq: 2,
      type: "exit_error",
      signature: "main-boom",
      raw: "main-boom",
      filePath: "b.ts",
      weight: 1,
    } as any);

    const row = await db.get(
      "SELECT producerAgentId FROM memory_nodes WHERE kind = 'failure'"
    );
    expect(row.producerAgentId).toBeNull();
  });
});

describe("the mark path carries attribution all the way down", () => {
  const SUB = "a46733a66c860abb9";

  // These are the writes a subagent can make on its own initiative, so they
  // are the ones that most need to be distinguishable afterwards. The types
  // compiling is not evidence the value arrives -- this codebase has produced
  // several fields that were declared, passed, typechecked and dropped.
  it.each([
    ["decision", "createDecisionNode", { decision: "use A", rationale: "smaller", content: "[DECISION] use A" }],
    ["task", "createTaskNode", { task: "ship it", content: "[TASK] ship it" }],
    ["constraint", "createConstraintNode", { constraint: "never block tools", content: "[CONSTRAINT] never block tools" }],
  ])("a %s marked by a subagent is attributable", async (kind, fn, extra) => {
    const store: any = createMemoryNodeStore(db);
    await store[fn]({
      conversationId: 1,
      sessionId: "sess-A",
      sourceToolUseId: `toolu_${kind}`,
      producerAgentId: SUB,
      producerPromptId: "83be3dd3",
      ...extra,
    });

    const row = await db.get(
      "SELECT producerAgentId, producerPromptId FROM memory_nodes WHERE kind = ?",
      kind
    );
    expect(row.producerAgentId).toBe(SUB);
    expect(row.producerPromptId).toBe("83be3dd3");
  });

  it("a mark by the main agent stays NULL", async () => {
    const store: any = createMemoryNodeStore(db);
    await store.createDecisionNode({
      conversationId: 1,
      sessionId: "sess-A",
      sourceToolUseId: "toolu_main",
      decision: "use B",
      rationale: "deliberated",
      content: "[DECISION] use B",
    });

    const row = await db.get(
      "SELECT producerAgentId FROM memory_nodes WHERE kind = 'decision'"
    );
    expect(row.producerAgentId).toBeNull();
  });
});
