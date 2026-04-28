export class LcmCompactTool {
    engine;
    getCurrentSessionId;
    constructor(engine, getCurrentSessionId) {
        this.engine = engine;
        this.getCurrentSessionId = getCurrentSessionId;
    }
    async compact(params) {
        const sessionId = params.sessionId || this.getCurrentSessionId();
        if (!sessionId) {
            return {
                ok: false,
                actionTaken: false,
                reason: "No active sessionId — specify a sessionId to compact.",
            };
        }
        try {
            const compactResult = await this.engine.compact({
                sessionId,
                tokenBudget: params.tokenBudget,
            });
            if (!compactResult.actionTaken) {
                return {
                    ok: true,
                    actionTaken: false,
                    reason: "No compaction needed — conversation is already under threshold.",
                };
            }
            const tokensSaved = compactResult.tokensBefore - compactResult.tokensAfter;
            return {
                ok: true,
                actionTaken: true,
                tokensBefore: compactResult.tokensBefore,
                tokensAfter: compactResult.tokensAfter,
                tokensSaved,
                createdSummaryId: compactResult.createdSummaryId,
                level: compactResult.level,
                reason: `Successfully compacted conversation: saved ${tokensSaved} tokens (${Math.round((tokensSaved / compactResult.tokensBefore) * 100)}% reduction).`,
            };
        }
        catch (error) {
            return {
                ok: false,
                actionTaken: false,
                reason: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
}
export async function createLcmCompactTool(engine, getCurrentSessionId) {
    const tool = new LcmCompactTool(engine, getCurrentSessionId);
    return {
        name: "lcm_compact",
        description: "Manually compact the current conversation history to reduce token usage. Compaction preserves all content in a summary DAG that can be expanded back to full text when needed. Use when you want to free up context space for new work.",
        params: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Optional session ID to compact (defaults to current session).",
                },
                tokenBudget: {
                    type: "number",
                    description: "Optional target token budget for the compacted context.",
                },
            },
            required: [],
        },
        async call(params) {
            return tool.compact(params);
        },
    };
}
//# sourceMappingURL=lcm-compact-tool.js.map