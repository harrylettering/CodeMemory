/**
 * Negative Experience Extractor.
 *
 * Takes a message known to contain an error (tier='S', tags includes 'error'),
 * and extracts structured NegExp record fields.
 *
 * Phase 2 approach (conservative/simple):
 * - location: from preceding Edit/Write/Bash (tracked via a small window of recent mutations)
 * - type: from classifyError() in signature.ts
 * - signature: normalizeError() in signature.ts
 * - attemptedFix: just the preceding mutation's description (no LLM)
 */
import { normalizeError, classifyError, extractSymbol } from "./signature.js";
// Pre-filter: reject obvious non-coding errors that still got tagged "error".
const NOISE_PATTERNS = [
    /user doesn't want to proceed/i,
    /Failed to clone repository/i,
    /Request failed with status code/i,
    /Claude Code Installation/i,
    /marketplace/i,
    /chrome-devtools/i,
];
// Stronger indicators: we only consider something a real Negative Experience
// if it has these patterns (in addition to the 'error' tag). Coverage map:
//   - shell/exit       : "exit code N", non-zero status
//   - Python           : Traceback + named exceptions
//   - JS/TS runtime    : Error subclasses, "Cannot read", "is not a function"
//   - TypeScript       : TSxxxx diagnostics
//   - Jest / Vitest    : "FAIL", "Tests failed", assertion diffs
//   - ESLint           : "  error  " gutter, "Parsing error", "✖ N problems"
//   - Go               : "panic:", "FAIL\t", "undefined:", "cannot find package"
//   - Rust             : "error[E", "thread 'main' panicked"
//   - npm / yarn       : "npm ERR!", "ELIFECYCLE", "ENOENT"
//   - filesystem       : ENOENT, EACCES, EPERM, ENOTFOUND
const CODING_ERROR_PATTERNS = [
    // shell / process
    /exit code\s*[^0]/i,
    /Command failed with exit code/i,
    // Python
    /Traceback\s*\(most recent call last\)/i,
    /\b(IndexError|TypeError|ReferenceError|SyntaxError|NameError|AttributeError|KeyError|ValueError|ZeroDivisionError|ImportError|ModuleNotFoundError|RuntimeError|FileNotFoundError|PermissionError)\b/,
    // JS / TS runtime
    /undefined is not/i,
    /is not a function/i,
    /Cannot read propert/i,
    /Cannot find module/i,
    /Unexpected token/i,
    // TypeScript
    /\bTS\d{4}\b/,
    /\(line \d+,\s*column \d+\):\s*(error|warning)/i,
    // generic compiler/lint diagnostics
    /^\s*error\s*:/im,
    /index.*out\s+of.*range/i,
    /out of bounds/i,
    // Jest / Vitest
    /^\s*FAIL\s/m,
    /Tests?:\s+\d+ failed/i,
    /AssertionError/i,
    /expect\(.*\)\..*to/i,
    /✕\s/,
    // ESLint
    /\d+\s+error[s]?\s*\(.*rule/i,
    /Parsing error:/i,
    /✖\s+\d+\s+problem/i,
    /\s+error\s+'.*'\s+is\s+(not\s+defined|assigned)/i,
    // Go
    /^panic:\s/m,
    /^FAIL\t/m,
    /undefined:\s+\w+/,
    /cannot find package/i,
    // Rust
    /\berror\[E\d{4}\]/,
    /thread '.*' panicked/i,
    // Node / npm / yarn
    /\bnpm ERR!/,
    /\bELIFECYCLE\b/,
    // filesystem syscall errors
    /\b(ENOENT|EACCES|EPERM|ENOTFOUND|EISDIR|ENOTDIR)\b/,
];
function isLikelyCodingError(raw) {
    if (NOISE_PATTERNS.some((re) => re.test(raw))) {
        return false;
    }
    return CODING_ERROR_PATTERNS.some((re) => re.test(raw));
}
export class NegExpExtractor {
    recentMutations = [];
    maxWindowSize = 5;
    /**
     * Window-based dedup. Maps `${convId}-${signature}` → seq of last insert.
     * If the same signature recurs within DEDUP_SEQ_WINDOW we skip; outside
     * the window it counts as a fresh recurrence and gets re-inserted (this
     * is the whole point of NegExp — detect "stepping on the same pit
     * twice"). The previous implementation used a Set and suppressed forever,
     * which defeated the goal.
     */
    lastSeenSignatureSeq = new Map();
    static DEDUP_SEQ_WINDOW = 10;
    /**
     * Most recently observed mutation, or null. Used by the daemon to
     * attribute "user said it's fixed" to the right target.
     */
    getMostRecentMutation() {
        return this.recentMutations[this.recentMutations.length - 1] ?? null;
    }
    /**
     * Call this for EVERY message (even non-error ones). This lets us track
     * the preceding mutations to an error.
     */
    observeMessage(msg, seq) {
        const parts = msg.metadata?.parts ?? [];
        for (const part of parts) {
            if (part.type === "tool_use") {
                const t = this.extractMutationTarget(part.name, part.input);
                if (!t)
                    continue;
                this.recordRecentMutation({
                    seq,
                    tool: part.name,
                    filePath: t.filePath,
                    command: t.command,
                    description: t.description,
                });
            }
        }
    }
    recordRecentMutation(m) {
        this.recentMutations.push(m);
        if (this.recentMutations.length > this.maxWindowSize) {
            this.recentMutations.shift();
        }
    }
    extractMutationTarget(toolName, input) {
        if (!input || typeof input !== "object")
            return null;
        // Build a meaningful one-liner that captures WHAT was attempted, not
        // just which file. This is what the model sees as `attemptedFix` in
        // the PreToolUse warning, and "[Edit] foo.ts" alone tells it nothing.
        const snippet = (s, max = 160) => {
            if (typeof s !== "string")
                return "";
            const collapsed = s.replace(/\s+/g, " ").trim();
            return collapsed.length > max
                ? collapsed.slice(0, max) + "…"
                : collapsed;
        };
        if (toolName === "Edit") {
            const fp = input.file_path || input.path;
            if (!fp)
                return null;
            const before = snippet(input.old_string, 60);
            const after = snippet(input.new_string, 80);
            const desc = before || after
                ? `[Edit] ${fp} — replaced "${before}" with "${after}"`
                : `[Edit] ${fp}`;
            return { filePath: fp, description: desc };
        }
        if (toolName === "Write") {
            const fp = input.file_path || input.path;
            if (!fp)
                return null;
            const body = snippet(input.content, 120);
            const desc = body ? `[Write] ${fp} — ${body}` : `[Write] ${fp}`;
            return { filePath: fp, description: desc };
        }
        if (toolName === "NotebookEdit") {
            const fp = input.file_path || input.path;
            if (!fp)
                return null;
            return { filePath: fp, description: `[NotebookEdit] ${fp}` };
        }
        if (toolName === "Bash") {
            const cmd = typeof input.command === "string" ? input.command.trim() : "";
            if (!cmd)
                return null;
            // Keep the FULL command — retriever queries by leading binary token.
            const fileMatch = cmd.match(/\b((?:\.\.?\/|\/|[\w.-]+\/)?[\w.-]+\.[a-zA-Z]{1,5})\b/);
            return {
                command: cmd,
                filePath: fileMatch?.[1],
                description: `[Bash] ${snippet(cmd, 200)}`,
            };
        }
        if (["Read", "Grep", "Glob"].includes(toolName)) {
            const fp = input.file_path || input.path || input.pattern;
            if (!fp)
                return null;
            return { filePath: fp, description: `[${toolName}] ${fp}` };
        }
        return null;
    }
    /**
     * Extract a NegExp record from an error message. Must have already called
     * observeMessage on preceding messages.
     */
    extractFromErrorMessage(msg, conversationId, seq) {
        const raw = msg.content;
        if (!raw)
            return null;
        // Pre-filter: only consider real coding errors
        if (!isLikelyCodingError(raw)) {
            return null;
        }
        const signature = normalizeError(raw);
        const type = classifyError(signature);
        // Window-based dedup: skip only if the same signature was seen in the
        // last DEDUP_SEQ_WINDOW seqs (typical "assistant retries the exact
        // same thing 3 times in a row" loop). Outside the window, treat as a
        // fresh recurrence and re-insert.
        const dedupKey = `${conversationId}-${signature}`;
        const prevSeq = this.lastSeenSignatureSeq.get(dedupKey);
        if (prevSeq != null && seq - prevSeq < NegExpExtractor.DEDUP_SEQ_WINDOW) {
            return null;
        }
        this.lastSeenSignatureSeq.set(dedupKey, seq);
        // Find the most recent mutation before this seq (likely what triggered the error)
        const recent = this.recentMutations
            .filter((m) => m.seq < seq)
            .sort((a, b) => b.seq - a.seq)[0];
        return {
            type,
            signature,
            raw,
            filePath: recent?.filePath,
            command: recent?.command,
            symbol: extractSymbol(raw),
            // Keep `location` populated for legacy readers; prefer filePath/command.
            location: recent?.filePath ?? recent?.command,
            attemptedFix: recent?.description,
            messageId: msg.id,
        };
    }
    /**
     * Call this when an error is known to be resolved (no recurrence after N messages).
     * Provide the resolution description (e.g. "switched to zod parse").
     */
    markResolvedBy(errorSig, resolution) {
        // Phase 2: just return the info; Phase 3 will persist it.
        return { signature: errorSig, resolution };
    }
}
//# sourceMappingURL=extractor.js.map