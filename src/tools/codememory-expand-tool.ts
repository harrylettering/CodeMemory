/**
 * CodeMemory for Claude Code - Expand Tool
 *
 * Tool for low-level summary expansion.
 *
 * Exactly matches CodeMemory's `codememory_expand` tool implementation.
 */

import type { ConversationStore } from "../store/conversation-store.js";
import type { SummaryStore } from "../store/summary-store.js";
import type { CodeMemoryDependencies } from "../types.js";
import type { ExpandParams, ExpandResult } from "../expansion.js";
import { CodeMemoryExpansionEngine } from "../expansion.js";

export interface CodeMemoryExpandParams {
  /** ID of the summary to expand */
  summaryId: string;

  /** Max traversal depth */
  depth?: number;

  /** Include raw source messages at leaf level */
  includeMessages?: boolean;

  /** Max tokens to return before truncating */
  tokenCap?: number;

  /** Runtime context for debugging */
  runtimeContext?: Record<string, unknown>;
}

export interface CodeMemoryExpandResult {
  /** Whether the requested root summary exists */
  found?: boolean;
  /** Machine-readable reason when found=false */
  reason?: string;

  /** Child summaries found */
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;

  /** Source messages (only if includeMessages=true and hitting leaf summaries) */
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;

  /** Total estimated tokens in result */
  estimatedTokens: number;

  /** Whether result was truncated due to tokenCap */
  truncated: boolean;

  /** Runtime context for debugging */
  runtimeContext?: Record<string, unknown>;
}

export class CodeMemoryExpandTool {
  private expansionEngine: CodeMemoryExpansionEngine;

  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private deps: CodeMemoryDependencies
  ) {
    this.expansionEngine = new CodeMemoryExpansionEngine(conversationStore, summaryStore);
  }

  /**
   * Perform expansion
   */
  async expand(input: CodeMemoryExpandParams): Promise<CodeMemoryExpandResult> {
    const params: ExpandParams = {
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
  formatResult(result: CodeMemoryExpandResult): string {
    const lines: string[] = [];

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
  private createPreview(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) {
      return text;
    }

    const trimmed = text.slice(0, maxLength).trim();
    return trimmed.endsWith(".") ? `${trimmed}...` : `${trimmed}...`;
  }

  /**
   * Create a markdown-formatted version of the result
   */
  formatMarkdown(result: CodeMemoryExpandResult): string {
    const lines: string[] = [];

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
export async function createCodeMemoryExpandTool(
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  deps: CodeMemoryDependencies
): Promise<{
  name: string;
  description: string;
  params: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
  call: (params: any) => Promise<any>;
}> {
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
    async call(params: CodeMemoryExpandParams) {
      return tool.expand(params);
    },
  };
}
