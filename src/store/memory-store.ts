import {
  commandVariants,
  extractPromptPivots,
  inferTopics,
  normalizeTagValue,
  qualifyFileTag,
  type RetrievalPlan,
  type WantedMemoryKind,
} from "../retrieval-plan.js";
import type { SummaryRecord } from "./summary-store.js";
import type { DecisionSupersedeJudge } from "./decision-supersede-judge.js";

export interface MemoryNodeStoreOptions {
  /** Enables LLM-as-judge auto-supersede for same-conversation decisions. */
  autoSupersedeViaLlm?: boolean;
  /** Max active decisions in the conversation considered by the judge per call. */
  autoSupersedeMaxCandidates?: number;
  /** Judge implementation. Required when `autoSupersedeViaLlm` is true. */
  decisionJudge?: DecisionSupersedeJudge;
}

const MAX_MEMORY_NODE_CONTENT_CHARS = 6000;

export type MemoryNodeKind =
  | "task"
  | "constraint"
  | "decision"
  | "failure"
  | "fix_attempt"
  | "summary";

export type MemoryNodeStatus = "active" | "resolved" | "superseded" | "stale";

export interface MemoryTagInput {
  tagType: string;
  tagValue: string;
  weight?: number;
}

export interface MemoryNodeRecord {
  nodeId: string;
  kind: MemoryNodeKind;
  status: MemoryNodeStatus;
  confidence: number;
  conversationId: number | null;
  sessionId: string | null;
  source: string;
  sourceId: string | null;
  sourceToolUseId: string | null;
  summaryId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  supersedesNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemorySearchCandidate {
  node: MemoryNodeRecord;
  score: number;
  matchedTags: Array<{
    tagType: string;
    tagValue: string;
    weight: number;
  }>;
}

export type MemoryRelationType =
  | "supersedes"
  | "supersededBy"
  | "resolves"
  | "attemptedFixFor"
  | "causedBy"
  | "derivedFromSummary"
  | "evidenceOf"
  | "conflictsWith"
  | "relatedTo";

export interface MemoryRelationInput {
  fromNodeId: string;
  toNodeId: string;
  relationType: MemoryRelationType;
  confidence?: number;
  evidenceMessageId?: number | null;
  evidenceSummaryId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryRelationRecord {
  relationId: number;
  fromNodeId: string;
  toNodeId: string;
  relationType: MemoryRelationType;
  confidence: number;
  evidenceMessageId: number | null;
  evidenceSummaryId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLifecycleEventInput {
  nodeId: string;
  fromStatus?: MemoryNodeStatus | null;
  toStatus: MemoryNodeStatus;
  eventType: string;
  confidence?: number;
  reason?: string;
  evidenceMessageId?: number | null;
  evidenceSummaryId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryLifecycleEventRecord {
  eventId: number;
  nodeId: string;
  fromStatus: MemoryNodeStatus | null;
  toStatus: MemoryNodeStatus;
  eventType: string;
  confidence: number;
  reason: string | null;
  evidenceMessageId: number | null;
  evidenceSummaryId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryPendingUpdateInput {
  transition: string;
  eventType: string;
  targetNodeId?: string | null;
  targetCandidates?: Array<{ nodeId: string; score: number; reason?: string }>;
  fromStatus?: MemoryNodeStatus | null;
  toStatus: MemoryNodeStatus;
  confidence: number;
  reason?: string;
  evidenceMessageId?: number | null;
  evidenceSummaryId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryPendingUpdateRecord {
  pendingId: number;
  transition: string;
  eventType: string;
  targetNodeId: string | null;
  targetCandidates: Array<{ nodeId: string; score: number; reason?: string }>;
  fromStatus: MemoryNodeStatus | null;
  toStatus: MemoryNodeStatus;
  confidence: number;
  reason: string | null;
  evidenceMessageId: number | null;
  evidenceSummaryId: string | null;
  metadata: Record<string, unknown>;
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface ApplyMemoryPendingUpdateInput {
  pendingId: number;
  targetNodeId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ApplyMemoryPendingUpdateResult {
  ok: boolean;
  pending?: MemoryPendingUpdateRecord;
  node?: MemoryNodeRecord;
  reason?: string;
}

export interface DismissMemoryPendingUpdateInput {
  pendingId: number;
  reason?: string;
}

export interface DismissMemoryPendingUpdateResult {
  ok: boolean;
  pending?: MemoryPendingUpdateRecord;
  reason?: string;
}

export interface FailureAnchorCandidate {
  node: MemoryNodeRecord;
  score: number;
  matchedAnchors: string[];
}

export interface UpsertMemoryNodeInput {
  nodeId: string;
  kind: MemoryNodeKind;
  status?: MemoryNodeStatus;
  confidence?: number;
  conversationId?: number | null;
  sessionId?: string | null;
  source: string;
  sourceId?: string | null;
  sourceToolUseId?: string | null;
  summaryId?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  supersedesNodeId?: string | null;
  tags?: MemoryTagInput[];
}

export interface UpdateMemoryNodeStatusInput {
  nodeId: string;
  toStatus: MemoryNodeStatus;
  eventType: string;
  confidence?: number;
  reason?: string;
  evidenceMessageId?: number | null;
  evidenceSummaryId?: string | null;
  metadata?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
}

export interface SupersedeDecisionInput {
  oldNodeId: string;
  newNodeId: string;
  reason?: string;
  confidence?: number;
  evidenceMessageId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StaleMaintenanceInput {
  now?: string | Date;
  summaryOlderThanDays?: number;
  resolvedFailureOlderThanDays?: number;
  resolvedFixAttemptOlderThanDays?: number;
  supersededOlderThanDays?: number;
  maxUseCount?: number;
  limit?: number;
}

export interface StaleMaintenanceResult {
  scanned: number;
  staleNodeIds: string[];
  nodes: MemoryNodeRecord[];
}

export interface CreateFailureNodeInput {
  conversationId: number;
  sessionId?: string | null;
  /** Conversation seq of the failure occurrence — used for auto-resolve windows. */
  seq: number;
  /** Coarse classifier (test_fail, type_error, ...). */
  type: string;
  /** Normalized error fingerprint — primary tag for cross-session recall. */
  signature: string;
  /** Verbatim error text. */
  raw: string;
  /** Legacy generic location string. Prefer filePath/command. */
  location?: string;
  attemptedFix?: string;
  filePath?: string;
  command?: string;
  symbol?: string;
  /** JSONL message UUID where the error appeared (anchor for expansion). */
  messageId?: string;
  /** Numeric DB messageId for evidence linking. */
  evidenceMessageId?: number | null;
  /** Stored relevance weight, independent of age. Defaults to 1.0. */
  weight?: number;
  /** Optional override of the generated nodeId — used by deterministic fixtures. */
  nodeIdOverride?: string;
}

export interface ResolveFailureNodesByTargetInput {
  conversationId: number;
  target: { filePath?: string; command?: string };
  resolution: string;
  evidenceMessageId?: number | null;
}

export interface AutoResolveStaleFailureNodesInput {
  conversationId: number;
  currentSeq: number;
  olderThanSeqs: number;
  resolution: string;
}

export interface CreateFixAttemptNodeInput {
  attemptId: string;
  conversationId: number;
  sessionId?: string | null;
  status?: MemoryNodeStatus;
  outcome: "unknown" | "succeeded" | "failed" | "partial";
  touchedFiles?: string[];
  commandsRun?: string[];
  relatedFailureNodeIds?: string[];
  startedAtSeq?: number;
  endedAtSeq?: number | null;
  evidenceMessageId?: number | null;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskNodeInput {
  conversationId: number;
  sessionId?: string | null;
  /** Legacy anchor — only used for nodeId derivation when no toolUseId. */
  messageId?: number | null;
  /** Preferred idempotency key from a model tool_use invocation. */
  sourceToolUseId?: string | null;
  task: string;
  details?: string;
  acceptanceCriteria?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
  supersedesNodeId?: string;
}

export interface CreateConstraintNodeInput {
  conversationId: number;
  sessionId?: string | null;
  messageId?: number | null;
  sourceToolUseId?: string | null;
  constraint: string;
  details?: string;
  acceptanceCriteria?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
  supersedesNodeId?: string;
}

export interface SupersedeMemoryNodeInput {
  oldNodeId: string;
  newNodeId: string;
  reason?: string;
  confidence?: number;
  evidenceMessageId?: number | null;
  metadata?: Record<string, unknown>;
}

export class MemoryNodeStore {
  constructor(
    private db: any,
    private options: MemoryNodeStoreOptions = {}
  ) {}

  async upsertNode(input: UpsertMemoryNodeInput): Promise<MemoryNodeRecord> {
    const now = new Date().toISOString();
    const quality = normalizeMemoryNodeInput(input);
    const metadata = JSON.stringify({
      ...(input.metadata ?? {}),
      ...(quality.truncated ? { quality: { contentTruncated: true } } : {}),
    });
    const status = input.status ?? "active";
    await this.db.run(
      `INSERT INTO memory_nodes (
         nodeId, kind, status, confidence, conversationId, sessionId,
         source, sourceId, sourceToolUseId, summaryId, content, metadata,
         supersedesNodeId, createdAt, updatedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(nodeId) DO UPDATE SET
         kind = excluded.kind,
         status = excluded.status,
         confidence = excluded.confidence,
         conversationId = excluded.conversationId,
         sessionId = excluded.sessionId,
         source = excluded.source,
         sourceId = excluded.sourceId,
         sourceToolUseId = COALESCE(excluded.sourceToolUseId, memory_nodes.sourceToolUseId),
         summaryId = excluded.summaryId,
         content = excluded.content,
         metadata = excluded.metadata,
         supersedesNodeId = excluded.supersedesNodeId,
         updatedAt = excluded.updatedAt`,
      [
        input.nodeId,
        input.kind,
        status,
        input.confidence ?? 1.0,
        input.conversationId ?? null,
        input.sessionId ?? null,
        input.source,
        input.sourceId ?? null,
        input.sourceToolUseId ?? null,
        input.summaryId ?? null,
        quality.content,
        metadata,
        input.supersedesNodeId ?? null,
        now,
        now,
      ]
    );

    await this.replaceTags(input.nodeId, [
      ...(input.tags ?? []),
      { tagType: "status", tagValue: status, weight: 0.6 },
      { tagType: "source", tagValue: input.source, weight: 0.4 },
    ]);
    const row = await this.getNode(input.nodeId);
    if (!row) {
      throw new Error(`memory node insert failed: ${input.nodeId}`);
    }
    return row;
  }

  async getNode(nodeId: string): Promise<MemoryNodeRecord | null> {
    const row = await this.db.get("SELECT * FROM memory_nodes WHERE nodeId = ?", nodeId);
    return row ? mapNode(row) : null;
  }

  async getNodes(nodeIds: string[]): Promise<MemoryNodeRecord[]> {
    const uniqueNodeIds = Array.from(new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean)));
    if (uniqueNodeIds.length === 0) return [];
    const placeholders = uniqueNodeIds.map(() => "?").join(",");
    const rows = await this.db.all(
      `SELECT * FROM memory_nodes WHERE nodeId IN (${placeholders})`,
      uniqueNodeIds
    );
    return rows.map(mapNode);
  }

  async addRelation(input: MemoryRelationInput): Promise<MemoryRelationRecord> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO memory_relations (
         fromNodeId, toNodeId, relationType, confidence, evidenceMessageId,
         evidenceSummaryId, metadata, createdAt, updatedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fromNodeId, toNodeId, relationType) DO UPDATE SET
         confidence = excluded.confidence,
         evidenceMessageId = excluded.evidenceMessageId,
         evidenceSummaryId = excluded.evidenceSummaryId,
         metadata = excluded.metadata,
         updatedAt = excluded.updatedAt`,
      [
        input.fromNodeId,
        input.toNodeId,
        input.relationType,
        input.confidence ?? 1.0,
        input.evidenceMessageId ?? null,
        input.evidenceSummaryId ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      ]
    );

    const row = await this.db.get(
      `SELECT * FROM memory_relations
       WHERE fromNodeId = ? AND toNodeId = ? AND relationType = ?`,
      [input.fromNodeId, input.toNodeId, input.relationType]
    );
    return mapRelation(row);
  }

  async getRelationsForNode(
    nodeId: string,
    direction: "from" | "to" | "both" = "both"
  ): Promise<MemoryRelationRecord[]> {
    const rows =
      direction === "from"
        ? await this.db.all(
            `SELECT * FROM memory_relations
             WHERE fromNodeId = ?
             ORDER BY createdAt DESC, relationId DESC`,
            nodeId
          )
        : direction === "to"
          ? await this.db.all(
              `SELECT * FROM memory_relations
               WHERE toNodeId = ?
               ORDER BY createdAt DESC, relationId DESC`,
              nodeId
            )
          : await this.db.all(
              `SELECT * FROM memory_relations
               WHERE fromNodeId = ? OR toNodeId = ?
               ORDER BY createdAt DESC, relationId DESC`,
              [nodeId, nodeId]
    );
    return rows.map(mapRelation);
  }

  async getRelationsForNodes(
    nodeIds: string[],
    direction: "from" | "to" | "both" = "both"
  ): Promise<Map<string, MemoryRelationRecord[]>> {
    const uniqueNodeIds = Array.from(
      new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))
    );
    const groups = new Map<string, MemoryRelationRecord[]>(
      uniqueNodeIds.map((nodeId) => [nodeId, []] as const)
    );
    if (uniqueNodeIds.length === 0) return groups;

    const placeholders = uniqueNodeIds.map(() => "?").join(",");
    const rows =
      direction === "from"
        ? await this.db.all(
            `SELECT * FROM memory_relations
             WHERE fromNodeId IN (${placeholders})
             ORDER BY createdAt DESC, relationId DESC`,
            uniqueNodeIds
          )
        : direction === "to"
          ? await this.db.all(
              `SELECT * FROM memory_relations
               WHERE toNodeId IN (${placeholders})
               ORDER BY createdAt DESC, relationId DESC`,
              uniqueNodeIds
            )
          : await this.db.all(
              `SELECT * FROM memory_relations
               WHERE fromNodeId IN (${placeholders})
                  OR toNodeId IN (${placeholders})
               ORDER BY createdAt DESC, relationId DESC`,
              [...uniqueNodeIds, ...uniqueNodeIds]
            );

    for (const row of rows) {
      const relation = mapRelation(row);
      if (direction === "from") {
        const relations = groups.get(relation.fromNodeId);
        if (relations) relations.push(relation);
        continue;
      }
      if (direction === "to") {
        const relations = groups.get(relation.toNodeId);
        if (relations) relations.push(relation);
        continue;
      }

      const seenKeys = new Set<string>();
      if (groups.has(relation.fromNodeId)) {
        groups.get(relation.fromNodeId)?.push(relation);
        seenKeys.add(relation.fromNodeId);
      }
      if (groups.has(relation.toNodeId) && !seenKeys.has(relation.toNodeId)) {
        groups.get(relation.toNodeId)?.push(relation);
      }
    }

    return groups;
  }

  async addLifecycleEvent(
    input: MemoryLifecycleEventInput
  ): Promise<MemoryLifecycleEventRecord> {
    const result = await this.db.run(
      `INSERT INTO memory_lifecycle_events (
         nodeId, fromStatus, toStatus, eventType, confidence, reason,
         evidenceMessageId, evidenceSummaryId, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.nodeId,
        input.fromStatus ?? null,
        input.toStatus,
        input.eventType,
        input.confidence ?? 1.0,
        input.reason ?? null,
        input.evidenceMessageId ?? null,
        input.evidenceSummaryId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const row = await this.db.get(
      "SELECT * FROM memory_lifecycle_events WHERE eventId = ?",
      result.lastID
    );
    return mapLifecycleEvent(row);
  }

  async getLifecycleEvents(nodeId: string): Promise<MemoryLifecycleEventRecord[]> {
    const rows = await this.db.all(
      `SELECT * FROM memory_lifecycle_events
       WHERE nodeId = ?
       ORDER BY createdAt DESC, eventId DESC`,
      nodeId
    );
    return rows.map(mapLifecycleEvent);
  }

  async addPendingUpdate(
    input: MemoryPendingUpdateInput
  ): Promise<MemoryPendingUpdateRecord> {
    const candidates = input.targetCandidates ?? [];
    const result = await this.db.run(
      `INSERT INTO memory_pending_updates (
         transition, eventType, targetNodeId, targetCandidates, fromStatus,
         toStatus, confidence, reason, evidenceMessageId, evidenceSummaryId,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.transition,
        input.eventType,
        input.targetNodeId ?? null,
        JSON.stringify(candidates),
        input.fromStatus ?? null,
        input.toStatus,
        input.confidence,
        input.reason ?? null,
        input.evidenceMessageId ?? null,
        input.evidenceSummaryId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const row = await this.db.get(
      "SELECT * FROM memory_pending_updates WHERE pendingId = ?",
      result.lastID
    );
    return mapPendingUpdate(row);
  }

  async getPendingUpdates(
    status: "pending" | "applied" | "dismissed" = "pending"
  ): Promise<MemoryPendingUpdateRecord[]> {
    const rows = await this.db.all(
      `SELECT * FROM memory_pending_updates
       WHERE status = ?
       ORDER BY createdAt DESC, pendingId DESC`,
      status
    );
    return rows.map(mapPendingUpdate);
  }

  async getPendingUpdate(
    pendingId: number
  ): Promise<MemoryPendingUpdateRecord | null> {
    const row = await this.db.get(
      "SELECT * FROM memory_pending_updates WHERE pendingId = ?",
      pendingId
    );
    return row ? mapPendingUpdate(row) : null;
  }

  async applyPendingUpdate(
    input: ApplyMemoryPendingUpdateInput
  ): Promise<ApplyMemoryPendingUpdateResult> {
    const pending = await this.getPendingUpdate(input.pendingId);
    if (!pending) {
      return { ok: false, reason: `pending update ${input.pendingId} not found` };
    }
    if (pending.status !== "pending") {
      return {
        ok: false,
        pending,
        reason: `pending update ${pending.pendingId} is already ${pending.status}`,
      };
    }

    const target = choosePendingUpdateTarget(pending, input.targetNodeId);
    if (!target.nodeId) {
      return { ok: false, pending, reason: target.reason };
    }

    const node = await this.getNode(target.nodeId);
    if (!node) {
      return {
        ok: false,
        pending,
        reason: `target node ${target.nodeId} not found`,
      };
    }
    if (pending.fromStatus && node.status !== pending.fromStatus) {
      return {
        ok: false,
        pending,
        reason: `target node ${target.nodeId} is ${node.status}; expected ${pending.fromStatus}`,
      };
    }

    const reason =
      input.reason ??
      pending.reason ??
      `applied pending update ${pending.pendingId}`;
    const updated = await this.updateNodeStatus({
      nodeId: node.nodeId,
      toStatus: pending.toStatus,
      eventType: pending.eventType,
      confidence: pending.confidence,
      reason,
      evidenceMessageId: pending.evidenceMessageId,
      evidenceSummaryId: pending.evidenceSummaryId,
      metadata: {
        ...pending.metadata,
        ...(input.metadata ?? {}),
        pendingUpdateId: pending.pendingId,
        pendingTransition: pending.transition,
        pendingApplied: true,
      },
      lifecycle: {
        appliedPendingUpdateId: pending.pendingId,
        pendingTransition: pending.transition,
      },
    });
    if (!updated) {
      return {
        ok: false,
        pending,
        reason: `failed to update target node ${target.nodeId}`,
      };
    }

    const applied = await this.setPendingUpdateStatus(pending.pendingId, "applied", {
      appliedToNodeId: updated.nodeId,
      appliedReason: reason,
      appliedAt: new Date().toISOString(),
    });
    return { ok: true, pending: applied ?? pending, node: updated, reason };
  }

  async dismissPendingUpdate(
    input: DismissMemoryPendingUpdateInput
  ): Promise<DismissMemoryPendingUpdateResult> {
    const pending = await this.getPendingUpdate(input.pendingId);
    if (!pending) {
      return { ok: false, reason: `pending update ${input.pendingId} not found` };
    }
    if (pending.status !== "pending") {
      return {
        ok: false,
        pending,
        reason: `pending update ${pending.pendingId} is already ${pending.status}`,
      };
    }

    const dismissed = await this.setPendingUpdateStatus(
      pending.pendingId,
      "dismissed",
      {
        dismissedReason: input.reason ?? "dismissed",
        dismissedAt: new Date().toISOString(),
      }
    );
    return {
      ok: true,
      pending: dismissed ?? pending,
      reason: input.reason ?? "dismissed",
    };
  }

  async updateNodeStatus(
    input: UpdateMemoryNodeStatusInput
  ): Promise<MemoryNodeRecord | null> {
    const node = await this.getNode(input.nodeId);
    if (!node) return null;

    const now = new Date().toISOString();
    const lifecycle = isRecord(node.metadata.lifecycle)
      ? node.metadata.lifecycle
      : {};
    const metadata = {
      ...node.metadata,
      ...(input.metadata ?? {}),
      lifecycle: {
        ...lifecycle,
        ...(input.lifecycle ?? {}),
        lastEventType: input.eventType,
        lastStatusChangeAt: now,
        lastStatusChangeReason: input.reason,
      },
    };

    await this.db.run(
      `UPDATE memory_nodes
          SET status = ?, metadata = ?, updatedAt = ?
        WHERE nodeId = ?`,
      [input.toStatus, JSON.stringify(metadata), now, input.nodeId]
    );
    await this.replaceStatusTag(input.nodeId, input.toStatus);
    await this.addLifecycleEvent({
      nodeId: input.nodeId,
      fromStatus: node.status,
      toStatus: input.toStatus,
      eventType: input.eventType,
      confidence: input.confidence ?? 1.0,
      reason: input.reason,
      evidenceMessageId: input.evidenceMessageId,
      evidenceSummaryId: input.evidenceSummaryId,
      metadata: input.metadata,
    });

    return this.getNode(input.nodeId);
  }

  async findActiveFailuresByAnchors(input: {
    conversationId?: number;
    files?: string[];
    commands?: string[];
    symbols?: string[];
    limit?: number;
  }): Promise<FailureAnchorCandidate[]> {
    return this.findFailuresByAnchors({
      ...input,
      statuses: ["active"],
    });
  }

  async findFailuresByAnchors(input: {
    conversationId?: number;
    files?: string[];
    commands?: string[];
    symbols?: string[];
    signatures?: string[];
    statuses?: MemoryNodeStatus[];
    limit?: number;
  }): Promise<FailureAnchorCandidate[]> {
    const anchors: Array<{ tagType: string; tagValue: string; weight: number }> = [];
    for (const file of input.files ?? []) {
      anchors.push({ tagType: "file", tagValue: qualifyFileTag(file), weight: 2.3 });
    }
    for (const command of input.commands ?? []) {
      for (const tag of commandTags(command, 1.9)) {
        anchors.push({
          tagType: tag.tagType,
          tagValue: tag.tagValue,
          weight: tag.weight ?? 1.0,
        });
      }
    }
    for (const symbol of input.symbols ?? []) {
      anchors.push({ tagType: "symbol", tagValue: symbol, weight: 1.5 });
    }
    for (const signature of input.signatures ?? []) {
      anchors.push({ tagType: "signature", tagValue: signature, weight: 2.2 });
    }

    const statuses = uniqueStatuses(input.statuses ?? ["active"]);
    if (statuses.length === 0 || anchors.length === 0) return [];
    const candidates = new Map<string, FailureAnchorCandidate>();
    for (const anchor of anchors) {
      const normalized = normalizeTagValue(anchor.tagValue);
      if (!normalized) continue;
      const statusPlaceholders = statuses.map(() => "?").join(",");
      const rows = await this.db.all(
        `SELECT n.*, mt.tagType, mt.tagValue, mt.weight
           FROM memory_tags mt
           JOIN memory_nodes n ON n.nodeId = mt.nodeId
          WHERE n.kind = 'failure'
            AND n.status IN (${statusPlaceholders})
            AND mt.tagType = ?
            AND mt.tagValue = ?
          ORDER BY n.updatedAt DESC
          LIMIT ?`,
        [...statuses, anchor.tagType, normalized, input.limit ?? 12]
      );

      for (const row of rows) {
        const node = mapNode(row);
        const conversationBoost =
          input.conversationId && node.conversationId === input.conversationId ? 0.5 : 0;
        const score = anchor.weight * (row.weight ?? 1) + conversationBoost;
        const existing = candidates.get(node.nodeId);
        const matchedAnchor = `${anchor.tagType}:${normalized}`;
        if (existing) {
          existing.score += score;
          existing.matchedAnchors.push(matchedAnchor);
        } else {
          candidates.set(node.nodeId, {
            node,
            score,
            matchedAnchors: [matchedAnchor],
          });
        }
      }
    }

    return Array.from(candidates.values())
      .map((candidate) => ({
        ...candidate,
        score: Number(candidate.score.toFixed(3)),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.node.updatedAt.localeCompare(a.node.updatedAt);
      })
      .slice(0, input.limit ?? 12);
  }

  async runStaleMaintenance(
    input: StaleMaintenanceInput = {}
  ): Promise<StaleMaintenanceResult> {
    const now = input.now instanceof Date
      ? input.now
      : input.now
        ? new Date(input.now)
        : new Date();
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const maxUseCount = input.maxUseCount ?? 0;
    const rows = await this.db.all(
      `SELECT * FROM memory_nodes
       WHERE status IN ('active', 'resolved', 'superseded')
       ORDER BY updatedAt ASC
       LIMIT ?`,
      limit
    );
    const changed: MemoryNodeRecord[] = [];

    for (const row of rows) {
      const node = mapNode(row);
      const staleReason = staleReasonForNode(node, {
        now,
        maxUseCount,
        summaryOlderThanDays: input.summaryOlderThanDays ?? 45,
        resolvedFailureOlderThanDays: input.resolvedFailureOlderThanDays ?? 90,
        resolvedFixAttemptOlderThanDays: input.resolvedFixAttemptOlderThanDays ?? 90,
        supersededOlderThanDays: input.supersededOlderThanDays ?? 30,
      });
      if (!staleReason) continue;

      const updated = await this.updateNodeStatus({
        nodeId: node.nodeId,
        toStatus: "stale",
        eventType: node.kind === "summary" ? "stale_summary" : "stale_node",
        confidence: 0.85,
        reason: staleReason,
        metadata: {
          stale: true,
          staleReason,
          staleCheckedAt: now.toISOString(),
        },
        lifecycle: {
          staleCheckedAt: now.toISOString(),
        },
      });
      if (updated) changed.push(updated);
    }

    return {
      scanned: rows.length,
      staleNodeIds: changed.map((node) => node.nodeId),
      nodes: changed,
    };
  }

  async supersedeDecision(input: SupersedeDecisionInput): Promise<boolean> {
    return this.supersedeNode(input);
  }

  async supersedeNode(input: SupersedeMemoryNodeInput): Promise<boolean> {
    const [oldNode, newNode] = await Promise.all([
      this.getNode(input.oldNodeId),
      this.getNode(input.newNodeId),
    ]);
    if (!oldNode || !newNode) return false;
    if (oldNode.kind !== newNode.kind) return false;
    if (!isSupersedableKind(oldNode.kind)) return false;

    const now = new Date().toISOString();
    const newLifecycle = isRecord(newNode.metadata.lifecycle)
      ? newNode.metadata.lifecycle
      : {};
    const newMetadata = {
      ...newNode.metadata,
      lifecycle: {
        ...newLifecycle,
        supersedesNodeId: oldNode.nodeId,
        supersedesAt: now,
        supersedesReason: input.reason,
      },
    };

    await this.db.run(
      `UPDATE memory_nodes
          SET supersedesNodeId = ?, metadata = ?, updatedAt = ?
        WHERE nodeId = ?`,
      [oldNode.nodeId, JSON.stringify(newMetadata), now, newNode.nodeId]
    );

    await this.addRelation({
      fromNodeId: newNode.nodeId,
      toNodeId: oldNode.nodeId,
      relationType: "supersedes",
      confidence: input.confidence ?? 1.0,
      evidenceMessageId: input.evidenceMessageId,
      metadata: input.metadata,
    });

    await this.updateNodeStatus({
      nodeId: oldNode.nodeId,
      toStatus: "superseded",
      eventType: supersedeEventType(oldNode.kind),
      confidence: input.confidence ?? 1.0,
      reason: input.reason ?? `superseded by ${newNode.nodeId}`,
      evidenceMessageId: input.evidenceMessageId,
      metadata: {
        ...(input.metadata ?? {}),
        supersededBy: newNode.nodeId,
        supersededAt: now,
      },
      lifecycle: {
        supersededBy: newNode.nodeId,
        supersededAt: now,
      },
    });

    return true;
  }

  async getTags(nodeId: string): Promise<MemoryTagInput[]> {
    const rows = await this.db.all(
      `SELECT tagType, tagValue, weight FROM memory_tags
       WHERE nodeId = ?
       ORDER BY weight DESC, tagType, tagValue`,
      nodeId
    );
    return rows.map((row: any) => ({
      tagType: row.tagType,
      tagValue: row.tagValue,
      weight: row.weight,
    }));
  }

  async searchByPlan(
    plan: RetrievalPlan,
    input: {
      conversationId?: number;
      limit?: number;
      wantedKinds?: WantedMemoryKind[];
    } = {}
  ): Promise<MemorySearchCandidate[]> {
    const tagQueries = plan.tagQueries.slice(0, 16);
    const wantedKinds = normalizeWantedKinds(input.wantedKinds ?? plan.wantedKinds);
    const maxRowsPerTag = Math.max(8, Math.ceil((input.limit ?? 24) / 2));
    const candidates = new Map<string, MemorySearchCandidate>();

    for (const query of tagQueries) {
      const normalized = normalizeTagValue(query.tagValue);
      if (!normalized) continue;

      const params: any[] = [query.tagType, normalized];
      const kindClause =
        wantedKinds.length > 0
          ? `AND n.kind IN (${wantedKinds.map(() => "?").join(",")})`
          : "";
      params.push(...wantedKinds);
      params.push(maxRowsPerTag);

      const rows = await this.db.all(
        `SELECT n.*, mt.tagType as matchedTagType, mt.tagValue as matchedTagValue,
                mt.weight as matchedTagWeight
           FROM memory_tags mt
           JOIN memory_nodes n ON n.nodeId = mt.nodeId
          WHERE mt.tagType = ?
            AND mt.tagValue = ?
            AND n.status IN ('active', 'resolved')
            ${kindClause}
          ORDER BY mt.weight DESC, n.updatedAt DESC
          LIMIT ?`,
        params
      );

      for (const row of rows) {
        const tagScore = query.weight * (row.matchedTagWeight ?? 1);
        addCandidate(candidates, row, plan, input.conversationId, tagScore, {
            tagType: row.matchedTagType,
            tagValue: row.matchedTagValue,
            weight: row.matchedTagWeight ?? 1,
        });
      }
    }

    const contentQueries = buildContentQueries(plan).slice(0, 12);
    const maxRowsPerText = Math.max(6, Math.ceil((input.limit ?? 24) / 3));
    for (const query of contentQueries) {
      const normalized = normalizeTagValue(query.text);
      if (!normalized) continue;

      const params: any[] = [];
      const kindClause =
        wantedKinds.length > 0
          ? `AND n.kind IN (${wantedKinds.map(() => "?").join(",")})`
          : "";
      params.push(...wantedKinds);
      params.push(`%${escapeLikePattern(query.text)}%`);
      params.push(maxRowsPerText);

      const rows = await this.db.all(
        `SELECT n.*
           FROM memory_nodes n
          WHERE n.status IN ('active', 'resolved')
            ${kindClause}
            AND n.content LIKE ? ESCAPE '\\'
          ORDER BY n.updatedAt DESC
          LIMIT ?`,
        params
      );

      for (const row of rows) {
        addCandidate(candidates, row, plan, input.conversationId, query.weight, {
          tagType: "text",
          tagValue: query.text,
          weight: query.weight,
        });
      }
    }

    return Array.from(candidates.values())
      .map((candidate) => ({
        ...candidate,
        score: Number(candidate.score.toFixed(3)),
      }))
      .filter((candidate) => candidate.score >= plan.recallPolicy.minScore)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.node.updatedAt.localeCompare(a.node.updatedAt);
      })
      .slice(0, input.limit ?? plan.recallPolicy.maxCandidates);
  }

  async markUsed(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = nodeIds.map(() => "?").join(",");
    await this.db.run(
      `UPDATE memory_nodes
          SET lastUsedAt = ?, useCount = useCount + 1
        WHERE nodeId IN (${placeholders})`,
      [now, ...nodeIds]
    );
  }

  async createDecisionNode(input: {
    conversationId: number;
    sessionId?: string | null;
    /** Legacy anchor for tests that pre-date the Skill→daemon flow. */
    messageId?: number | null;
    /** Idempotency key from the model's tool_use, when available. */
    sourceToolUseId?: string | null;
    decision: string;
    rationale: string;
    alternativesRejected?: string[];
    content: string;
    supersedesNodeId?: string;
  }): Promise<MemoryNodeRecord> {
    const pivots = extractPromptPivots(input.content);
    const topics = inferTopics(input.content, pivots);
    const tags: MemoryTagInput[] = [
      { tagType: "kind", tagValue: "decision", weight: 2.0 },
      ...fileTags(pivots.filePaths, 1.8),
      ...symbolTags(pivots.symbols, 1.2),
      ...topics.map((topic) => ({ tagType: "topic", tagValue: topic, weight: 1.0 })),
    ];

    const nodeId = decisionNodeId(input.sourceToolUseId, input.messageId);
    const sourceId =
      input.sourceToolUseId ??
      (input.messageId != null ? String(input.messageId) : nodeId);
    const evidenceMessageId =
      typeof input.messageId === "number" ? input.messageId : null;

    const node = await this.upsertNode({
      nodeId,
      kind: "decision",
      status: "active",
      confidence: 1.0,
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      source: "codememory_mark_decision",
      sourceId,
      sourceToolUseId: input.sourceToolUseId ?? null,
      content: input.content,
      metadata: {
        messageId: input.messageId ?? null,
        sourceToolUseId: input.sourceToolUseId ?? null,
        decision: input.decision,
        rationale: input.rationale,
        alternativesRejected: input.alternativesRejected ?? [],
      },
      tags,
    });

    if (input.supersedesNodeId) {
      await this.supersedeDecision({
        oldNodeId: input.supersedesNodeId,
        newNodeId: node.nodeId,
        reason: "explicit decision supersede",
        evidenceMessageId,
      });
    } else if (this.options.autoSupersedeViaLlm && this.options.decisionJudge) {
      await this.runDecisionJudgeBackstop({
        newNode: node,
        evidenceMessageId,
      });
    }

    return (await this.getNode(node.nodeId)) ?? node;
  }

  private async runDecisionJudgeBackstop(input: {
    newNode: MemoryNodeRecord;
    evidenceMessageId: number | null;
  }): Promise<void> {
    const judge = this.options.decisionJudge;
    if (!judge) return;
    if (input.newNode.conversationId == null) return;
    const limit = clampJudgeCandidateLimit(
      this.options.autoSupersedeMaxCandidates
    );
    const candidates = (
      await this.listDecisionNodes({
        conversationId: input.newNode.conversationId,
        limit,
      })
    ).filter((c) => c.nodeId !== input.newNode.nodeId);
    if (candidates.length === 0) return;

    let outcomes;
    try {
      outcomes = await judge.judge({
        newDecision: {
          nodeId: input.newNode.nodeId,
          content: input.newNode.content,
        },
        candidates: candidates.map((c) => ({
          nodeId: c.nodeId,
          content: c.content,
        })),
      });
    } catch {
      return;
    }
    for (const outcome of outcomes) {
      if (outcome.verdict !== "SUPERSEDED_BY_NEW") continue;
      await this.supersedeDecision({
        oldNodeId: outcome.nodeId,
        newNodeId: input.newNode.nodeId,
        reason: outcome.reason
          ? `auto-supersede via LLM judge: ${outcome.reason}`
          : "auto-supersede via LLM judge",
        evidenceMessageId: input.evidenceMessageId,
      });
    }
  }

  async createFailureNode(input: CreateFailureNodeInput): Promise<MemoryNodeRecord> {
    const content = renderFailureContent(input);
    const tags: MemoryTagInput[] = [
      { tagType: "kind", tagValue: "failure", weight: 2.1 },
      { tagType: "signature", tagValue: input.signature, weight: 1.8 },
      { tagType: "topic", tagValue: input.type, weight: 1.0 },
      ...(input.filePath ? fileTags([input.filePath], 2.3) : []),
      ...(input.command ? commandTags(input.command, 1.9) : []),
      ...(input.symbol && isUsefulSymbol(input.symbol)
        ? [{ tagType: "symbol", tagValue: input.symbol, weight: 1.5 }]
        : []),
    ];

    const nodeId =
      input.nodeIdOverride ?? `failure-${input.conversationId}-${input.seq}`;

    return this.upsertNode({
      nodeId,
      kind: "failure",
      status: "active",
      confidence: input.weight ?? 1.0,
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      source: "failure_extractor",
      sourceId: nodeId,
      content,
      metadata: {
        seq: input.seq,
        type: input.type,
        signature: input.signature,
        filePath: input.filePath,
        command: input.command,
        symbol: input.symbol,
        messageId: input.messageId,
        attemptedFix: input.attemptedFix,
        location: input.location,
        weight: input.weight ?? 1.0,
      },
      tags,
    });
  }

  async resolveFailureNodesByTarget(
    input: ResolveFailureNodesByTargetInput
  ): Promise<number> {
    const target = input.target;
    if (!target.filePath && !target.command) return 0;

    const candidates = await this.findFailuresByAnchors({
      conversationId: input.conversationId,
      files: target.filePath ? [target.filePath] : [],
      commands: target.command ? [target.command] : [],
      statuses: ["active"],
      limit: 50,
    });

    let resolved = 0;
    for (const candidate of candidates) {
      if (candidate.node.status !== "active") continue;
      const updated = await this.updateNodeStatus({
        nodeId: candidate.node.nodeId,
        toStatus: "resolved",
        eventType: "resolve_failure",
        confidence: 0.9,
        reason: input.resolution,
        evidenceMessageId: input.evidenceMessageId,
        metadata: {
          resolved: true,
          resolution: input.resolution,
          resolvedAt: Date.now(),
        },
        lifecycle: {
          resolvedBy: "user_signal",
        },
      });
      if (updated) resolved += 1;
    }
    return resolved;
  }

  async autoResolveStaleFailureNodes(
    input: AutoResolveStaleFailureNodesInput
  ): Promise<number> {
    const cutoff = input.currentSeq - input.olderThanSeqs;
    if (cutoff <= 0) return 0;

    const rows = await this.db.all(
      `SELECT n.nodeId, n.metadata
         FROM memory_nodes n
        WHERE n.conversationId = ?
          AND n.kind = 'failure'
          AND n.status = 'active'
          AND CAST(json_extract(n.metadata, '$.seq') AS INTEGER) < ?
          AND NOT EXISTS (
            SELECT 1 FROM memory_nodes later
             WHERE later.conversationId = n.conversationId
               AND later.kind = 'failure'
               AND json_extract(later.metadata, '$.signature') = json_extract(n.metadata, '$.signature')
               AND CAST(json_extract(later.metadata, '$.seq') AS INTEGER) > CAST(json_extract(n.metadata, '$.seq') AS INTEGER)
          )`,
      [input.conversationId, cutoff]
    );

    let resolved = 0;
    for (const row of rows) {
      const updated = await this.updateNodeStatus({
        nodeId: row.nodeId,
        toStatus: "resolved",
        eventType: "resolve_failure",
        confidence: 0.85,
        reason: input.resolution,
        metadata: {
          resolved: true,
          resolution: input.resolution,
          resolvedAt: Date.now(),
        },
        lifecycle: {
          resolvedBy: "auto_stale",
        },
      });
      if (updated) resolved += 1;
    }
    return resolved;
  }

  async findRecentFailureBySignature(
    conversationId: number,
    signature: string,
    sinceSeq: number = 0
  ): Promise<MemoryNodeRecord | null> {
    const row = await this.db.get(
      `SELECT * FROM memory_nodes
        WHERE kind = 'failure'
          AND conversationId = ?
          AND json_extract(metadata, '$.signature') = ?
          AND CAST(json_extract(metadata, '$.seq') AS INTEGER) >= ?
        ORDER BY CAST(json_extract(metadata, '$.seq') AS INTEGER) DESC
        LIMIT 1`,
      [conversationId, signature, sinceSeq]
    );
    return row ? mapNode(row) : null;
  }

  async createFixAttemptNode(
    input: CreateFixAttemptNodeInput
  ): Promise<MemoryNodeRecord> {
    const status =
      input.status ?? (input.outcome === "succeeded" ? "resolved" : "active");
    const touchedFiles = uniqueStrings(input.touchedFiles ?? []);
    const commandsRun = uniqueStrings(input.commandsRun ?? []).filter(
      (cmd) => !isExploratoryCommand(cmd)
    );
    const relatedFailureNodeIds = uniqueStrings(input.relatedFailureNodeIds ?? []);
    const content =
      input.content ??
      renderFixAttemptContent({
        attemptId: input.attemptId,
        outcome: input.outcome,
        touchedFiles,
        commandsRun,
      });
    const tags: MemoryTagInput[] =
      input.outcome === "unknown"
        ? [{ tagType: "kind", tagValue: "fix_attempt", weight: 1.9 }]
        : [
            { tagType: "kind", tagValue: "fix_attempt", weight: 1.9 },
            { tagType: "outcome", tagValue: input.outcome, weight: 1.2 },
            ...fileTags(touchedFiles, 1.7),
            ...commandsRun.flatMap((command) => commandTags(command, 1.4)),
            ...inferTopics(content, extractPromptPivots(content)).map((topic) => ({
              tagType: "topic",
              tagValue: topic,
              weight: 0.8,
            })),
          ];

    const node = await this.upsertNode({
      nodeId: `fix-attempt-${input.attemptId}`,
      kind: "fix_attempt",
      status,
      confidence: input.outcome === "unknown" ? 0.75 : 0.9,
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      source: "fix_attempt_tracker",
      sourceId: input.attemptId,
      content,
      metadata: {
        ...(input.metadata ?? {}),
        attemptId: input.attemptId,
        outcome: input.outcome,
        touchedFiles,
        commandsRun,
        relatedFailureNodeIds,
        startedAtSeq: input.startedAtSeq,
        endedAtSeq: input.endedAtSeq ?? null,
      },
      tags,
    });

    for (const failureNodeId of relatedFailureNodeIds) {
      await this.addRelation({
        fromNodeId: node.nodeId,
        toNodeId: failureNodeId,
        relationType: "attemptedFixFor",
        confidence: 0.9,
        evidenceMessageId: input.evidenceMessageId,
        metadata: { attemptId: input.attemptId, outcome: input.outcome },
      });
    }

    return node;
  }

  async createTaskNode(input: CreateTaskNodeInput): Promise<MemoryNodeRecord> {
    return this.createRequirementLikeNode({
      nodeId: requirementNodeId("task", input.sourceToolUseId, input.messageId),
      kind: "task",
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
      sourceToolUseId: input.sourceToolUseId ?? null,
      primaryText: input.task,
      details: input.details,
      acceptanceCriteria: input.acceptanceCriteria,
      content: input.content,
      metadata: {
        ...(input.metadata ?? {}),
        task: input.task,
      },
      supersedesNodeId: input.supersedesNodeId,
    });
  }

  async createConstraintNode(
    input: CreateConstraintNodeInput
  ): Promise<MemoryNodeRecord> {
    return this.createRequirementLikeNode({
      nodeId: requirementNodeId(
        "constraint",
        input.sourceToolUseId,
        input.messageId
      ),
      kind: "constraint",
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
      sourceToolUseId: input.sourceToolUseId ?? null,
      primaryText: input.constraint,
      details: input.details,
      acceptanceCriteria: input.acceptanceCriteria,
      content: input.content,
      metadata: {
        ...(input.metadata ?? {}),
        constraint: input.constraint,
      },
      supersedesNodeId: input.supersedesNodeId,
    });
  }

  async createSummaryNode(summary: SummaryRecord): Promise<MemoryNodeRecord> {
    const pivots = extractPromptPivots(summary.content);
    const topics = inferTopics(summary.content, pivots);
    const tags: MemoryTagInput[] = [
      { tagType: "kind", tagValue: "summary_anchor", weight: 1.8 },
      { tagType: "kind", tagValue: "summary", weight: 0.8 },
      { tagType: "summary_kind", tagValue: summary.kind, weight: 1.0 },
      ...fileTags(pivots.filePaths, 1.4),
      ...topics.map((topic) => ({ tagType: "topic", tagValue: topic, weight: 0.8 })),
    ];

    const node = await this.upsertNode({
      nodeId: `summary-${summary.summaryId}`,
      kind: "summary",
      status: "active",
      confidence: 0.85,
      conversationId: summary.conversationId,
      source: "summary_dag",
      sourceId: summary.summaryId,
      summaryId: summary.summaryId,
      content: summary.content,
      metadata: {
        anchorType: "summary_anchor",
        summaryId: summary.summaryId,
        summaryKind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
      },
      tags,
    });
    await this.addRelation({
      fromNodeId: node.nodeId,
      toNodeId: summary.summaryId,
      relationType: "derivedFromSummary",
      confidence: 1.0,
      evidenceSummaryId: summary.summaryId,
      metadata: {
        summaryKind: summary.kind,
        depth: summary.depth,
      },
    });
    return node;
  }

  private async listDecisionNodes(input: {
    conversationId?: number;
    limit: number;
  }): Promise<MemoryNodeRecord[]> {
    const params: any[] = [];
    const conversationClause =
      typeof input.conversationId === "number" ? "AND conversationId = ?" : "";
    if (typeof input.conversationId === "number") params.push(input.conversationId);
    params.push(input.limit);
    const rows = await this.db.all(
      `SELECT * FROM memory_nodes
       WHERE kind = 'decision'
         AND status = 'active'
         ${conversationClause}
       ORDER BY updatedAt DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapNode);
  }

  private async createRequirementLikeNode(input: {
    nodeId: string;
    kind: "task" | "constraint";
    conversationId: number;
    sessionId: string | null;
    messageId: number | null;
    sourceToolUseId: string | null;
    primaryText: string;
    details?: string;
    acceptanceCriteria?: string[];
    content?: string;
    metadata?: Record<string, unknown>;
    supersedesNodeId?: string;
  }): Promise<MemoryNodeRecord> {
    const acceptanceCriteria = uniqueStrings(input.acceptanceCriteria ?? []);
    const content =
      input.content ??
      renderRequirementContent({
        kind: input.kind,
        primaryText: input.primaryText,
        details: input.details,
        acceptanceCriteria,
      });
    const pivots = extractPromptPivots(content);
    const topics = inferTopics(content, pivots);
    const tags: MemoryTagInput[] = [
      { tagType: "kind", tagValue: input.kind, weight: 2.1 },
      ...fileTags(pivots.filePaths, 1.9),
      ...symbolTags(pivots.symbols, 1.3),
      ...topics.map((topic) => ({ tagType: "topic", tagValue: topic, weight: 0.95 })),
    ];

    const sourceId =
      input.sourceToolUseId ??
      (input.messageId != null ? String(input.messageId) : input.nodeId);
    const evidenceMessageId =
      typeof input.messageId === "number" ? input.messageId : null;

    const node = await this.upsertNode({
      nodeId: input.nodeId,
      kind: input.kind,
      status: "active",
      confidence: 1.0,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      source: "codememory_mark_requirement",
      sourceId,
      sourceToolUseId: input.sourceToolUseId,
      content,
      metadata: {
        messageId: input.messageId ?? null,
        sourceToolUseId: input.sourceToolUseId ?? null,
        details: input.details ?? null,
        acceptanceCriteria,
        ...(input.metadata ?? {}),
      },
      tags,
    });

    if (input.supersedesNodeId) {
      await this.supersedeNode({
        oldNodeId: input.supersedesNodeId,
        newNodeId: node.nodeId,
        reason: `explicit ${input.kind} supersede`,
        evidenceMessageId,
      });
      return (await this.getNode(node.nodeId)) ?? node;
    }

    return node;
  }

  private async replaceTags(nodeId: string, tags: MemoryTagInput[]): Promise<void> {
    const uniqueTags = mergeTags(tags);
    for (const tag of uniqueTags) {
      const normalized = normalizeTagValue(tag.tagValue);
      if (!tag.tagType || !normalized) continue;
      await this.db.run(
        `INSERT INTO memory_tags (nodeId, tagType, tagValue, weight)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(nodeId, tagType, tagValue) DO UPDATE SET
           weight = MAX(memory_tags.weight, excluded.weight)`,
        [nodeId, tag.tagType, normalized, tag.weight ?? 1.0]
      );
    }
  }

  private async replaceStatusTag(
    nodeId: string,
    status: MemoryNodeStatus
  ): Promise<void> {
    await this.db.run(
      "DELETE FROM memory_tags WHERE nodeId = ? AND tagType = 'status'",
      nodeId
    );
    await this.db.run(
      `INSERT OR REPLACE INTO memory_tags (nodeId, tagType, tagValue, weight)
       VALUES (?, 'status', ?, 0.6)`,
      [nodeId, status]
    );
  }

  private async setPendingUpdateStatus(
    pendingId: number,
    status: MemoryPendingUpdateRecord["status"],
    metadataPatch: Record<string, unknown>
  ): Promise<MemoryPendingUpdateRecord | null> {
    const pending = await this.getPendingUpdate(pendingId);
    if (!pending) return null;
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE memory_pending_updates
          SET status = ?, metadata = ?, updatedAt = ?
        WHERE pendingId = ?`,
      [
        status,
        JSON.stringify({ ...pending.metadata, ...metadataPatch }),
        now,
        pendingId,
      ]
    );
    return this.getPendingUpdate(pendingId);
  }
}

export function createMemoryNodeStore(
  db: any,
  options: MemoryNodeStoreOptions = {}
): MemoryNodeStore {
  return new MemoryNodeStore(db, options);
}

function clampJudgeCandidateLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 20;
  }
  return Math.min(50, Math.trunc(value));
}

function decisionNodeId(
  sourceToolUseId: string | null | undefined,
  messageId: number | null | undefined
): string {
  if (sourceToolUseId) return `decision-tool-${sourceToolUseId}`;
  if (typeof messageId === "number") return `decision-message-${messageId}`;
  return `decision-${randomNodeSuffix()}`;
}

function requirementNodeId(
  kind: "task" | "constraint",
  sourceToolUseId: string | null | undefined,
  messageId: number | null | undefined
): string {
  if (sourceToolUseId) return `${kind}-tool-${sourceToolUseId}`;
  if (typeof messageId === "number") return `${kind}-message-${messageId}`;
  return `${kind}-${randomNodeSuffix()}`;
}

function randomNodeSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function renderFailureContent(input: {
  type: string;
  signature: string;
  filePath?: string;
  command?: string;
  symbol?: string;
  attemptedFix?: string;
  raw: string;
}): string {
  const lines: string[] = [];
  lines.push(`[FAILURE] ${input.type}: ${input.signature}`);
  if (input.filePath) lines.push(`File: ${input.filePath}`);
  if (input.command) lines.push(`Command: ${input.command}`);
  if (input.symbol) lines.push(`Symbol: ${input.symbol}`);
  if (input.attemptedFix) lines.push(`Attempted fix: ${input.attemptedFix}`);
  lines.push(input.raw);
  return lines.join("\n");
}

function renderFixAttemptContent(input: {
  attemptId: string;
  outcome: string;
  touchedFiles: string[];
  commandsRun: string[];
}): string {
  const lines: string[] = [];
  lines.push(`[FIX_ATTEMPT] ${input.attemptId}`);
  lines.push(`Outcome: ${input.outcome}`);
  if (input.touchedFiles.length > 0) {
    lines.push(`Files: ${input.touchedFiles.join(", ")}`);
  }
  if (input.commandsRun.length > 0) {
    lines.push(`Commands: ${input.commandsRun.join(" | ")}`);
  }
  return lines.join("\n");
}

function renderRequirementContent(input: {
  kind: "task" | "constraint";
  primaryText: string;
  details?: string;
  acceptanceCriteria: string[];
}): string {
  const header = input.kind === "task" ? "[TASK]" : "[CONSTRAINT]";
  const lines: string[] = [`${header} ${input.primaryText.trim()}`];
  if (input.details?.trim()) {
    lines.push(`Details: ${input.details.trim()}`);
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const item of input.acceptanceCriteria) {
      lines.push(`  - ${item}`);
    }
  }
  return lines.join("\n");
}

function fileTags(paths: string[], weight: number): MemoryTagInput[] {
  const out: MemoryTagInput[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const qualified = qualifyFileTag(p);
    if (!qualified || seen.has(qualified)) continue;
    seen.add(qualified);
    out.push({ tagType: "file", tagValue: qualified, weight });
  }
  return out;
}

const EXPLORATORY_COMMAND_HEAD = /^(ls|cd|pwd|cat|head|tail|echo|printf|which|find|grep|rg|tree|file|stat|env|whoami|date|history|clear|wc|sort|uniq|du|df|man|type)\b/i;
const GIT_READONLY_COMMAND = /^git\s+(status|log|diff|show|blame|branch|remote|rev-parse|config\s+--get)/i;

function isExploratoryCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (EXPLORATORY_COMMAND_HEAD.test(trimmed)) return true;
  if (GIT_READONLY_COMMAND.test(trimmed)) return true;
  return false;
}

function commandTags(command: string, weight: number): MemoryTagInput[] {
  if (isExploratoryCommand(command)) return [];
  const variants = commandVariants(command);
  const prefix = variants.length > 1 ? variants[1] : variants[0];
  if (!prefix) return [];
  return [{ tagType: "command", tagValue: prefix, weight }];
}

const SYMBOL_BLACKLIST = new Set([
  "error",
  "errors",
  "exception",
  "typeerror",
  "rangeerror",
  "syntaxerror",
  "referenceerror",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "map",
  "set",
  "promise",
  "function",
  "result",
  "data",
  "value",
  "handler",
  "callback",
  "options",
  "config",
  "context",
  "input",
  "output",
  "response",
  "request",
  "item",
  "items",
  "node",
  "foo",
  "bar",
  "baz",
  "test",
  "tests",
  "spec",
  "mock",
]);

function isUsefulSymbol(symbol: string): boolean {
  const trimmed = symbol.trim();
  if (trimmed.length < 3) return false;
  if (SYMBOL_BLACKLIST.has(trimmed.toLowerCase())) return false;
  return true;
}

function symbolTags(symbols: string[], weight: number): MemoryTagInput[] {
  return symbols
    .filter(isUsefulSymbol)
    .map((symbol) => ({ tagType: "symbol", tagValue: symbol, weight }));
}

function mergeTags(tags: MemoryTagInput[]): MemoryTagInput[] {
  const merged = new Map<string, MemoryTagInput>();
  for (const tag of tags) {
    if (!tag.tagType) continue;
    const rawValue =
      tag.tagType === "file" ? qualifyFileTag(tag.tagValue) : tag.tagValue;
    const normalized = normalizeTagValue(rawValue);
    if (!normalized) continue;
    const key = `${tag.tagType}:${normalized}`;
    const existing = merged.get(key);
    if (!existing || (tag.weight ?? 1) > (existing.weight ?? 1)) {
      merged.set(key, { tagType: tag.tagType, tagValue: normalized, weight: tag.weight ?? 1 });
    }
  }
  return Array.from(merged.values());
}

function normalizeMemoryNodeInput(input: UpsertMemoryNodeInput): {
  content: string;
  truncated: boolean;
} {
  const content = (input.content || "").trim();
  if (!content) {
    throw new Error(`memory node ${input.nodeId} content is required`);
  }
  if (!input.sourceId && !input.summaryId) {
    throw new Error(`memory node ${input.nodeId} requires sourceId or summaryId evidence`);
  }
  if (content.length <= MAX_MEMORY_NODE_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, MAX_MEMORY_NODE_CONTENT_CHARS).trim()}\n...[memory node content truncated]`,
    truncated: true,
  };
}

function addCandidate(
  candidates: Map<string, MemorySearchCandidate>,
  row: any,
  plan: RetrievalPlan,
  conversationId: number | undefined,
  baseScore: number,
  match: { tagType: string; tagValue: string; weight: number }
): void {
  const existing = candidates.get(row.nodeId);
  const node = existing?.node ?? mapNode(row);
  const statusFactor = node.status === "resolved" ? 0.75 : 1.0;
  const confidence = node.confidence || 1.0;
  const currentConversationBonus =
    conversationId && node.conversationId === conversationId ? 0.35 : 0;
  const kindBonus = kindPriority(node.kind, plan.intent);
  const score = baseScore * statusFactor * confidence + currentConversationBonus + kindBonus;

  if (existing) {
    existing.score += score;
    existing.matchedTags.push(match);
    return;
  }

  candidates.set(row.nodeId, {
    node,
    score,
    matchedTags: [match],
  });
}

function buildContentQueries(plan: RetrievalPlan): Array<{ text: string; weight: number }> {
  const queries: Array<{ text: string; weight: number }> = [];
  for (const file of plan.entities.files) queries.push({ text: file, weight: 2.0 });
  for (const command of plan.entities.commands) queries.push({ text: command, weight: 1.6 });
  for (const symbol of plan.entities.symbols) queries.push({ text: symbol, weight: 1.5 });
  for (const topic of plan.entities.topics) queries.push({ text: topic, weight: 0.9 });
  for (const variant of plan.queryVariants) queries.push({ text: variant, weight: 0.85 });

  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = normalizeTagValue(query.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeWantedKinds(kinds: WantedMemoryKind[]): string[] {
  return Array.from(
    new Set(
      kinds.map((kind) => (kind === "summary_anchor" ? "summary" : kind))
    )
  );
}

function uniqueStatuses(statuses: MemoryNodeStatus[]): MemoryNodeStatus[] {
  return Array.from(new Set(statuses));
}

function isSupersedableKind(
  kind: MemoryNodeKind
): kind is "decision" | "task" | "constraint" {
  return kind === "decision" || kind === "task" || kind === "constraint";
}

function supersedeEventType(
  kind: "decision" | "task" | "constraint"
): "supersede_decision" | "supersede_task" | "supersede_constraint" {
  switch (kind) {
    case "task":
      return "supersede_task";
    case "constraint":
      return "supersede_constraint";
    default:
      return "supersede_decision";
  }
}

function staleReasonForNode(
  node: MemoryNodeRecord,
  policy: {
    now: Date;
    maxUseCount: number;
    summaryOlderThanDays: number;
    resolvedFailureOlderThanDays: number;
    resolvedFixAttemptOlderThanDays: number;
    supersededOlderThanDays: number;
  }
): string | null {
  if (node.status === "stale") return null;
  if (node.kind === "decision" && node.status === "active") return null;

  const updatedAgeDays = ageDays(node.updatedAt, policy.now);
  const lastUsedAgeDays = node.lastUsedAt ? ageDays(node.lastUsedAt, policy.now) : Infinity;
  const lowUse = node.useCount <= policy.maxUseCount ||
    lastUsedAgeDays >= updatedAgeDays;

  if (node.status === "superseded" && updatedAgeDays >= policy.supersededOlderThanDays && lowUse) {
    return `superseded for ${Math.floor(updatedAgeDays)} days with low reuse`;
  }
  if (node.kind === "summary" && node.status === "active" && updatedAgeDays >= policy.summaryOlderThanDays && lowUse) {
    return `summary anchor unused for ${Math.floor(updatedAgeDays)} days`;
  }
  if (node.kind === "failure" && node.status === "resolved" && updatedAgeDays >= policy.resolvedFailureOlderThanDays && lowUse) {
    return `resolved failure inactive for ${Math.floor(updatedAgeDays)} days`;
  }
  if (node.kind === "fix_attempt" && node.status === "resolved" && updatedAgeDays >= policy.resolvedFixAttemptOlderThanDays && lowUse) {
    return `resolved fix attempt inactive for ${Math.floor(updatedAgeDays)} days`;
  }
  return null;
}

function ageDays(raw: string, now: Date): number {
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (now.getTime() - time) / (24 * 60 * 60 * 1000));
}

function choosePendingUpdateTarget(
  pending: MemoryPendingUpdateRecord,
  overrideNodeId?: string
): { nodeId?: string; reason?: string } {
  const explicit = overrideNodeId?.trim();
  if (explicit) return { nodeId: explicit };
  if (pending.targetNodeId) return { nodeId: pending.targetNodeId };
  if (pending.targetCandidates.length === 1) {
    return { nodeId: pending.targetCandidates[0].nodeId };
  }
  if (pending.targetCandidates.length === 0) {
    return { reason: "pending update has no target node or candidates" };
  }
  return {
    reason:
      "pending update has multiple target candidates; provide targetNodeId to apply",
  };
}

function mapPendingUpdate(row: any): MemoryPendingUpdateRecord {
  return {
    pendingId: row.pendingId,
    transition: row.transition,
    eventType: row.eventType,
    targetNodeId: row.targetNodeId ?? null,
    targetCandidates: parseJsonArray(row.targetCandidates),
    fromStatus: row.fromStatus ?? null,
    toStatus: row.toStatus,
    confidence: row.confidence,
    reason: row.reason ?? null,
    evidenceMessageId: row.evidenceMessageId ?? null,
    evidenceSummaryId: row.evidenceSummaryId ?? null,
    metadata: parseMetadata(row.metadata),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapNode(row: any): MemoryNodeRecord {
  return {
    nodeId: row.nodeId,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence,
    conversationId: row.conversationId ?? null,
    sessionId: row.sessionId ?? null,
    source: row.source,
    sourceId: row.sourceId ?? null,
    sourceToolUseId: row.sourceToolUseId ?? null,
    summaryId: row.summaryId ?? null,
    content: row.content,
    metadata: parseMetadata(row.metadata),
    supersedesNodeId: row.supersedesNodeId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
    useCount: row.useCount ?? 0,
  };
}

function mapRelation(row: any): MemoryRelationRecord {
  return {
    relationId: row.relationId,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    relationType: row.relationType,
    confidence: row.confidence,
    evidenceMessageId: row.evidenceMessageId ?? null,
    evidenceSummaryId: row.evidenceSummaryId ?? null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapLifecycleEvent(row: any): MemoryLifecycleEventRecord {
  return {
    eventId: row.eventId,
    nodeId: row.nodeId,
    fromStatus: row.fromStatus ?? null,
    toStatus: row.toStatus,
    eventType: row.eventType,
    confidence: row.confidence,
    reason: row.reason ?? null,
    evidenceMessageId: row.evidenceMessageId ?? null,
    evidenceSummaryId: row.evidenceSummaryId ?? null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function kindPriority(kind: MemoryNodeKind, intent: RetrievalPlan["intent"]): number {
  if (intent === "modify_and_avoid_prior_failure") {
    if (kind === "task") return 0.55;
    if (kind === "constraint") return 0.5;
    if (kind === "failure") return 0.45;
    if (kind === "decision") return 0.2;
  }
  if (intent === "recall_decision_rationale") {
    if (kind === "constraint") return 0.2;
    if (kind === "task") return 0.16;
    if (kind === "decision") return 0.45;
  }
  if (intent === "debug_prior_failure") {
    if (kind === "failure") return 0.45;
    if (kind === "constraint") return 0.18;
    if (kind === "task") return 0.16;
  }
  if (intent === "general_context_lookup") {
    if (kind === "task") return 0.28;
    if (kind === "constraint") return 0.24;
  }
  if (kind === "summary") return 0.05;
  return 0.1;
}
