/**
 * CodeMemory for Claude Code - Describe Tool
 *
 * Tool for describing summaries and their relationships.
 *
 * Exactly matches CodeMemory's `codememory_describe` tool implementation.
 */
import { RetrievalEngine } from "../retrieval.js";
export class CodeMemoryDescribeTool {
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
     * Describe a summary or file
     */
    async describe(params) {
        const result = await this.retrieval.describe(params.id);
        if (!result) {
            return null;
        }
        return result;
    }
    /**
     * Format summary content for display
     */
    formatSummaryContent(summary) {
        const lines = [];
        lines.push(`Summary ID: ${this.formatId(summary.parentIds.length > 0 ? summary.childIds[0] || "" : "")}`);
        lines.push(`Kind: ${summary.kind}`);
        lines.push(`Depth: ${summary.depth}`);
        lines.push(`Token count: ${summary.tokenCount}`);
        lines.push(`Descendant count: ${summary.descendantCount}`);
        lines.push(`Created at: ${summary.createdAt.toISOString()}`);
        if (summary.earliestAt) {
            lines.push(`Covers from: ${summary.earliestAt.toISOString()}`);
        }
        if (summary.latestAt) {
            lines.push(`Covers to: ${summary.latestAt.toISOString()}`);
        }
        lines.push("");
        lines.push("-- Content --");
        lines.push(summary.content);
        if (summary.parentIds.length > 0) {
            lines.push("");
            lines.push("-- Parent summaries --");
            summary.parentIds.forEach((id) => lines.push(`  - ${this.formatId(id)}`));
        }
        if (summary.childIds.length > 0) {
            lines.push("");
            lines.push("-- Child summaries --");
            summary.childIds.forEach((id) => lines.push(`  - ${this.formatId(id)}`));
        }
        if (summary.messageIds.length > 0) {
            lines.push("");
            lines.push(`-- Source messages (${summary.messageIds.length}) --`);
            summary.messageIds.forEach((id) => lines.push(`  - message_${id}`));
        }
        return lines.join("\n");
    }
    /**
     * Generate an ASCII tree of the summary subtree
     */
    generateTree(subtree) {
        const lines = [];
        for (const node of subtree) {
            const indent = "  ".repeat(node.depthFromRoot);
            const prefix = node.depthFromRoot > 0 ? "├─ " : "";
            const kindMarker = node.kind === "leaf" ? "🍃" : "📦";
            const tokenInfo = `(${node.tokenCount} tokens, ${node.descendantCount} descendants)`;
            lines.push(`${indent}${prefix}${kindMarker} ${this.formatId(node.summaryId)} ${tokenInfo}`);
        }
        return lines.join("\n");
    }
    /**
     * Format a summary ID for display
     */
    formatId(id) {
        if (!id)
            return "unknown";
        return id;
    }
}
/**
 * Tool definition for Claude Code CLI
 */
export async function createCodeMemoryDescribeTool(conversationStore, summaryStore, deps) {
    const tool = new CodeMemoryDescribeTool(conversationStore, summaryStore, deps);
    return {
        name: "codememory_describe",
        description: "Describe a summary or file from the conversation history",
        params: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description: "ID of the summary or file to describe (e.g., leaf-... or cond-...)",
                },
            },
            required: ["id"],
        },
        async call(params) {
            return tool.describe(params);
        },
    };
}
//# sourceMappingURL=codememory-describe-tool.js.map