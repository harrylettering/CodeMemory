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
export class CodeMemoryMarkDecisionTool {
    conversationStore;
    getCurrentSessionId;
    memoryStore;
    constructor(conversationStore, getCurrentSessionId, memoryStore) {
        this.conversationStore = conversationStore;
        this.getCurrentSessionId = getCurrentSessionId;
        this.memoryStore = memoryStore;
    }
    async mark(params) {
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
                reason: "Memory store unavailable — daemon must be initialized with a MemoryNodeStore.",
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
function renderDecisionContent(p) {
    const lines = [];
    lines.push(`[DECISION] ${p.decision.trim()}`);
    lines.push(`Rationale: ${p.rationale.trim()}`);
    const alts = (p.alternatives_rejected || [])
        .map((a) => (a || "").trim())
        .filter(Boolean);
    if (alts.length > 0) {
        lines.push("Rejected:");
        for (const a of alts)
            lines.push(`  - ${a}`);
    }
    return lines.join("\n");
}
export async function createCodeMemoryMarkDecisionTool(conversationStore, getCurrentSessionId, memoryStore) {
    const tool = new CodeMemoryMarkDecisionTool(conversationStore, getCurrentSessionId, memoryStore);
    return {
        name: "codememory_mark_decision",
        description: "Mark a design or implementation decision so it survives compaction and can be recalled in future sessions. Invoked via the codememory-mark-decision Skill (curl → daemon). Do NOT call for trivial choices.",
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
                    description: "Other options considered and rejected, each with a one-line reason.",
                },
                sessionId: {
                    type: "string",
                    description: "Optional sessionId override. Use only when ambient session routing is unavailable.",
                },
                supersedesNodeId: {
                    type: "string",
                    description: "Optional Memory Node id of the older decision this new decision supersedes.",
                },
                sourceToolUseId: {
                    type: "string",
                    description: "Idempotency key from the originating tool_use block. Re-invocations with the same value collapse onto the same Memory Node.",
                },
            },
            required: ["decision", "rationale"],
        },
        async call(params) {
            return tool.mark(params);
        },
    };
}
//# sourceMappingURL=codememory-mark-decision-tool.js.map