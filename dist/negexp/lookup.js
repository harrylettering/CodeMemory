/**
 * Shared NegExp lookup logic. Used by both the cold-start CLI
 * (`retrieve-cli.ts`) and the long-lived daemon socket handler
 * (`daemon.ts`). Keep this module dependency-light so the daemon's hot
 * path stays fast.
 */
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
export function renderMarkdown(experiences) {
    return experiences
        .map((exp) => {
        const where = exp.filePath ?? exp.command ?? exp.location ?? "(unknown)";
        const sym = exp.symbol ? ` :: ${exp.symbol}` : "";
        const attempted = exp.attemptedFix
            ? `\nAttempted: ${exp.attemptedFix}`
            : "";
        const snippet = (exp.raw || "").slice(0, 240).replace(/\s+/g, " ");
        const age = formatAge(exp.createdAt);
        return `**${exp.type}** — ${where}${sym}${age}${attempted}\nError: ${snippet}`;
    })
        .join("\n\n---\n\n");
}
/**
 * Confidence threshold below which we suppress injection. The model
 * doesn't need (and is annoyed by) low-evidence "this might be related"
 * warnings — those just teach it to ignore the channel. (#19)
 */
const MIN_CONFIDENCE = 0.6;
/**
 * Half-life for time-decay of NegExp confidence, in days. After
 * `DECAY_HALF_LIFE_DAYS` an unresolved record is worth half what it was
 * when fresh. The intent: a TS error from yesterday is high-signal, a TS
 * error from three months ago on the same file is probably stale and
 * shouldn't be raising the alarm.
 *
 * 30 days was chosen so:
 *   - week-old failure  →  ~0.85× (still surfaces)
 *   - month-old failure →  0.50×  (surfaces at half strength)
 *   - 90-day failure    →  ~0.13× (drops below 0.6 threshold even on a
 *                                  perfect filePath match)
 */
const DECAY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Compute the age-decay factor for a record. Returns 1.0 for fresh
 * records, decaying exponentially by half-life. Exposed for tests.
 */
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
 * Score a single match against the current invocation.
 *
 *   - Exact filePath match  → 1.0  (very strong signal)
 *   - 2-token command match → 0.7  (strong: "npm test" → "npm test ...")
 *   - 1-token command only  → 0.3  (weak: "git" → any git failure)
 *   - Fallback (no fields)  → 0.2
 *
 * Final score = base × stored weight × age-decay factor.
 */
export function scoreMatch(exp, targets, now = Date.now()) {
    let base = 0.2;
    if (targets.filePath && exp.filePath && exp.filePath === targets.filePath) {
        base = 1.0;
    }
    else if (targets.command && exp.command) {
        const queryTokens = targets.command.trim().split(/\s+/);
        const expTokens = exp.command.trim().split(/\s+/);
        if (queryTokens.length >= 2 && expTokens.length >= 2) {
            // Two-token match e.g. "npm test" === "npm test"
            if (queryTokens[0] === expTokens[0] &&
                queryTokens[1] === expTokens[1]) {
                base = 0.7;
            }
            else if (queryTokens[0] === expTokens[0]) {
                base = 0.3;
            }
        }
        else if (queryTokens[0] === expTokens[0]) {
            base = 0.3;
        }
    }
    return base * (exp.weight ?? 1.0) * decayFactor(exp.createdAt, now);
}
/**
 * Single entry point used by both CLI and daemon. Cross-session retrieval
 * by default — sessionId is intentionally NOT used as a hard filter.
 *
 * Filters results by `MIN_CONFIDENCE` so weak matches don't reach the
 * model — see #19 for the rationale (low-confidence noise teaches the
 * model to ignore the warning channel entirely).
 */
export async function lookupForPreToolUse(retriever, toolName, toolInput) {
    const targets = getTargetsFromInput(toolName, toolInput);
    if (!targets.filePath && !targets.command) {
        return {
            shouldInject: false,
            reason: "No retrievable target from tool input",
            experiences: [],
        };
    }
    const candidates = await retriever.retrieveForPreToolUse(toolName, targets, { limit: 4, includeResolved: false });
    // Score + filter. Sort by descending confidence so the best matches
    // win when we cap to limit=2.
    const scored = candidates
        .map((exp) => ({ exp, score: scoreMatch(exp, targets) }))
        .filter(({ score }) => score >= MIN_CONFIDENCE)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
    if (scored.length === 0) {
        return {
            shouldInject: false,
            reason: candidates.length > 0
                ? `Filtered ${candidates.length} candidate(s) below confidence threshold`
                : "No Negative Experiences for this target",
            experiences: [],
        };
    }
    const experiences = scored.map((s) => s.exp);
    return {
        shouldInject: true,
        reason: "Found relevant Negative Experiences",
        experiences,
        markdown: renderMarkdown(experiences),
    };
}
//# sourceMappingURL=lookup.js.map