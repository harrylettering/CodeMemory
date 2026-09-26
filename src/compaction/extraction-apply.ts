/**
 * Writing what a compaction call extracted.
 *
 * Mem0's four operations land on this store's existing lifecycle rather than
 * on deletes: a retired memory keeps its row and gains a lifecycle event, so a
 * wrong retirement is visible and reversible. That is the only reason it is
 * safe to let a model trigger one.
 *
 *   ADD         → a new node
 *   UPDATE      → a new node that supersedes the target; the old statement
 *                 stays readable instead of being overwritten
 *   INVALIDATE  → the target is retired. Decisions become `superseded`;
 *                 tasks and constraints become `stale`, because a window can
 *                 only show that nobody referred to it again, never that it
 *                 succeeded
 *   NOOP        → filtered out before this point
 */
import type { MemoryNodeStore } from "../store/memory-store.js";
import type { ExtractedMemory } from "./extracted-memories.js";

export interface ApplyExtractionInput {
  conversationId: number;
  sessionId?: string | null;
  /** The summary this batch produced, recorded so a claim can be traced back. */
  summaryId: string;
  memories: ExtractedMemory[];
}

export interface ApplyExtractionResult {
  counts: {
    added: number;
    updated: number;
    invalidated: number;
    revisedInBatch: number;
    /** Operations dropped at the write layer, e.g. a target in another conversation. */
    skipped: number;
  };
  createdNodeIds: string[];
}

/** How a kind leaves the active set when something replaces it. */
function retiredStatus(kind: string): "superseded" | "stale" {
  return kind === "decision" ? "superseded" : "stale";
}

function normalize(text: string): string {
  return text.replace(/^\[[A-Z_ ]+\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function applyExtractedMemories(
  store: MemoryNodeStore,
  input: ApplyExtractionInput
): Promise<ApplyExtractionResult> {
  const counts = { added: 0, updated: 0, invalidated: 0, revisedInBatch: 0, skipped: 0 };
  const createdNodeIds: string[] = [];
  // What this batch has created so far, so a `revises` naming one of them can
  // be resolved: the candidate list was built before any of these existed.
  const createdInBatch: Array<{ nodeId: string; kind: string; text: string }> = [];

  const retire = async (
    nodeId: string,
    kind: string,
    reason: string,
    eventType: string
  ): Promise<boolean> => {
    const node = await store.getNode(nodeId);
    // The candidate list is already scoped to this conversation. Checking again
    // here keeps a future caller from turning this into a cross-session write.
    if (!node || node.conversationId !== input.conversationId) return false;
    const updated = await store.updateNodeStatus({
      nodeId,
      toStatus: retiredStatus(node.kind),
      eventType,
      reason,
      evidenceSummaryId: input.summaryId,
    });
    return updated !== null;
  };

  const create = async (memory: ExtractedMemory, supersedesNodeId?: string) => {
    const text = memory.text ?? "";
    const metadata = {
      extractedFromSummaryId: input.summaryId,
      extractionReason: memory.reason,
    };
    const common = {
      conversationId: input.conversationId,
      sessionId: input.sessionId ?? null,
      content: text,
      metadata,
      supersedesNodeId,
    };
    if (memory.kind === "decision") {
      return store.createDecisionNode({
        ...common,
        decision: text,
        rationale: memory.reason ?? "",
      } as any);
    }
    if (memory.kind === "task") {
      return store.createTaskNode({ ...common, task: text } as any);
    }
    return store.createConstraintNode({ ...common, constraint: text } as any);
  };

  for (const memory of input.memories) {
    if (memory.op === "INVALIDATE") {
      const ok = memory.targetNodeId
        ? await retire(
            memory.targetNodeId,
            memory.kind,
            memory.reason ?? "superseded by a later window",
            "extraction_invalidate"
          )
        : false;
      if (ok) counts.invalidated++;
      else counts.skipped++;
      continue;
    }

    // ADD and UPDATE both write a node; UPDATE also names what it replaces.
    let supersedes: string | undefined;
    if (memory.op === "UPDATE" && memory.targetNodeId) {
      const node = await store.getNode(memory.targetNodeId);
      if (!node || node.conversationId !== input.conversationId) {
        counts.skipped++;
        continue;
      }
      supersedes = memory.targetNodeId;
    }

    // A `revises` in words can only be resolved against this batch's own
    // output; anything older was already offered by id in the candidate list.
    let revisedTarget: string | undefined;
    if (!supersedes && memory.revises) {
      const wanted = normalize(memory.revises);
      const match = createdInBatch.find(
        (c) =>
          c.kind === memory.kind &&
          (normalize(c.text) === wanted ||
            normalize(c.text).includes(wanted) ||
            wanted.includes(normalize(c.text)))
      );
      if (match) revisedTarget = match.nodeId;
    }

    let node;
    try {
      node = await create(memory, supersedes ?? revisedTarget);
    } catch {
      counts.skipped++;
      continue;
    }
    createdNodeIds.push(node.nodeId);
    createdInBatch.push({ nodeId: node.nodeId, kind: memory.kind, text: memory.text ?? "" });

    if (supersedes) {
      await retire(
        supersedes,
        memory.kind,
        memory.reason ?? "replaced by a later statement in the same session",
        "extraction_update"
      );
      counts.updated++;
    } else if (revisedTarget) {
      await retire(
        revisedTarget,
        memory.kind,
        "revised later in the same window",
        "extraction_revise"
      );
      counts.revisedInBatch++;
      counts.added++;
    } else {
      counts.added++;
    }
  }

  return { counts, createdNodeIds };
}
