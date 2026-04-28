/**
 * CodeMemory for Claude Code - Expand Query Tool
 *
 * High-level query tool with subagent delegation.
 *
 * Exactly matches CodeMemory's `codememory_expand_query` tool.
 */
import { CodeMemoryExpansionDelegation } from "./codememory-expand-tool.delegation.js";
import { RetrievalEngine } from "../retrieval.js";
import { CodeMemoryContextAssembler } from "../assembler.js";
/**
 * Default input-side token cap for the conversation context fed into the
 * answer prompt. Used when `config.maxAssemblyTokenBudget` is 0 (the
 * "unlimited" sentinel). 8k leaves comfortable room for the query +
 * retrieved snippets + answer in any small/medium model context window.
 */
const DEFAULT_CONTEXT_TOKEN_CAP = 8000;
export class CodeMemoryExpandQueryTool {
    conversationStore;
    summaryStore;
    deps;
    retrieval;
    delegation;
    assembler;
    constructor(conversationStore, summaryStore, deps) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.deps = deps;
        this.retrieval = new RetrievalEngine(conversationStore, summaryStore);
        this.delegation = new CodeMemoryExpansionDelegation(deps);
        this.assembler = new CodeMemoryContextAssembler(conversationStore, summaryStore);
    }
    async expandQuery(params) {
        const result = {
            answer: "",
            delegated: false,
            tokensUsed: 0,
            warnings: [],
        };
        try {
            this.deps.log.debug(`Processing expand query: ${params.query}`);
            const { text: context, truncated } = await this.buildQueryContext(params);
            if (truncated) {
                result.warnings.push("Conversation context was truncated to fit the assembly token budget.");
            }
            if (params.delegate) {
                this.deps.log.debug("Delegating to subagent...");
                const delegated = await this.delegateToSubagent(params, context);
                if (truncated)
                    delegated.warnings.unshift(...result.warnings);
                return delegated;
            }
            result.answer = await this.answerQueryLocally(params, context);
            result.delegated = false;
            return result;
        }
        catch (error) {
            this.deps.log.error(`Expand query failed: ${error}`);
            result.warnings.push(error instanceof Error ? error.message : String(error));
            result.answer = `Sorry, I encountered an error while trying to answer your query: ${error}`;
            return result;
        }
    }
    /**
     * Build the conversation-context block for the answer prompt.
     * Delegates selection + budget-aware packing to CodeMemoryContextAssembler so
     * long conversations don't blow the model's input window.
     */
    async buildQueryContext(params) {
        if (!params.conversationId)
            return { text: "", truncated: false };
        const cap = this.deps.config.maxAssemblyTokenBudget || DEFAULT_CONTEXT_TOKEN_CAP;
        const packed = await this.assembler.pack(params.conversationId, { tokenBudget: cap });
        // Render assembler output into the existing `[ROLE]: content` block
        // format the rest of this tool already understands.
        const text = packed.messages
            .map((m) => m.kind === "summary"
            ? `[SUMMARY]: ${m.content.replace(/^\[SUMMARY\]\s*/, "")}`
            : `[${m.role.toUpperCase()}]: ${m.content}`)
            .join("\n\n---\n\n");
        return { text, truncated: packed.truncated };
    }
    /**
     * Delegate query to subagent
     */
    async delegateToSubagent(params, context) {
        const result = {
            answer: "",
            delegated: true,
            tokensUsed: 0,
            warnings: [],
        };
        const taskSummary = context
            ? `Answer this question based on the following context:\n\n${context}\n\nQuestion: ${params.query}`
            : `Answer this question: ${params.query}`;
        const delegationResult = await this.delegation.delegate({
            taskSummary,
            tokenBudget: params.tokenBudget || 4000,
            queryLanguage: params.queryLanguage,
        });
        if (delegationResult.success && delegationResult.response) {
            result.answer = delegationResult.response;
            result.tokensUsed = delegationResult.tokensUsed;
        }
        else {
            result.warnings.push(delegationResult.error || "Subagent delegation failed");
            result.answer = await this.answerQueryLocally(params, context);
            result.delegated = false;
        }
        return result;
    }
    /**
     * Answer query using the main model.
     * Retrieves relevant context via grep, then calls deps.complete to synthesize an answer.
     */
    async answerQueryLocally(params, context) {
        const searchResults = await this.retrieval.grep({
            query: params.query,
            mode: "full_text",
            scope: "both",
            conversationId: params.conversationId,
            limit: 10,
        });
        // Build retrieved context block
        const retrievedParts = [];
        for (const msg of searchResults.messages) {
            retrievedParts.push(`[${msg.role.toUpperCase()} message]: ${msg.content}`);
        }
        for (const sum of searchResults.summaries) {
            retrievedParts.push(`[Summary]: ${sum.content}`);
        }
        // If nothing found, return early without calling the model
        if (retrievedParts.length === 0 && !context) {
            return `No relevant content found in conversation history for: ${params.query}`;
        }
        // Compose the full context fed to the model
        const contextBlocks = [];
        if (context)
            contextBlocks.push(context);
        if (retrievedParts.length > 0) {
            contextBlocks.push("## Retrieved snippets\n" + retrievedParts.join("\n\n"));
        }
        const fullContext = contextBlocks.join("\n\n---\n\n");
        // Config-driven model selection. `resolveModel` used to come through
        // deps from the Claude Code host, but the v2 engine no longer carries
        // that wiring — fall back to configured values + a sensible default.
        const provider = this.deps.config.expansionProvider ?? "anthropic";
        const model = this.deps.config.expansionModel ?? this.deps.config.compactionModel;
        try {
            const result = await this.deps.complete({
                provider,
                model,
                messages: [
                    {
                        role: "user",
                        content: `Based on the following conversation history, answer the question concisely and accurately.\n\n` +
                            `${fullContext}\n\n---\n\nQuestion: ${params.query}`,
                    },
                ],
                maxTokens: params.tokenBudget ?? 1000,
            });
            const block = result.content.find((b) => b.type === "text");
            if (block?.text)
                return block.text;
            if (result.error) {
                throw new Error(result.error.message ?? String(result.error));
            }
            throw new Error("Empty response from model");
        }
        catch (err) {
            this.deps.log.warn(`codememory_expand_query model call failed, falling back to raw snippets: ${err}`);
            // Fallback: return the raw retrieved snippets
            return `# Query: ${params.query}\n\n${retrievedParts.join("\n\n") || "(no snippets found)"}`;
        }
    }
}
/**
 * Tool definition for Claude Code CLI
 */
export async function createCodeMemoryExpandQueryTool(conversationStore, summaryStore, deps) {
    const tool = new CodeMemoryExpandQueryTool(conversationStore, summaryStore, deps);
    return {
        name: "codememory_expand_query",
        description: "Answer a question using the conversation history, optionally delegating to a sub-agent",
        params: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The question to answer using the conversation history",
                },
                tokenBudget: {
                    type: "number",
                    description: "Max tokens for the response",
                },
                delegate: {
                    type: "boolean",
                    description: "Whether to delegate to a sub-agent",
                },
                queryLanguage: {
                    type: "string",
                    description: "Query language for the subagent",
                },
            },
            required: ["query"],
        },
        async call(params) {
            return tool.expandQuery(params);
        },
    };
}
//# sourceMappingURL=codememory-expand-query-tool.js.map