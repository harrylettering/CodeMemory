/**
 * CodeMemory for Claude Code - Describe Tool
 *
 * Tool for describing summaries and their relationships.
 *
 * Exactly matches CodeMemory's `codememory_describe` tool implementation.
 */

import type { ConversationStore } from "../store/conversation-store.js";
import type { SummaryStore, SummaryRecord } from "../store/summary-store.js";
import type { CodeMemoryDependencies } from "../types.js";
import type { DescribeResult } from "../retrieval.js";
import { RetrievalEngine } from "../retrieval.js";

export interface CodeMemoryDescribeParams {
  /** ID of the summary or file to describe */
  id: string;
}

export interface CodeMemoryDescribeResult {
  /** The ID being described */
  id: string;

  /** Type of entity */
  type: "summary" | "file";

  /** Summary-specific fields */
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    createdAt: Date;
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
  };

  /** File-specific fields */
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
  };
}

export class CodeMemoryDescribeTool {
  private retrieval: RetrievalEngine;

  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private deps: CodeMemoryDependencies
  ) {
    this.retrieval = new RetrievalEngine(conversationStore, summaryStore);
  }

  /**
   * Describe a summary or file
   */
  async describe(params: CodeMemoryDescribeParams): Promise<CodeMemoryDescribeResult | null> {
    const result = await this.retrieval.describe(params.id);

    if (!result) {
      return null;
    }

    return result as CodeMemoryDescribeResult;
  }

  /**
   * Format summary content for display
   */
  formatSummaryContent(summary: NonNullable<CodeMemoryDescribeResult["summary"]>): string {
    const lines: string[] = [];

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
  generateTree(subtree: NonNullable<CodeMemoryDescribeResult["summary"]>["subtree"]): string {
    const lines: string[] = [];

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
  private formatId(id: string): string {
    if (!id) return "unknown";
    return id;
  }
}

/**
 * Tool definition for Claude Code CLI
 */
export async function createCodeMemoryDescribeTool(
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
    async call(params: CodeMemoryDescribeParams) {
      return tool.describe(params);
    },
  };
}
