/** How a kind leaves the active set when something replaces it. */
function retiredStatus(kind) {
    return kind === "decision" ? "superseded" : "stale";
}
function normalize(text) {
    return text.replace(/^\[[A-Z_ ]+\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export async function applyExtractedMemories(store, input) {
    const counts = { added: 0, updated: 0, invalidated: 0, revisedInBatch: 0, skipped: 0 };
    const createdNodeIds = [];
    // What this batch has created so far, so a `revises` naming one of them can
    // be resolved: the candidate list was built before any of these existed.
    const createdInBatch = [];
    const retire = async (nodeId, kind, reason, eventType) => {
        const node = await store.getNode(nodeId);
        // The candidate list is already scoped to this conversation. Checking again
        // here keeps a future caller from turning this into a cross-session write.
        if (!node || node.conversationId !== input.conversationId)
            return false;
        const updated = await store.updateNodeStatus({
            nodeId,
            toStatus: retiredStatus(node.kind),
            eventType,
            reason,
            evidenceSummaryId: input.summaryId,
        });
        return updated !== null;
    };
    const create = async (memory, supersedesNodeId) => {
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
            });
        }
        if (memory.kind === "task") {
            return store.createTaskNode({ ...common, task: text });
        }
        return store.createConstraintNode({ ...common, constraint: text });
    };
    for (const memory of input.memories) {
        if (memory.op === "INVALIDATE") {
            const ok = memory.targetNodeId
                ? await retire(memory.targetNodeId, memory.kind, memory.reason ?? "superseded by a later window", "extraction_invalidate")
                : false;
            if (ok)
                counts.invalidated++;
            else
                counts.skipped++;
            continue;
        }
        // ADD and UPDATE both write a node; UPDATE also names what it replaces.
        let supersedes;
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
        let revisedTarget;
        if (!supersedes && memory.revises) {
            const wanted = normalize(memory.revises);
            const match = createdInBatch.find((c) => c.kind === memory.kind &&
                (normalize(c.text) === wanted ||
                    normalize(c.text).includes(wanted) ||
                    wanted.includes(normalize(c.text))));
            if (match)
                revisedTarget = match.nodeId;
        }
        let node;
        try {
            node = await create(memory, supersedes ?? revisedTarget);
        }
        catch {
            counts.skipped++;
            continue;
        }
        createdNodeIds.push(node.nodeId);
        createdInBatch.push({ nodeId: node.nodeId, kind: memory.kind, text: memory.text ?? "" });
        if (supersedes) {
            await retire(supersedes, memory.kind, memory.reason ?? "replaced by a later statement in the same session", "extraction_update");
            counts.updated++;
        }
        else if (revisedTarget) {
            await retire(revisedTarget, memory.kind, "revised later in the same window", "extraction_revise");
            counts.revisedInBatch++;
            counts.added++;
        }
        else {
            counts.added++;
        }
    }
    return { counts, createdNodeIds };
}
//# sourceMappingURL=extraction-apply.js.map