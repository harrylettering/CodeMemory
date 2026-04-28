/**
 * CodeMemory for Claude Code - Conversation Scope Utilities
 *
 * Conversation scoping utilities for tools.
 */
export class LcmConversationScopeUtils {
    conversationStore;
    summaryStore;
    constructor(conversationStore, summaryStore) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
    }
    async getScopeForSession(params) {
        const conversation = await this.conversationStore.getConversationForSession({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
        });
        if (!conversation) {
            return null;
        }
        const messageCount = await this.conversationStore.getMessageCount(conversation.conversationId);
        const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
        return {
            conversationId: conversation.conversationId,
            sessionId: conversation.sessionId || undefined,
            sessionKey: conversation.sessionKey || undefined,
            messageCount,
            summaryCount: contextItems.filter((i) => i.itemType === "summary").length,
        };
    }
    async listConversations(limit) {
        let sql = "SELECT * FROM conversations ORDER BY updatedAt DESC";
        const params = [];
        if (limit && limit > 0) {
            sql += " LIMIT ?";
            params.push(limit);
        }
        const records = await this.conversationStore.getDatabase().all(sql, ...params);
        return Promise.all(records.map(async (record) => {
            const messageCount = await this.conversationStore.getMessageCount(record.conversationId);
            return {
                conversationId: record.conversationId,
                sessionId: record.sessionId || undefined,
                createdAt: new Date(record.createdAt),
                updatedAt: new Date(record.updatedAt),
                messageCount,
            };
        }));
    }
}
export function createConversationScopeUtils(conversationStore, summaryStore) {
    return new LcmConversationScopeUtils(conversationStore, summaryStore);
}
//# sourceMappingURL=lcm-conversation-scope.js.map