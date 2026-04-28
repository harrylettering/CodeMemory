/**
 * lcm_mark_requirement — durable task / constraint punctuation.
 *
 * Exposed via the lcm-mark-task and lcm-mark-constraint Skills, whose
 * bodies curl `/mark/requirement` on the daemon socket. Daemon delegates
 * here, which writes a Memory Node only — the matching S-tier
 * conversation_messages row is produced by the JSONL watcher when it
 * recognizes the Skill tool_use.
 */
export class LcmMarkRequirementTool {
    conversationStore;
    getCurrentSessionId;
    memoryStore;
    constructor(conversationStore, getCurrentSessionId, memoryStore) {
        this.conversationStore = conversationStore;
        this.getCurrentSessionId = getCurrentSessionId;
        this.memoryStore = memoryStore;
    }
    async mark(params) {
        const kind = params.kind;
        const requirement = (params.requirement || "").trim();
        if ((kind !== "task" && kind !== "constraint") || !requirement) {
            return {
                ok: false,
                reason: "Both `kind` (`task` or `constraint`) and `requirement` are required.",
            };
        }
        const sessionId = params.sessionId || this.getCurrentSessionId();
        if (!sessionId) {
            return {
                ok: false,
                reason: "No active sessionId — cannot route the requirement to a conversation.",
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
        const content = renderRequirementContent(params);
        const memoryNode = kind === "task"
            ? await this.memoryStore.createTaskNode({
                conversationId: conversation.conversationId,
                sessionId,
                sourceToolUseId: params.sourceToolUseId ?? null,
                task: requirement,
                details: params.details,
                acceptanceCriteria: params.acceptance_criteria,
                content,
                supersedesNodeId: params.supersedesNodeId,
            })
            : await this.memoryStore.createConstraintNode({
                conversationId: conversation.conversationId,
                sessionId,
                sourceToolUseId: params.sourceToolUseId ?? null,
                constraint: requirement,
                details: params.details,
                acceptanceCriteria: params.acceptance_criteria,
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
function renderRequirementContent(p) {
    const lines = [];
    lines.push(`${p.kind === "task" ? "[TASK]" : "[CONSTRAINT]"} ${p.requirement.trim()}`);
    if (p.details?.trim()) {
        lines.push(`Details: ${p.details.trim()}`);
    }
    const acceptanceCriteria = (p.acceptance_criteria || [])
        .map((item) => (item || "").trim())
        .filter(Boolean);
    if (acceptanceCriteria.length > 0) {
        lines.push("Acceptance criteria:");
        for (const item of acceptanceCriteria) {
            lines.push(`  - ${item}`);
        }
    }
    return lines.join("\n");
}
export async function createLcmMarkRequirementTool(conversationStore, getCurrentSessionId, memoryStore) {
    const tool = new LcmMarkRequirementTool(conversationStore, getCurrentSessionId, memoryStore);
    return {
        name: "lcm_mark_requirement",
        description: "Mark a durable task or hard constraint so future turns can recall the current goal and must-not-break rules. Invoked via the lcm-mark-task / lcm-mark-constraint Skills.",
        params: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["task", "constraint"],
                    description: "Whether this memory is a current task/goal or a hard constraint.",
                },
                requirement: {
                    type: "string",
                    description: "The task or constraint itself, one durable sentence.",
                },
                details: {
                    type: "string",
                    description: "Optional supporting details or target state.",
                },
                acceptance_criteria: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional checks that define done / must hold.",
                },
                sessionId: {
                    type: "string",
                    description: "Optional sessionId override. Use only when ambient session routing is unavailable.",
                },
                supersedesNodeId: {
                    type: "string",
                    description: "Optional Memory Node id of the older task or constraint this requirement supersedes.",
                },
                sourceToolUseId: {
                    type: "string",
                    description: "Idempotency key from the originating tool_use block.",
                },
            },
            required: ["kind", "requirement"],
        },
        async call(params) {
            return tool.mark(params);
        },
    };
}
//# sourceMappingURL=lcm-mark-requirement-tool.js.map