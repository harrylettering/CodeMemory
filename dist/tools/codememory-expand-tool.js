/**
 * CodeMemory for Claude Code - Expand Tool
 *
 * Tool for low-level summary expansion.
 *
 * Exactly matches CodeMemory's `codememory_expand` tool implementation.
 */
import { CodeMemoryExpansionEngine } from "../expansion.js";
export class CodeMemoryExpandTool {
    conversationStore;
    summaryStore;
    deps;
    expansionEngine;
    constructor(conversationStore, summaryStore, deps) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.deps = deps;
        this.expansionEngine = new CodeMemoryExpansionEngine(conversationStore, summaryStore);
    }
    /**
     * Perform expansion
     */
    async expand(input) {
        const params = {
            summaryId: input.summaryId,
            depth: input.depth ?? 1,
            includeMessages: input.includeMessages ?? true,
            tokenCap: input.tokenCap ?? this.deps.config.maxExpandTokens,
        };
        const result = await this.expansionEngine.expand(params);
        return {
            ...result,
            runtimeContext: input.runtimeContext,
        };
    }
    /**
     * Format expansion result for display
     */
    formatResult(result) {
        const lines = [];
        lines.push(`=== Expansion Result ===`);
        lines.push(`Estimated tokens: ${result.estimatedTokens}`);
        lines.push(`Truncated: ${result.truncated}`);
        lines.push(`Children: ${result.children.length}`);
        lines.push(`Messages: ${result.messages.length}`);
        lines.push("");
        if (result.children.length > 0) {
            lines.push(`--- Summary Children ---`);
            for (const child of result.children) {
                const preview = this.createPreview(child.content);
                lines.push(`\n${child.summaryId} (${child.kind}, ${child.tokenCount} tokens)`);
                lines.push(`Preview: ${preview}`);
            }
        }
        if (result.messages.length > 0) {
            lines.push("\n--- Source Messages ---");
            for (const msg of result.messages) {
                const preview = this.createPreview(msg.content);
                lines.push(`\n${msg.role}: (${msg.tokenCount} tokens)`);
                lines.push(`Preview: ${preview}`);
            }
        }
        return lines.join("\n");
    }
    /**
     * Create a text preview
     */
    createPreview(text, maxLength = 100) {
        if (text.length <= maxLength) {
            return text;
        }
        const trimmed = text.slice(0, maxLength).trim();
        return trimmed.endsWith(".") ? `${trimmed}...` : `${trimmed}...`;
    }
    /**
     * Create a markdown-formatted version of the result
     */
    formatMarkdown(result) {
        const lines = [];
        lines.push(`# Expansion Result`);
        lines.push(`**Estimated tokens:** ${result.estimatedTokens}`);
        lines.push(`**Truncated:** ${result.truncated}`);
        lines.push(`**Children:** ${result.children.length}`);
        lines.push(`**Messages:** ${result.messages.length}`);
        if (result.children.length > 0) {
            lines.push(`\n## Summary Children (${result.children.length})`);
            lines.push("\n| Summary ID | Kind | Token Count | Preview |");
            lines.push("|------------|------|-------------|---------|");
            for (const child of result.children) {
                const preview = this.createPreview(child.content, 80);
                lines.push(`| ${child.summaryId} | ${child.kind} | ${child.tokenCount} | ${preview} |`);
            }
        }
        if (result.messages.length > 0) {
            lines.push(`\n## Source Messages (${result.messages.length})`);
            lines.push("\n| Role | Token Count | Preview |");
            lines.push("|------|-------------|---------|");
            for (const msg of result.messages) {
                const preview = this.createPreview(msg.content, 80);
                lines.push(`| ${msg.role} | ${msg.tokenCount} | ${preview} |`);
            }
        }
        return lines.join("\n");
    }
}
/**
 * Tool definition for Claude Code CLI
 */
export async function createCodeMemoryExpandTool(conversationStore, summaryStore, deps) {
    const tool = new CodeMemoryExpandTool(conversationStore, summaryStore, deps);
    return {
        name: "codememory_expand",
        description: "Expand a summary to see its children or source messages (low-level, sub-agent only)",
        params: {
            type: "object",
            properties: {
                summaryId: {
                    type: "string",
                    description: "ID of the summary to expand",
                },
                depth: {
                    type: "number",
                    description: "Max traversal depth (default: 1)",
                },
                includeMessages: {
                    type: "boolean",
                    description: "Include raw source messages at leaf level",
                },
                tokenCap: {
                    type: "number",
                    description: "Max tokens to return before truncating",
                },
            },
            required: ["summaryId"],
        },
        async call(params) {
            return tool.expand(params);
        },
    };
}
//# sourceMappingURL=codememory-expand-tool.js.map