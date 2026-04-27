/**
 * codememory_memory_pending - debug/admin lifecycle pending-update management.
 *
 * Pending updates are deliberately not applied on the hot path when the
 * resolver cannot identify one target node with high confidence. This tool
 * exposes the small admin loop for listing, applying, or dismissing them.
 */

import type {
  MemoryNodeRecord,
  MemoryNodeStore,
  MemoryPendingUpdateRecord,
} from "../store/memory-store.js";

type PendingStatus = "pending" | "applied" | "dismissed";

export interface CodeMemoryMemoryPendingParams {
  action: "list" | "apply" | "dismiss";
  pendingId?: number;
  targetNodeId?: string;
  reason?: string;
  status?: PendingStatus;
  limit?: number;
}

export interface CodeMemoryMemoryPendingResult {
  ok: boolean;
  action: "list" | "apply" | "dismiss";
  count?: number;
  pendingUpdates?: Array<ReturnType<typeof shapePendingUpdate>>;
  pendingUpdate?: ReturnType<typeof shapePendingUpdate>;
  node?: ReturnType<typeof shapeNode>;
  reason?: string;
}

export class CodeMemoryMemoryPendingTool {
  constructor(private memoryStore: MemoryNodeStore) {}

  async run(params: CodeMemoryMemoryPendingParams): Promise<CodeMemoryMemoryPendingResult> {
    const action = params.action;
    if (action === "list") return this.list(params);
    if (action === "apply") return this.apply(params);
    if (action === "dismiss") return this.dismiss(params);
    return {
      ok: false,
      action: "list",
      reason: "action must be one of: list, apply, dismiss",
    };
  }

  private async list(
    params: CodeMemoryMemoryPendingParams
  ): Promise<CodeMemoryMemoryPendingResult> {
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

  private async apply(
    params: CodeMemoryMemoryPendingParams
  ): Promise<CodeMemoryMemoryPendingResult> {
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

  private async dismiss(
    params: CodeMemoryMemoryPendingParams
  ): Promise<CodeMemoryMemoryPendingResult> {
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

function shapePendingUpdate(update: MemoryPendingUpdateRecord) {
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

function shapeNode(node: MemoryNodeRecord) {
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

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function createCodeMemoryMemoryPendingTool(
  memoryStore: MemoryNodeStore
): Promise<{
  name: string;
  description: string;
  params: { type: string; properties: Record<string, any>; required: string[] };
  call: (params: any) => Promise<any>;
}> {
  const tool = new CodeMemoryMemoryPendingTool(memoryStore);
  return {
    name: "codememory_memory_pending",
    description:
      "Debug/admin tool for Memory Node lifecycle pending updates. List ambiguous updates, apply one to an explicit target node, or dismiss it after review.",
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
          description:
            "Explicit target Memory Node id. Required when applying a pending update with multiple candidates.",
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
    async call(params: CodeMemoryMemoryPendingParams) {
      return tool.run(params);
    },
  };
}
