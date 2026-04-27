/**
 * codememory_memory_lifecycle - debug/admin Memory Node lifecycle inspection.
 *
 * This is intentionally exposed only behind CODEMEMORY_DEBUG_TOOLS_ENABLED. The
 * prompt hot path should use proactive retrieval; this tool is for auditing
 * and correcting lifecycle state when humans or tests need a precise handle.
 */

import type { LifecycleResolver } from "../lifecycle-resolver.js";
import type {
  MemoryLifecycleEventRecord,
  MemoryNodeRecord,
  MemoryNodeStore,
  MemoryRelationRecord,
  MemoryTagInput,
} from "../store/memory-store.js";

export interface CodeMemoryMemoryLifecycleParams {
  action:
    | "inspect_node"
    | "list_events"
    | "list_relations"
    | "stale_maintenance"
    | "resolve_node"
    | "supersede_node"
    | "supersede_decision"
    | "mark_stale"
    | "reopen_failure";
  nodeId?: string;
  direction?: "from" | "to" | "both";
  conversationId?: number;
  oldNodeId?: string;
  newNodeId?: string;
  reason?: string;
  limit?: number;
  summaryOlderThanDays?: number;
  resolvedFailureOlderThanDays?: number;
  resolvedFixAttemptOlderThanDays?: number;
  supersededOlderThanDays?: number;
}

export interface CodeMemoryMemoryLifecycleResult {
  ok: boolean;
  action: CodeMemoryMemoryLifecycleParams["action"];
  reason?: string;
  node?: ReturnType<typeof shapeNode>;
  tags?: MemoryTagInput[];
  events?: Array<ReturnType<typeof shapeEvent>>;
  relations?: Array<ReturnType<typeof shapeRelation>>;
  staleNodeIds?: string[];
  count?: number;
}

export class CodeMemoryMemoryLifecycleTool {
  constructor(
    private memoryStore: MemoryNodeStore,
    private lifecycleResolver: LifecycleResolver
  ) {}

  async run(params: CodeMemoryMemoryLifecycleParams): Promise<CodeMemoryMemoryLifecycleResult> {
    switch (params.action) {
      case "inspect_node":
        return this.inspectNode(params);
      case "list_events":
        return this.listEvents(params);
      case "list_relations":
        return this.listRelations(params);
      case "stale_maintenance":
        return this.runStaleMaintenance(params);
      case "resolve_node":
        return this.resolveNode(params);
      case "supersede_node":
        return this.supersedeNode(params);
      case "supersede_decision":
        return this.supersedeDecision(params);
      case "mark_stale":
        return this.markStale(params);
      case "reopen_failure":
        return this.reopenFailure(params);
      default:
        return {
          ok: false,
          action: params.action,
          reason: "unknown lifecycle action",
        };
    }
  }

  private async inspectNode(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const node = await this.memoryStore.getNode(nodeId);
    if (!node) {
      return { ok: false, action: params.action, reason: `node ${nodeId} not found` };
    }
    const [tags, events, relations] = await Promise.all([
      this.memoryStore.getTags(nodeId),
      this.memoryStore.getLifecycleEvents(nodeId),
      this.memoryStore.getRelationsForNode(nodeId, "both"),
    ]);
    return {
      ok: true,
      action: params.action,
      node: shapeNode(node),
      tags,
      events: events.slice(0, clampLimit(params.limit, 10)).map(shapeEvent),
      relations: relations.slice(0, clampLimit(params.limit, 20)).map(shapeRelation),
    };
  }

  private async listEvents(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const events = await this.memoryStore.getLifecycleEvents(nodeId);
    return {
      ok: true,
      action: params.action,
      count: events.length,
      events: events.slice(0, clampLimit(params.limit, 20)).map(shapeEvent),
    };
  }

  private async listRelations(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const relations = await this.memoryStore.getRelationsForNode(
      nodeId,
      params.direction ?? "both"
    );
    return {
      ok: true,
      action: params.action,
      count: relations.length,
      relations: relations.slice(0, clampLimit(params.limit, 20)).map(shapeRelation),
    };
  }

  private async runStaleMaintenance(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const result = await this.memoryStore.runStaleMaintenance({
      limit: clampLimit(params.limit, 100),
      summaryOlderThanDays: params.summaryOlderThanDays,
      resolvedFailureOlderThanDays: params.resolvedFailureOlderThanDays,
      resolvedFixAttemptOlderThanDays: params.resolvedFixAttemptOlderThanDays,
      supersededOlderThanDays: params.supersededOlderThanDays,
    });
    return {
      ok: true,
      action: params.action,
      count: result.staleNodeIds.length,
      staleNodeIds: result.staleNodeIds,
      reason: `scanned ${result.scanned} memory node(s)`,
    };
  }

  private async supersedeDecision(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    return this.supersedeNode(params, "supersede_decision");
  }

  private async resolveNode(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const result = await this.lifecycleResolver.resolveNode({
      nodeId,
      reason: params.reason,
    });
    return {
      ok: result.action === "applied" || /already resolved/.test(result.reason),
      action: params.action,
      count: result.targetNodeIds.length,
      reason: result.reason,
    };
  }

