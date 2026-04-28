/**
 * codememory_check_prior_failures — model-callable failure lookup.
 *
 * Acts as the in-band fallback for the PreToolUse hook: when the hook
 * isn't installed (or the model wants to proactively pre-flight an
 * approach), it can call this tool with a target description and we run
 * the same `lookupForPreToolUse` pipeline that the daemon uses, scoped
 * to memory_nodes (kind='failure').
 *
 * Inputs intentionally mirror what PreToolUse sees:
 *   - filePath  → "is this file a known landmine?"
 *   - command   → "has this command failed before?"
 *   - symbol    → "any failures touching this function/property?"
 * At least one must be provided. We do NOT take a free-text query — the
 * failure index is structured, not embedding-based, and free-text fishing
 * would surface noise the confidence threshold can't filter.
 */
import { lookupForPreToolUse, scoreMatch, shapeFailure, renderFailureMarkdown, FAILURE_LOOKUP_MIN_CONFIDENCE, } from "../failure-lookup.js";
export class CodeMemoryCheckPriorFailuresTool {
    memoryStore;
    constructor(memoryStore) {
        this.memoryStore = memoryStore;
    }
    async check(params) {
        const limit = Math.min(params.limit ?? 3, 5);
        // filePath / command paths route through the shared pipeline used by
        // the PreToolUse hook so behavior stays identical.
        if (params.filePath || params.command) {
            const toolName = params.filePath ? "Edit" : "Bash";
            const toolInput = params.filePath
                ? { file_path: params.filePath }
                : { command: params.command };
            const resp = await lookupForPreToolUse(this.memoryStore, toolName, toolInput, { limit });
            return mapResponse(resp, limit);
        }
        if (params.symbol) {
            const candidates = await this.memoryStore.findFailuresByAnchors({
                symbols: [params.symbol],
                statuses: ["active"],
                limit: limit + 4,
            });
            const now = Date.now();
            const scored = candidates
                .map(({ node }) => ({
                node,
                score: scoreMatch(node, {
                    filePath: stringMeta(node.metadata, "filePath"),
                    command: stringMeta(node.metadata, "command"),
                }, now),
            }))
                .filter(({ score }) => score >= FAILURE_LOOKUP_MIN_CONFIDENCE)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
            if (scored.length === 0) {
                return {
                    found: false,
                    count: 0,
                    reason: candidates.length > 0
                        ? `Filtered ${candidates.length} symbol match(es) below confidence threshold`
                        : "No prior failures mention this symbol",
                    failures: [],
                };
            }
            const failures = scored.map((s) => shapeFailure(s.node, s.score));
            return {
                found: true,
                count: failures.length,
                reason: `Found ${failures.length} prior failure(s) mentioning ${params.symbol}`,
                markdown: renderFailureMarkdown(failures),
                failures,
            };
        }
        return {
            found: false,
            count: 0,
            reason: "Provide at least one of: filePath, command, symbol",
            failures: [],
        };
    }
}
function mapResponse(resp, limit) {
    const failures = resp.failures.slice(0, limit);
    return {
        found: resp.shouldInject && failures.length > 0,
        count: failures.length,
        reason: resp.reason,
        markdown: resp.markdown,
        failures,
    };
}
function stringMeta(metadata, key) {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
export async function createCodeMemoryCheckPriorFailuresTool(memoryStore) {
    const tool = new CodeMemoryCheckPriorFailuresTool(memoryStore);
    return {
        name: "codememory_check_prior_failures",
        description: "Check whether a file, command, or symbol has caused failures in past sessions before you act on it. Use proactively before non-trivial Edit/Bash operations or when planning a fix. Returns past errors with attempted fixes and confidence scores.",
        params: {
            type: "object",
            properties: {
                filePath: {
                    type: "string",
                    description: "Absolute or repo-relative file path you're about to touch.",
                },
                command: {
                    type: "string",
                    description: "Shell command you're about to run (e.g. 'npm test', 'cargo build').",
                },
                symbol: {
                    type: "string",
                    description: "Function, method, or property name you're about to modify or call.",
                },
                limit: {
                    type: "number",
                    description: "Max records to return (default 3, max 5).",
                },
            },
            required: [],
        },
        async call(params) {
            return tool.check(params);
        },
    };
}
//# sourceMappingURL=codememory-check-prior-failures-tool.js.map