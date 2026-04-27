/**
 * codememory_mark_decision — durable decision punctuation.
 *
 * Exposed to the model via the `codememory-mark-decision` Skill, whose body curls
 * the daemon's `/mark/decision` endpoint. The daemon then calls into this
 * tool, which materializes the decision as a Memory Node so:
 *
 *   1. Retrieval can pick it up by tag (kind=decision + file/symbol pivots)
 *      across future sessions.
 *   2. Conflict detection / supersession can link related decisions.
 *
 * The corresponding S-tier conversation_messages row is written by the
 * JSONL watcher when it sees the model's tool_use → curl side-effect.
 * That keeps the daemon as the only writer of memory_nodes and the watcher
 * as the only writer of conversation_messages — single-writer per table.
 */

import type { ConversationStore } from "../store/conversation-store.js";
import type { MemoryNodeStore } from "../store/memory-store.js";

export interface CodeMemoryMarkDecisionParams {
  /** What was decided. One sentence, imperative-ish. */
  decision: string;
  /** Why this decision was made. */
  rationale: string;
  /** Other options that were considered and rejected, with one-line reasons. */
  alternatives_rejected?: string[];
  /** Optional sessionId override (defaults to current session). */
  sessionId?: string;
  /** Optional old decision Memory Node id that this decision replaces. */
  supersedesNodeId?: string;
  /**
   * Idempotency key from the model's tool_use block. The daemon receives
   * this from the Skill's curl payload. Re-invocations with the same id
   * collapse onto the same Memory Node.
   */
  sourceToolUseId?: string;
}

export interface CodeMemoryMarkDecisionResult {
  ok: boolean;
  conversationId?: number;
  memoryNodeId?: string;
  reason?: string;
}

export class CodeMemoryMarkDecisionTool {
  constructor(
    private conversationStore: ConversationStore,
    private getCurrentSessionId: () => string | undefined,
    private memoryStore?: MemoryNodeStore
  ) {}

  async mark(params: CodeMemoryMarkDecisionParams): Promise<CodeMemoryMarkDecisionResult> {
    const decision = (params.decision || "").trim();
    const rationale = (params.rationale || "").trim();
    if (!decision || !rationale) {
      return {
        ok: false,
        reason: "Both `decision` and `rationale` are required.",
      };
    }

    const sessionId = params.sessionId || this.getCurrentSessionId();
    if (!sessionId) {
      return {
        ok: false,
        reason: "No active sessionId — cannot route the decision to a conversation.",
      };
    }

    if (!this.memoryStore) {
      return {
        ok: false,
        reason:
          "Memory store unavailable — daemon must be initialized with a MemoryNodeStore.",
      };
    }

    const conversation = await this.conversationStore.getOrCreateConversation({
      sessionId,
    });

    const content = renderDecisionContent(params);

    const memoryNode = await this.memoryStore.createDecisionNode({
      conversationId: conversation.conversationId,
      sessionId,
      sourceToolUseId: params.sourceToolUseId ?? null,
      decision,
      rationale,
      alternativesRejected: params.alternatives_rejected,
      content,
      supersedesNodeId: params.supersedesNodeId,
    });

    return {
      ok: true,
      conversationId: conversation.conversationId,
      memoryNodeId: memoryNode.nodeId,
    };
  }
}

function renderDecisionContent(p: CodeMemoryMarkDecisionParams): string {
  const lines: string[] = [];
  lines.push(`[DECISION] ${p.decision.trim()}`);
  lines.push(`Rationale: ${p.rationale.trim()}`);
  const alts = (p.alternatives_rejected || [])
    .map((a) => (a || "").trim())
    .filter(Boolean);
  if (alts.length > 0) {
    lines.push("Rejected:");
    for (const a of alts) lines.push(`  - ${a}`);
  }
  return lines.join("\n");
}

export async function createCodeMemoryMarkDecisionTool(
  conversationStore: ConversationStore,
  getCurrentSessionId: () => string | undefined,
  memoryStore?: MemoryNodeStore
): Promise<{
  name: string;
  description: string;
  params: { type: string; properties: Record<string, any>; required: string[] };
  call: (params: any) => Promise<any>;
}> {
  const tool = new CodeMemoryMarkDecisionTool(
    conversationStore,
    getCurrentSessionId,
    memoryStore
  );

  return {
    name: "codememory_mark_decision",
    description:
      "Mark a design or implementation decision so it survives compaction and can be recalled in future sessions. Invoked via the codememory-mark-decision Skill (curl → daemon). Do NOT call for trivial choices.",
    params: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          description: "The decision itself, one sentence.",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made.",
        },
        alternatives_rejected: {
          type: "array",
          items: { type: "string" },
          description:
            "Other options considered and rejected, each with a one-line reason.",
        },
        sessionId: {
          type: "string",
          description:
            "Optional sessionId override. Use only when ambient session routing is unavailable.",
        },
        supersedesNodeId: {
          type: "string",
          description:
            "Optional Memory Node id of the older decision this new decision supersedes.",
        },
        sourceToolUseId: {
          type: "string",
          description:
            "Idempotency key from the originating tool_use block. Re-invocations with the same value collapse onto the same Memory Node.",
        },
      },
      required: ["decision", "rationale"],
    },
    async call(params: CodeMemoryMarkDecisionParams) {
      return tool.mark(params);
    },
  };
}