  private async supersedeNode(
    params: CodeMemoryMemoryLifecycleParams,
    action: CodeMemoryMemoryLifecycleParams["action"] = params.action
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    if (!params.oldNodeId || !params.newNodeId) {
      return {
        ok: false,
        action,
        reason: "oldNodeId and newNodeId are required",
      };
    }
    const result = await this.lifecycleResolver.supersedeNode({
      oldNodeId: params.oldNodeId,
      newNodeId: params.newNodeId,
      reason: params.reason ?? "manual lifecycle supersede",
    });
    return {
      ok: result.action === "applied",
      action,
      count: result.targetNodeIds.length,
      reason: result.reason,
    };
  }

  private async markStale(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const node = await this.memoryStore.getNode(nodeId);
    const result = node?.kind === "summary"
      ? await this.lifecycleResolver.markSummaryStale({
          nodeId,
          reason: params.reason,
        })
      : await this.lifecycleResolver.markNodeStale({
          nodeId,
          reason: params.reason,
        });
    return {
      ok: result.action === "applied",
      action: params.action,
      count: result.targetNodeIds.length,
      staleNodeIds: result.targetNodeIds,
      reason: result.reason,
    };
  }

  private async reopenFailure(
    params: CodeMemoryMemoryLifecycleParams
  ): Promise<CodeMemoryMemoryLifecycleResult> {
    const nodeId = requiredNodeId(params);
    if (!nodeId) return missingNodeId(params.action);
    const result = await this.lifecycleResolver.reopenFailure({
      nodeId,
      reason: params.reason,
    });
    return {
      ok: result.action === "applied" || result.reason === "failure is already active",
      action: params.action,
      count: result.targetNodeIds.length,
      reason: result.reason,
    };
  }
}

function requiredNodeId(params: CodeMemoryMemoryLifecycleParams): string | null {
  const value = params.nodeId?.trim();
  return value || null;
}

function missingNodeId(
  action: CodeMemoryMemoryLifecycleParams["action"]
): CodeMemoryMemoryLifecycleResult {
  return { ok: false, action, reason: "nodeId is required" };
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
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    lastUsedAt: node.lastUsedAt,
    useCount: node.useCount,
  };
}

function shapeEvent(event: MemoryLifecycleEventRecord) {
  return {
    eventId: event.eventId,
    nodeId: event.nodeId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    eventType: event.eventType,
    confidence: event.confidence,
    reason: event.reason,
    evidenceMessageId: event.evidenceMessageId,
    evidenceSummaryId: event.evidenceSummaryId,
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
}

function shapeRelation(relation: MemoryRelationRecord) {
  return {
    relationId: relation.relationId,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    relationType: relation.relationType,
    confidence: relation.confidence,
    evidenceMessageId: relation.evidenceMessageId,
    evidenceSummaryId: relation.evidenceSummaryId,
    metadata: relation.metadata,
    createdAt: relation.createdAt,
  };
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

export async function createCodeMemoryMemoryLifecycleTool(
  memoryStore: MemoryNodeStore,
  lifecycleResolver: LifecycleResolver
): Promise<{
  name: string;
  description: string;
  params: { type: string; properties: Record<string, any>; required: string[] };
  call: (params: any) => Promise<any>;
}> {
  const tool = new CodeMemoryMemoryLifecycleTool(memoryStore, lifecycleResolver);
  return {
    name: "codememory_memory_lifecycle",
    description:
      "Debug/admin tool for inspecting and correcting Memory Node lifecycle state: events, relations, stale maintenance, resolve/supersede, reopen, and stale marking.",
    params: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "inspect_node",
            "list_events",
            "list_relations",
            "stale_maintenance",
            "resolve_node",
            "supersede_node",
            "supersede_decision",
            "mark_stale",
            "reopen_failure",
          ],
          description: "Lifecycle operation to perform.",
        },
        nodeId: {
          type: "string",
          description: "Memory Node id for node-specific operations.",
        },
        direction: {
          type: "string",
          enum: ["from", "to", "both"],
          description: "Relation direction for list_relations.",
        },
        conversationId: {
          type: "number",
          description: "Optional conversation scope for lifecycle queries.",
        },
        oldNodeId: {
          type: "string",
          description: "Older Memory Node id for supersede_node / supersede_decision.",
        },
        newNodeId: {
          type: "string",
          description: "Newer Memory Node id for supersede_node / supersede_decision.",
        },
        reason: {
          type: "string",
          description: "Optional audit reason.",
        },
        limit: {
          type: "number",
          description: "Max rows to inspect or return.",
        },
        summaryOlderThanDays: { type: "number" },
        resolvedFailureOlderThanDays: { type: "number" },
        resolvedFixAttemptOlderThanDays: { type: "number" },
        supersededOlderThanDays: { type: "number" },
      },
      required: ["action"],
    },
    async call(params: CodeMemoryMemoryLifecycleParams) {
      return tool.run(params);
    },
  };
}
