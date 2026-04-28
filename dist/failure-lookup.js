/**
 * Failure-node lookup. Replaces the old negexp lookup pipeline now that
 * failures live as memory_nodes (kind='failure'). Used by both the
 * cold-start CLI (`failure-lookup-cli.ts`) and the daemon socket handler
 * (`daemon.ts`).
 *
 * Confidence floor + 30-day half-life decay are preserved so the model
 * gets the same signal-to-noise as before — see #19 for why low-confidence
 * matches must be filtered before injection.
 */
const MIN_CONFIDENCE = 0.6;
const DECAY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export function getTargetsFromInput(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== "object")
        return {};
    if (["Read", "Grep", "Edit", "Write", "NotebookEdit", "Glob"].includes(toolName)) {
        const fp = toolInput.file_path || toolInput.path;
        return fp ? { filePath: fp } : {};
    }
    if (toolName === "Bash") {
        const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
        if (!cmd)
            return {};
        const fileMatch = cmd.match(/\b((?:\.\.?\/|\/|[\w.-]+\/)?[\w.-]+\.[a-zA-Z]{1,5})\b/);
        return { command: cmd, filePath: fileMatch?.[1] };
    }
    return {};
}
export function decayFactor(createdAt, now = Date.now()) {
    if (createdAt == null)
        return 1.0;
    const createdMs = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
    if (!Number.isFinite(createdMs))
        return 1.0;
    const ageDays = Math.max(0, (now - createdMs) / MS_PER_DAY);
    return Math.pow(2, -ageDays / DECAY_HALF_LIFE_DAYS);
}
/**
 * Score one failure against the current invocation.
 *   - Exact filePath match  → 1.0
 *   - 2-token command match → 0.7
 *   - 1-token command only  → 0.3
 *   - Fallback (no fields)  → 0.2
 * Final = base × stored weight × age-decay.
 */
export function scoreMatch(node, targets, now = Date.now()) {
    const meta = node.metadata;
    const nodeFilePath = stringOrUndef(meta.filePath);
    const nodeCommand = stringOrUndef(meta.command);
    const weight = typeof meta.weight === "number" && Number.isFinite(meta.weight)
        ? meta.weight
        : node.confidence || 1.0;
    let base = 0.2;
    if (targets.filePath && nodeFilePath && nodeFilePath === targets.filePath) {
        base = 1.0;
    }
    else if (targets.command && nodeCommand) {
        const queryTokens = targets.command.trim().split(/\s+/);
        const nodeTokens = nodeCommand.trim().split(/\s+/);
        if (queryTokens.length >= 2 && nodeTokens.length >= 2) {
            if (queryTokens[0] === nodeTokens[0] &&
                queryTokens[1] === nodeTokens[1]) {
                base = 0.7;
            }
            else if (queryTokens[0] === nodeTokens[0]) {
                base = 0.3;
            }
        }
        else if (queryTokens[0] === nodeTokens[0]) {
            base = 0.3;
        }
    }
    return base * weight * decayFactor(node.createdAt, now);
}
export function shapeFailure(node, confidence) {
    const meta = node.metadata;
    return {
        nodeId: node.nodeId,
        type: stringOrUndef(meta.type) ?? "failure",
        signature: stringOrUndef(meta.signature) ?? "",
        filePath: stringOrUndef(meta.filePath),
        command: stringOrUndef(meta.command),
        symbol: stringOrUndef(meta.symbol),
        attemptedFix: stringOrUndef(meta.attemptedFix),
        location: stringOrUndef(meta.location),
        raw: extractRawFromContent(node.content),
        createdAt: node.createdAt,
        confidence: Math.round(confidence * 100) / 100,
    };
}
export function renderFailureMarkdown(failures) {
    return failures
        .map((f) => {
        const where = f.filePath ?? f.command ?? f.location ?? "(unknown)";
        const sym = f.symbol ? ` :: ${f.symbol}` : "";
        const attempted = f.attemptedFix ? `\nAttempted: ${f.attemptedFix}` : "";
        const snippet = (f.raw || "").slice(0, 240).replace(/\s+/g, " ");
        const age = formatAge(f.createdAt);
        return `**${f.type}** — ${where}${sym}${age}${attempted}\nError: ${snippet}`;
    })
        .join("\n\n---\n\n");
}
/**
 * PreToolUse / cold-start entry point. Cross-conversation by default —
 * failures from prior sessions still surface, which is the whole point.
 */
export async function lookupForPreToolUse(store, toolName, toolInput, options = {}) {
    const targets = getTargetsFromInput(toolName, toolInput);
    if (!targets.filePath && !targets.command) {
        return {
            shouldInject: false,
            reason: "No retrievable target from tool input",
            failures: [],
        };
    }
    const candidates = await store.findFailuresByAnchors({
        files: targets.filePath ? [targets.filePath] : [],
        commands: targets.command ? [targets.command] : [],
        statuses: ["active"],
        limit: 8,
    });
    const now = Date.now();
    const scored = candidates
        .map(({ node }) => ({ node, score: scoreMatch(node, targets, now) }))
        .filter(({ score }) => score >= MIN_CONFIDENCE)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit ?? 2);
    if (scored.length === 0) {
        return {
            shouldInject: false,
            reason: candidates.length > 0
                ? `Filtered ${candidates.length} candidate(s) below confidence threshold`
                : "No prior failures for this target",
            failures: [],
        };
    }
    const failures = scored.map((s) => shapeFailure(s.node, s.score));
    return {
        shouldInject: true,
        reason: "Found relevant prior failures",
        failures,
        markdown: renderFailureMarkdown(failures),
    };
}
function formatAge(createdAt) {
    if (createdAt == null)
        return "";
    const ms = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
    if (!Number.isFinite(ms))
        return "";
    const ageDays = (Date.now() - ms) / MS_PER_DAY;
    if (ageDays < 1)
        return " (today)";
    if (ageDays < 2)
        return " (yesterday)";
    if (ageDays < 30)
        return ` (${Math.floor(ageDays)}d ago)`;
    return ` (${Math.floor(ageDays / 30)}mo ago)`;
}
function stringOrUndef(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/**
 * `[FAILURE] header\nFile: ...\n...\n<raw>` — the raw text is whatever
 * remains after the structured prelude. Used to surface a snippet without
 * hauling the whole content blob.
 */
function extractRawFromContent(content) {
    const lines = content.split("\n");
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("[FAILURE] ") ||
            line.startsWith("File: ") ||
            line.startsWith("Command: ") ||
            line.startsWith("Symbol: ") ||
            line.startsWith("Attempted fix: ")) {
            i += 1;
            continue;
        }
        break;
    }
    return lines.slice(i).join("\n");
}
export const FAILURE_LOOKUP_MIN_CONFIDENCE = MIN_CONFIDENCE;
//# sourceMappingURL=failure-lookup.js.map