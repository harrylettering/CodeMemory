/**
 * CodeMemory for Claude Code - Expansion Core
 *
 * DAG expansion orchestration and summary traversal logic.
 */

import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./store/summary-store.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { MessageRecord } from "./store/conversation-store.js";

export interface ExpandParams {
  /** Summary to expand */
  summaryId: string;

  /** Max traversal depth (default 1) */
  depth?: number;

  /** Include raw source messages at leaf level */
  includeMessages?: boolean;

  /** Max tokens to return before truncating */
  tokenCap?: number;
}

export interface ExpandResult {
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
}

/**
 * Estimate token count for a string
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export class CodeMemoryExpansionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore
  ) {}

  async expand(input: ExpandParams): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Infinity;

    const root = await this.summaryStore.getSummary(input.summaryId);
    const result: ExpandResult = {
      found: !!root,
      reason: root ? undefined : "summary_not_found",
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    if (!root) {
      return result;
    }

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);

    return result;
  }

  private async expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: ExpandResult
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }

    if (result.truncated) {
      return;
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return;
    }

    if (summary.kind === "condensed") {
      const children = await this.summaryStore.getSummaryChildren(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }

        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });

        result.estimatedTokens += child.tokenCount;

        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);

      for (const msgId of messageIds) {
        if (result.truncated) {
          break;
        }

        const msg = await this.conversationStore.getMessageById(msgId);
        if (!msg) {
          continue;
        }

        const tokenCount = msg.tokenCount || estimateTokens(msg.content);

        if (result.estimatedTokens + tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          tokenCount,
        });

        result.estimatedTokens += tokenCount;
      }
    }
  }

  /**
   * Get a flattened tree of all expandable content
   */
  async getExpansionTree(summaryId: string, maxDepth: number = 3): Promise<any[]> {
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return [];
    }

    const tree: any[] = [{
      summaryId: summary.summaryId,
      kind: summary.kind,
      depth: summary.depth,
      content: summary.content,
      tokenCount: summary.tokenCount,
      children: await this.getChildren(summaryId, maxDepth - 1),
    }];

    return tree;
  }

  private async getChildren(summaryId: string, remainingDepth: number): Promise<any[]> {
    if (remainingDepth <= 0) {
      return [];
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary || summary.kind === "leaf") {
      return [];
    }

    const children = await this.summaryStore.getSummaryChildren(summaryId);

    return Promise.all(
      children.map(async (child) => ({
        summaryId: child.summaryId,
        kind: child.kind,
        depth: child.depth,
        content: child.content,
        tokenCount: child.tokenCount,
        children: await this.getChildren(child.summaryId, remainingDepth - 1),
      }))
    );
  }

  /**
   * Calculate total token budget required to expand a summary
   */
  async calculateExpansionTokenBudget(
    summaryId: string,
    includeMessages: boolean = false,
    maxDepth: number = Infinity
  ): Promise<number> {
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return 0;
    }

    let total = summary.tokenCount;

    if (summary.kind === "condensed" && maxDepth > 0) {
      const children = await this.summaryStore.getSummaryChildren(summaryId);

      for (const child of children) {
        total += await this.calculateExpansionTokenBudget(
          child.summaryId,
          includeMessages,
          maxDepth - 1
        );
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);
      const messages = await Promise.all(
        messageIds.map((msgId) => this.conversationStore.getMessageById(msgId))
      );

      const validMessages = messages.filter((msg) => msg !== null);
      total += validMessages.reduce((sum, msg) => sum + (msg.tokenCount || 0), 0);
    }

    return total;
  }

  /**
   * Check if expanding a summary will fit within a token budget
   */
  async willExpansionFit(
    summaryId: string,
    tokenBudget: number,
    includeMessages: boolean = false,
    maxDepth: number = Infinity
  ): Promise<{ fits: boolean; estimatedTokens: number }> {
    const estimated = await this.calculateExpansionTokenBudget(summaryId, includeMessages, maxDepth);

    return {
      fits: estimated <= tokenBudget,
      estimatedTokens: estimated,
    };
  }
}
