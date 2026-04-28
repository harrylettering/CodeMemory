/**
 * Lossless Claw for Claude Code - Summarization Engine
 *
 * LLM-backed summarization with escalation strategies.
 *
 * Exactly matches Lossless Claw's summarization architecture.
 */
/**
 * Estimate token count for a string
 */
function estimateTokens(content) {
    return Math.ceil(content.length / 4);
}
/**
 * Simple fallback summarization when LLM calls fail
 */
function createFallbackSummary(content, maxTokens) {
    const targetLength = maxTokens * 4; // rough estimate
    if (content.length <= targetLength) {
        return content;
    }
    // Simple heuristic: take first part + last part with ellipsis
    const half = targetLength / 2;
    const first = content.slice(0, half);
    const last = content.slice(-half);
    return `${first}\n\n... [truncated] ...\n\n${last}`;
}
/**
 * System prompt for normal summarization
 */
const NORMAL_SUMMARY_SYSTEM_PROMPT = `You are an expert summarizer. Your task is to create a concise, lossless summary of the conversation history.

Guidelines:
- Focus on key decisions, requirements, and facts
- Include all user preferences and constraints
- Preserve technical details and architecture decisions
- Be concise but do NOT omit important information
- Use bullet points for clarity when appropriate
- Maintain chronological context`;
/**
 * System prompt for aggressive summarization
 */
const AGGRESSIVE_SUMMARY_SYSTEM_PROMPT = `You are an expert summarizer. Your task is to create an EXTREMELY concise summary of the conversation history.

Guidelines:
- ONLY include the MOST critical information
- Omit all non-essential details
- Use maximum compression while preserving key facts
- Be extremely brief - this is for high-level overview only`;
export class LcmSummarizer {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Summarize content with escalation strategy:
     * 1. Try normal model with normal prompt
     * 2. If that fails or is too long, try aggressive model with aggressive prompt
     * 3. If that fails, use fallback heuristic summarization
     */
    async summarize(params) {
        const { content, maxTokens, normalModel, aggressiveModel, runtimeContext } = params;
        // If content is already within token limit, return it as-is
        const contentTokens = estimateTokens(content);
        if (contentTokens <= maxTokens) {
            return {
                content,
                tokenCount: contentTokens,
                strategy: "normal",
                truncated: false,
            };
        }
        // Strategy 1: Normal summarization
        try {
            const normalSummary = await this.summarizeWithStrategy(content, normalModel, NORMAL_SUMMARY_SYSTEM_PROMPT, maxTokens);
            if (normalSummary && estimateTokens(normalSummary) <= maxTokens) {
                return {
                    content: normalSummary,
                    tokenCount: estimateTokens(normalSummary),
                    strategy: "normal",
                    truncated: false,
                };
            }
        }
        catch (error) {
            this.deps.log.debug(`Normal summarization failed: ${error}`);
        }
        // Strategy 2: Aggressive summarization
        try {
            const aggressiveSummary = await this.summarizeWithStrategy(content, aggressiveModel, AGGRESSIVE_SUMMARY_SYSTEM_PROMPT, maxTokens);
            if (aggressiveSummary && estimateTokens(aggressiveSummary) <= maxTokens) {
                return {
                    content: aggressiveSummary,
                    tokenCount: estimateTokens(aggressiveSummary),
                    strategy: "aggressive",
                    truncated: false,
                };
            }
        }
        catch (error) {
            this.deps.log.debug(`Aggressive summarization failed: ${error}`);
        }
        // Strategy 3: Fallback heuristic summarization
        const fallbackSummary = createFallbackSummary(content, maxTokens);
        return {
            content: fallbackSummary,
            tokenCount: estimateTokens(fallbackSummary),
            strategy: "fallback",
            truncated: true,
        };
    }
    /**
     * Perform summarization with a specific model and prompt
     */
    async summarizeWithStrategy(content, model, systemPrompt, maxTokens) {
        const resolved = this.deps.resolveModel(model);
        const apiKey = await this.deps.getApiKey(resolved.provider, resolved.model, {
            skipModelAuth: true,
        });
        if (!apiKey) {
            return null;
        }
        const result = await this.deps.complete({
            provider: resolved.provider,
            model: resolved.model,
            apiKey,
            messages: [
                {
                    role: "user",
                    content: `Please summarize the following conversation history:\n\n${content}`,
                },
            ],
            system: systemPrompt,
            maxTokens: Math.max(512, Math.min(4096, maxTokens * 2)),
            temperature: 0.3,
        });
        if (result.error) {
            throw new Error(`Summarization failed: ${result.error.message}`);
        }
        const summaryText = result.content
            .filter((block) => block.type === "text" && block.text)
            .map((block) => block.text)
            .join("");
        if (!summaryText.trim()) {
            return null;
        }
        return summaryText;
    }
    /**
     * Create a leaf summary (single message or small group)
     */
    async createLeafSummary(content, maxTokens) {
        return this.summarize({
            content,
            maxTokens,
            normalModel: "claude-3-5-haiku",
            aggressiveModel: "claude-3-5-haiku",
        });
    }
    /**
     * Create a condensed summary (combining multiple summaries)
     */
    async createCondensedSummary(contents, maxTokens) {
        const combinedContent = contents.join("\n\n---\n\n");
        return this.summarize({
            content: combinedContent,
            maxTokens,
            normalModel: "claude-3-5-sonnet",
            aggressiveModel: "claude-3-5-haiku",
        });
    }
}
//# sourceMappingURL=summarize.js.map