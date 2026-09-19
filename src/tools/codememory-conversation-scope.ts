/**
 * CodeMemory for Claude Code - Conversation Scope Utilities
 *
 * Conversation scoping utilities for tools.
 */

import type { ConversationStore } from "../store/conversation-store.js";
import type { SummaryStore } from "../store/summary-store.js";

export interface ConversationScope {
  conversationId: number;
  sessionId?: string;
  sessionKey?: string;
  messageCount: number;
  summaryCount: number;
}

export class CodeMemoryConversationScopeUtils {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore
  ) {}

  async getScopeForSession(params: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationScope | null> {
    const conversation = await this.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });

    if (!conversation) {
      return null;
    }

    const messageCount = await this.conversationStore.getMessageCount(
      conversation.conversationId
    );

    const contextItems = await this.summaryStore.getContextItems(
      conversation.conversationId
    );

    return {
      conversationId: conversation.conversationId,
      sessionId: conversation.sessionId || undefined,
      sessionKey: conversation.sessionKey || undefined,
      messageCount,
      summaryCount: contextItems.filter((i) => i.itemType === "summary").length,
    };
  }

  async listConversations(limit?: number): Promise<Array<{
    conversationId: number;
    sessionId?: string;
    createdAt: Date;
    updatedAt: Date;
    messageCount: number;
  }>> {
    let sql = "SELECT * FROM conversations ORDER BY updatedAt DESC";
    const params: any[] = [];

    if (limit && limit > 0) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const records = await this.conversationStore.getDatabase().all(sql, ...params);

    return Promise.all(
      records.map(async (record: any) => {
        const messageCount = await this.conversationStore.getMessageCount(
          record.conversationId
        );

        return {
          conversationId: record.conversationId,
          sessionId: record.sessionId || undefined,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
          messageCount,
        };
      })
    );
  }
}

export function createConversationScopeUtils(
  conversationStore: ConversationStore,
  summaryStore: SummaryStore
): CodeMemoryConversationScopeUtils {
  return new CodeMemoryConversationScopeUtils(conversationStore, summaryStore);
}

/**
 * Resolve the live session to a conversation, for tools that must not be able
 * to read outside it.
 *
 * Injected at the wiring layer rather than accepted as a parameter: these
 * tools are model-callable, and a boundary the caller supplies is a boundary
 * the caller can drop. Unresolved yields undefined, and every caller treats
 * that as "search nothing" -- failing open is what makes a leak silent.
 */
export async function resolveLiveConversationId(
  conversationStore: { getConversationForSession: (i: { sessionId: string }) => Promise<any> },
  getCurrentSessionId?: () => string | undefined
): Promise<number | undefined> {
  const sessionId = getCurrentSessionId?.();
  if (!sessionId) return undefined;
  try {
    const conv = await conversationStore.getConversationForSession({ sessionId });
    return conv?.conversationId;
  } catch {
    return undefined;
  }
}
