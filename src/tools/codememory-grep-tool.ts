/**
 * CodeMemory for Claude Code - Grep Tool
 *
 * Search tool for conversation history and summaries.
 *
 * Exactly matches CodeMemory's `codememory_grep` tool implementation.
 */

import type { ConversationStore } from "../store/conversation-store.js";
import type { SummaryStore } from "../store/summary-store.js";
import type { CodeMemoryDependencies } from "../types.js";
import type { MessageSearchResult } from "../retrieval.js";
import type { SummarySearchResult } from "../retrieval.js";
import { RetrievalEngine } from "../retrieval.js";

export interface CodeMemoryGrepParams {
  /** Search query text */
  query: string;

  /** Search mode: "regex" or "full_text" (case-insensitive) */
  mode: "regex" | "full_text";

  /** Search scope: "messages", "summaries", or "both" */
  scope: "messages" | "summaries" | "both";

  /** Limit search to specific conversation */
  conversationId?: number;

  /** Search only messages since this time */
  since?: Date;

  /** Search only messages before this time */
  before?: Date;

  /** Max number of results to return */
  limit?: number;
}

export interface CodeMemoryGrepResult {
  /** Matching messages */
  messages: Array<{
    id: number;
    conversationId: number;
    role: string;
    content: string;
    tokenCount: number;
    createdAt: Date;
  }>;

  /** Matching summaries */
  summaries: Array<{
    id: string;
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
    createdAt: Date;
    depth: number;
    descendantCount: number;
  }>;

  /** Total number of matches */
  totalMatches: number;

  /** Search mode used */
  mode: "regex" | "full_text";

  /** Search scope used */
  scope: "messages" | "summaries" | "both";
}

export class CodeMemoryGrepTool {
  private retrieval: RetrievalEngine;

  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private deps: CodeMemoryDependencies
  ) {
    this.retrieval = new RetrievalEngine(conversationStore, summaryStore);
  }

  /**
   * Execute search
   */
  async grep(params: CodeMemoryGrepParams): Promise<CodeMemoryGrepResult> {
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
  createPreview(content: string, query: string, contextChars: number = 100): string {
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
  getSuggestions(query: string): string[] {
    const suggestions: string[] = [];

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
export async function createCodeMemoryGrepTool(
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
    async call(params: CodeMemoryGrepParams) {
      return tool.grep(params);
    },
  };
}
