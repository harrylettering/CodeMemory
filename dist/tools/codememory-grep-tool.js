/**
 * CodeMemory for Claude Code - Grep Tool
 *
 * Search tool for conversation history and summaries.
 *
 * Exactly matches CodeMemory's `codememory_grep` tool implementation.
 */
import { RetrievalEngine } from "../retrieval.js";
export class CodeMemoryGrepTool {
    conversationStore;
    summaryStore;
    deps;
    retrieval;
    constructor(conversationStore, summaryStore, deps) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.deps = deps;
        this.retrieval = new RetrievalEngine(conversationStore, summaryStore);
    }
    /**
     * Execute search
     */
    async grep(params) {
        const results = await this.retrieval.grep({
            query: params.query,
            mode: params.mode,
            scope: params.scope,
            conversationId: params.conversationId,
            since: params.since,
            before: params.before,
            limit: params.limit,
        });
        return {
            messages: results.messages.map((msg) => ({
                id: msg.messageId,
                conversationId: msg.conversationId,
                role: msg.role,
                content: msg.content,
                tokenCount: msg.tokenCount,
                createdAt: msg.createdAt,
            })),
            summaries: results.summaries.map((sum) => ({
                id: sum.summaryId,
                conversationId: sum.conversationId,
                kind: sum.kind,
                content: sum.content,
                tokenCount: sum.tokenCount,
                createdAt: sum.createdAt,
                depth: sum.depth,
                descendantCount: sum.descendantCount,
            })),
            totalMatches: results.totalMatches,
            mode: params.mode,
            scope: params.scope,
        };
    }
    /**
     * Create a short search result preview snippet
     */
    createPreview(content, query, contextChars = 100) {
        const lowerContent = content.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const index = lowerContent.indexOf(lowerQuery);
        if (index === -1) {
            return content.slice(0, 200) + (content.length > 200 ? "..." : "");
        }
        const start = Math.max(0, index - contextChars);
        const end = Math.min(content.length, index + query.length + contextChars);
        let preview = content.slice(start, end);
        // Add ellipsis if we're not at the beginning
        if (start > 0) {
            preview = "..." + preview;
        }
        // Add ellipsis if we're not at the end
        if (end < content.length) {
            preview = preview + "...";
        }
        return preview;
    }
    /**
     * Get search suggestions based on query pattern
     */
    getSuggestions(query) {
        const suggestions = [];
        if (query.length > 3) {
            // Simple heuristic: extract possible keywords
            const keywords = query.trim().split(/\s+/).filter(w => w.length > 3);
            if (keywords.length > 0) {
                suggestions.push(...keywords.map(w => `*${w}*`));
            }
        }
        return suggestions.slice(0, 5);
    }
}
/**
 * Tool definition for Claude Code CLI
 */
export async function createCodeMemoryGrepTool(conversationStore, summaryStore, deps) {
    const tool = new CodeMemoryGrepTool(conversationStore, summaryStore, deps);
    return {
        name: "codememory_grep",
        description: "Search conversation history and summaries for patterns",
        params: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search query text",
                },
                mode: {
                    type: "string",
                    enum: ["regex", "full_text"],
                    description: "Search mode: regex or full_text (case-insensitive)",
                },
                scope: {
                    type: "string",
                    enum: ["messages", "summaries", "both"],
                    description: "Search scope: messages, summaries, or both",
                },
                limit: {
                    type: "number",
                    description: "Max number of results to return",
                },
            },
            required: ["query", "mode", "scope"],
        },
        async call(params) {
            return tool.grep(params);
        },
    };
}
//# sourceMappingURL=codememory-grep-tool.js.map