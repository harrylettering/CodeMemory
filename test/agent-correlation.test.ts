/**
 * Attributing a mark to the agent that made it.
 *
 * A subagent can call codememory_mark_decision. Nothing about the call says
 * who made it, and two facts close off the obvious routes:
 *
 *   - A subagent's CLAUDE_* environment is byte-identical to the main agent's.
 *     Verified by running `env` in both. So the skill path -- a shell script
 *     curling the daemon -- cannot learn its own identity from the environment.
 *
 *   - A daemon-side "current agent" variable is wrong by construction: two
 *     subagents dispatched in one turn run at once, and whichever wrote last
 *     would claim both their marks.
 *
 * What does work is correlation on a key both sides already carry. PreToolUse
 * receives `tool_use_id` alongside `agent_id`; the mark payload already carries
 * `sourceToolUseId` as an idempotency key. Recording the pair when the tool
 * call is announced and looking it up when the mark arrives attributes each
 * mark to its own caller, concurrently, with no shared mutable state.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentCorrelationTable } from "../src/hooks/agent-correlation.js";

let table: AgentCorrelationTable;

beforeEach(() => {
  table = new AgentCorrelationTable();
});

describe("correlating a mark with the agent that triggered it", () => {
  it("returns the agent recorded for that tool call", () => {
    table.record("toolu_abc", { agentId: "a46733a6", promptId: "83be3dd3" });

    expect(table.lookup("toolu_abc")).toEqual({
      agentId: "a46733a6",
      promptId: "83be3dd3",
    });
  });

  it("reports nothing for a tool call it never saw", () => {
    // The main agent's PreToolUse carries no agent_id, so nothing is recorded
    // and the absence is what identifies it. A sentinel here would make a main
    // agent look like a subagent named "unknown".
    expect(table.lookup("toolu_never")).toBeUndefined();
  });

  it("keeps two concurrent subagents apart", () => {
    // The case a "current agent" variable gets wrong. Both are in flight; each
    // mark has to find its own caller.
    table.record("toolu_a", { agentId: "agent-a", promptId: "same-turn" });
    table.record("toolu_b", { agentId: "agent-b", promptId: "same-turn" });

    expect(table.lookup("toolu_a")?.agentId).toBe("agent-a");
    expect(table.lookup("toolu_b")?.agentId).toBe("agent-b");
  });

  it("forgets entries once they age out", () => {
    // Every tool call would otherwise accumulate for the life of the daemon,
    // and a daemon now lives across many turns.
    const clock = { now: 1_000 };
    const aged = new AgentCorrelationTable({
      ttlMs: 60_000,
      now: () => clock.now,
    });
    aged.record("toolu_old", { agentId: "agent-a" });

    clock.now += 59_000;
    expect(aged.lookup("toolu_old")?.agentId).toBe("agent-a");

    clock.now += 2_000;
    expect(aged.lookup("toolu_old")).toBeUndefined();
  });

  it("does not grow without bound under a flood of tool calls", () => {
    const aged = new AgentCorrelationTable({ maxEntries: 3 });
    for (const id of ["t1", "t2", "t3", "t4"]) {
      aged.record(id, { agentId: "agent-a" });
    }

    expect(aged.size).toBeLessThanOrEqual(3);
    // The newest survives; the oldest is the one worth losing.
    expect(aged.lookup("t4")?.agentId).toBe("agent-a");
  });
});

describe("the hook forwards what only it can see", () => {
  const read = (name: string) =>
    readFileSync(join(__dirname, "..", "hooks", "scripts", name), "utf-8");

  it("pre-tool-use.sh sends the agent identity to the daemon", () => {
    // This hook payload is the only place a subagent's identity exists on the
    // write path: its CLAUDE_* environment is identical to the main agent's,
    // so nothing downstream can recover it if this drops it.
    const script = read("pre-tool-use.sh");
    expect(script).toContain(".agent_id");
    expect(script).toContain(".tool_use_id");
    expect(script).toMatch(/agentId:/);
    expect(script).toMatch(/toolUseId:/);
  });

  it("sends null rather than an empty string for the main agent", () => {
    // `""` is truthy enough downstream to look like an identity. NULL is the
    // main agent, matching how the columns are stored.
    const script = read("pre-tool-use.sh");
    expect(script).toMatch(/if \$agentId == "" then null else \$agentId end/);
  });
});

describe("the model cannot claim to be another agent", () => {
  it("mark tool schemas do not expose the producer fields", async () => {
    // Identity is resolved by the daemon from the tool call that produced the
    // mark. An identity the caller supplies is an identity the caller can
    // forge, so the parameter must not exist in the contract the model sees.
    const { createCodeMemoryDatabaseConnection } = await import("../src/db/connection.js");
    const { ConversationStore } = await import("../src/store/conversation-store.js");
    const { createMemoryNodeStore } = await import("../src/store/memory-store.js");
    const { createCodeMemoryMarkDecisionTool } = await import(
      "../src/tools/codememory-mark-decision-tool.js"
    );

    const db = await createCodeMemoryDatabaseConnection(":memory:");
    const tool: any = await createCodeMemoryMarkDecisionTool(
      new ConversationStore(db),
      () => "sess-A",
      createMemoryNodeStore(db)
    );

    const exposed = Object.keys(tool.params.properties);
    expect(exposed).not.toContain("producerAgentId");
    expect(exposed).not.toContain("producerPromptId");
    await db.close();
  });
});
