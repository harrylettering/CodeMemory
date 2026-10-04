/**
 * What a compaction call reports about the window's decisions, tasks and
 * constraints -- and which of those reports are allowed through.
 *
 * Every rule here is anti-pollution. A wrong new memory costs a line in a
 * future injection; a wrong INVALIDATE destroys one that was right. The
 * standing rule is that polluted memory costs more than missing memory, so
 * anything ambiguous is dropped rather than applied.
 */
export const EXTRACTABLE_KINDS = ["decision", "task", "constraint"];
function parseHeader(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed)
        return null;
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```/);
    const candidate = fenced
        ? fenced[1]
        : trimmed.startsWith("{")
            ? trimmed.slice(0, trimmed.indexOf("\n") === -1 ? undefined : trimmed.indexOf("\n"))
            : null;
    if (!candidate)
        return null;
    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * @param offeredNodeIds the candidate ids this call was shown. An operation
 *   may only target one of these: an id the model produced from anywhere else
 *   is either invented or copied from another session's context.
 */
export function parseExtractedMemories(raw, offeredNodeIds) {
    const header = typeof raw === "string" || raw == null ? parseHeader(raw ?? "") : raw;
    const entries = header?.memories;
    if (!Array.isArray(entries))
        return { accepted: [], rejected: [] };
    const offered = new Set(offeredNodeIds);
    const accepted = [];
    const rejected = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object")
            continue;
        const op = String(entry.op ?? "").toUpperCase();
        if (op === "NOOP" || !op)
            continue;
        if (op !== "ADD" && op !== "UPDATE" && op !== "INVALIDATE")
            continue;
        const kind = String(entry.kind ?? "").toLowerCase();
        if (!EXTRACTABLE_KINDS.includes(kind)) {
            rejected.push({ reason: "unsupported-kind", op });
            continue;
        }
        const text = typeof entry.text === "string" ? entry.text.trim() : "";
        const targetNodeId = typeof entry.targetNodeId === "string" ? entry.targetNodeId.trim() : "";
        if (op !== "ADD") {
            if (!targetNodeId) {
                rejected.push({ reason: "missing-target", op });
                continue;
            }
            if (!offered.has(targetNodeId)) {
                rejected.push({ reason: "unknown-target", op });
                continue;
            }
        }
        if (op !== "INVALIDATE" && !text) {
            rejected.push({ reason: "empty-text", op });
            continue;
        }
        accepted.push({
            kind: kind,
            op,
            ...(text ? { text } : {}),
            ...(targetNodeId ? { targetNodeId } : {}),
            ...(typeof entry.reason === "string" && entry.reason.trim()
                ? { reason: entry.reason.trim() }
                : {}),
            ...(typeof entry.revises === "string" && entry.revises.trim()
                ? { revises: entry.revises.trim() }
                : {}),
        });
    }
    // Two operations on the same node mean the model did not settle on one
    // reading of the window. Applying either would be a guess, so both go.
    const perTarget = new Map();
    for (const item of accepted) {
        if (!item.targetNodeId)
            continue;
        const list = perTarget.get(item.targetNodeId) ?? [];
        list.push(item);
        perTarget.set(item.targetNodeId, list);
    }
    const conflicted = new Set();
    for (const list of perTarget.values()) {
        if (list.length > 1)
            for (const item of list)
                conflicted.add(item);
    }
    if (conflicted.size > 0) {
        for (const item of accepted) {
            if (conflicted.has(item))
                rejected.push({ reason: "conflicting-ops", op: item.op });
        }
        return { accepted: accepted.filter((i) => !conflicted.has(i)), rejected };
    }
    return { accepted, rejected };
}
//# sourceMappingURL=extracted-memories.js.map