/**
 * codememory_memory_pending - debug/admin lifecycle pending-update management.
 *
 * Pending updates are deliberately not applied on the hot path when the
 * resolver cannot identify one target node with high confidence. This tool
 * exposes the small admin loop for listing, applying, or dismissing them.
 */
export class CodeMemoryMemoryPendingTool {
    memoryStore;
    constructor(memoryStore) {
        this.memoryStore = memoryStore;
    }
    async run(params) {
        const action = params.action;
        if (action === "list")
            return this.list(params);
        if (action === "apply")
            return this.apply(params);
        if (action === "dismiss")
            return this.dismiss(params);
        return {
            ok: false,
            action: "list",
            reason: "action must be one of: list, apply, dismiss",
        };
    }
    async list(params) {
        const status = params.status ?? "pending";
        const limit = clampLimit(params.limit, 20);
        const rows = (await this.memoryStore.getPendingUpdates(status)).slice(0, limit);
        return {
            ok: true,
            action: "list",
            count: rows.length,
            pendingUpdates: rows.map(shapePendingUpdate),
        };
    }
    async apply(params) {
        const pendingId = parsePositiveInt(params.pendingId);
        if (pendingId == null) {
            return {
                ok: false,
                action: "apply",
                reason: "pendingId is required for apply",
            };
        }
        const result = await this.memoryStore.applyPendingUpdate({
            pendingId,
            targetNodeId: params.targetNodeId,
            reason: params.reason,
            metadata: { appliedByTool: "codememory_memory_pending" },
        });
        return {
            ok: result.ok,
            action: "apply",
            pendingUpdate: result.pending ? shapePendingUpdate(result.pending) : undefined,
            node: result.node ? shapeNode(result.node) : undefined,
            reason: result.reason,
        };
    }
    async dismiss(params) {
        const pendingId = parsePositiveInt(params.pendingId);
        if (pendingId == null) {
            return {
                ok: false,
                action: "dismiss",
                reason: "pendingId is required for dismiss",
            };
        }
        const result = await this.memoryStore.dismissPendingUpdate({
            pendingId,
            reason: params.reason,
        });
        return {
            ok: result.ok,
            action: "dismiss",
            pendingUpdate: result.pending ? shapePendingUpdate(result.pending) : undefined,
            reason: result.reason,
        };
    }
}
function shapePendingUpdate(update) {
    return {
        pendingId: update.pendingId,
        transition: update.transition,
        eventType: update.eventType,
        targetNodeId: update.targetNodeId,
        targetCandidates: update.targetCandidates.slice(0, 8),
        fromStatus: update.fromStatus,
        toStatus: update.toStatus,
        confidence: update.confidence,
        reason: update.reason,
        evidenceMessageId: update.evidenceMessageId,
        evidenceSummaryId: update.evidenceSummaryId,
        metadata: update.metadata,
        status: update.status,
        createdAt: update.createdAt,
        updatedAt: update.updatedAt,
    };
}
function shapeNode(node) {
    return {
        nodeId: node.nodeId,
        kind: node.kind,
        status: node.status,
        confidence: node.confidence,
        conversationId: node.conversationId,
        sessionId: node.sessionId,
        source: node.source,
        sourceId: node.sourceId,
        summaryId: node.summaryId,
        contentPreview: node.content.slice(0, 500),
        metadata: node.metadata,
        updatedAt: node.updatedAt,
    };
}
function clampLimit(limit, fallback) {
    if (typeof limit !== "number" || !Number.isFinite(limit))
        return fallback;
    return Math.max(1, Math.min(100, Math.trunc(limit)));
}
function parsePositiveInt(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.trunc(value);
    }
    if (typeof value !== "string" || value.trim() === "")
        return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export async function createCodeMemoryMemoryPendingTool(memoryStore) {
    const tool = new CodeMemoryMemoryPendingTool(memoryStore);
    return {
        name: "codememory_memory_pending",
        description: "Debug/admin tool for Memory Node lifecycle pending updates. List ambiguous updates, apply one to an explicit target node, or dismiss it after review.",
        params: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "apply", "dismiss"],
                    description: "Operation to perform.",
                },
                pendingId: {
                    type: "number",
                    description: "Pending update id. Required for apply and dismiss.",
                },
                targetNodeId: {
                    type: "string",
                    description: "Explicit target Memory Node id. Required when applying a pending update with multiple candidates.",
                },
                reason: {
                    type: "string",
                    description: "Optional audit reason for apply or dismiss.",
                },
                status: {
                    type: "string",
                    enum: ["pending", "applied", "dismissed"],
                    description: "Status filter for list. Defaults to pending.",
                },
                limit: {
                    type: "number",
                    description: "Max list rows to return. Defaults to 20, max 100.",
                },
            },
            required: ["action"],
        },
        async call(params) {
            return tool.run(params);
        },
    };
}
//# sourceMappingURL=codememory-memory-pending-tool.js.map