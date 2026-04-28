/**
 * Lossless Claw for Claude Code - Compaction Engine
 *
 * Implements leaf compaction and condensation with three-level escalation.
 *
 * Exactly matches Lossless Claw's compaction algorithm.
 */
import { LcmSummarizer } from "./summarize.js";
/**
 * Token thresholds for compaction decisions
 */
const COMPACTION_THRESHOLDS = {
    LEAF_TRIGGER: 2000,
    LEAF_CAP: 1500,
    CONDENSE_TRIGGER: 3000,
    CONDENSE_CAP: 2000,
};
/**
 * Generate unique summary ID
 */
function generateSummaryId() {
    return `sum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export class LcmCompactionEngine {
    conversationStore;
    summaryStore;
    deps;
    summarizer;
    constructor(conversationStore, summaryStore, deps) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.deps = deps;
        this.summarizer = new LcmSummarizer(deps);
    }
    async compact(params) {
        try {
            // Get conversation from params
            let conversationId = null;
            if (params.sessionId || params.sessionKey) {
                const conversation = await this.conversationStore.getConversationForSession({
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                });
                if (conversation) {
                    conversationId = conversation.conversationId;
                }
            }
            if (!conversationId) {
                return {
                    actionTaken: false,
                    tokensBefore: 0,
                    tokensAfter: 0,
                    condensed: false,
                };
            }
            // Find compaction candidates
            const candidates = await this.findCompactionCandidates(conversationId);
            if (candidates.leafCandidates.length > 0) {
                // Perform leaf compaction on first candidate group
                const firstCandidate = candidates.leafCandidates[0];
                const result = await this.performLeafCompaction(conversationId, firstCandidate, COMPACTION_THRESHOLDS.LEAF_CAP);
                if (result.actionTaken) {
                    await this.updateContextItemsForLeafCompaction(conversationId, firstCandidate, result.createdSummaryId);
                    return result;
                }
            }
            else if (candidates.condensationCandidates.length > 0) {
                // Perform condensation on first candidate group
                const firstCandidate = candidates.condensationCandidates[0];
                const result = await this.performCondensation(conversationId, firstCandidate, COMPACTION_THRESHOLDS.CONDENSE_CAP);
                if (result.actionTaken) {
                    // Update context items to replace child summaries with new condensed summary
                    await this.updateContextItemsForCondensation(conversationId, firstCandidate, result.createdSummaryId);
                    return result;
                }
            }
            return {
                actionTaken: false,
                tokensBefore: 0,
                tokensAfter: 0,
                condensed: false,
            };
        }
        catch (error) {
            this.deps.log.error(`Compaction failed: ${error}`);
            return {
                actionTaken: false,
                tokensBefore: 0,
                tokensAfter: 0,
                condensed: false,
            };
        }
    }
    /**
     * Perform leaf compaction on a conversation
     *
     * Leaf compaction: Replace a group of messages with a single leaf summary
     */
    async performLeafCompaction(conversationId, messageIds, maxTokens) {
        const messages = await Promise.all(messageIds.map((msgId) => this.conversationStore.getMessage(msgId)));
        const validMessages = messages.filter((msg) => msg !== null);
        if (validMessages.length === 0) {
            return {
                actionTaken: false,
                tokensBefore: 0,
                tokensAfter: 0,
                condensed: false,
            };
        }
        const contentToSummarize = validMessages
            .map((msg) => `[${msg.role.toUpperCase()}]: ${msg.content}`)
            .join("\n\n");
        // Generate summary
        const summaryResult = await this.summarizer.createLeafSummary(contentToSummarize, maxTokens);
        const summaryId = generateSummaryId();
        // Create summary record
        await this.summaryStore.getDatabase().run(`
      INSERT INTO summaries (
        summaryId, conversationId, kind, depth, earliestAt, latestAt,
        descendantCount, tokenCount, content, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            summaryId,
            conversationId,
            "leaf",
            0,
            validMessages[0].createdAt,
            validMessages[validMessages.length - 1].createdAt,
            validMessages.length,
            summaryResult.tokenCount,
            summaryResult.content,
            new Date().toISOString(),
        ]);
        // Create summary-message links
        for (let i = 0; i < validMessages.length; i++) {
            await this.summaryStore.getDatabase().run(`
        INSERT INTO summary_messages (summaryId, messageId, position)
        VALUES (?, ?, ?)
      `, [summaryId, validMessages[i].messageId, i]);
        }
        return {
            actionTaken: true,
            tokensBefore: this.calculateTotalTokens(validMessages),
            tokensAfter: summaryResult.tokenCount,
            createdSummaryId: summaryId,
            condensed: false,
            level: "leaf",
        };
    }
    /**
     * Perform condensation (combine lower-level summaries)
     *
     * Condensation: Replace a group of summaries with a higher-level summary
     */
    async performCondensation(conversationId, summaryIds, maxTokens) {
        const summaries = await Promise.all(summaryIds.map((sumId) => this.summaryStore.getSummary(sumId)));
        const validSummaries = summaries.filter((sum) => sum !== null);
        if (validSummaries.length === 0) {
            return {
                actionTaken: false,
                tokensBefore: 0,
                tokensAfter: 0,
                condensed: false,
            };
        }
        const contentToSummarize = validSummaries
            .map((sum) => sum.content)
            .join("\n\n---\n\n");
        // Generate summary
        const summaryResult = await this.summarizer.createCondensedSummary(validSummaries.map((sum) => sum.content), maxTokens);
        const summaryId = generateSummaryId();
        const maxDepth = validSummaries.reduce((max, sum) => Math.max(max, sum.depth), 0);
        // Create summary record
        await this.summaryStore.getDatabase().run(`
      INSERT INTO summaries (
        summaryId, conversationId, kind, depth, earliestAt, latestAt,
        descendantCount, tokenCount, content, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            summaryId,
            conversationId,
            "condensed",
            maxDepth + 1,
            validSummaries[0].earliestAt,
            validSummaries[validSummaries.length - 1].latestAt,
            validSummaries.reduce((sum, s) => sum + s.descendantCount, 0),
            summaryResult.tokenCount,
            summaryResult.content,
            new Date().toISOString(),
        ]);
        // Create parent-child relationships
        for (let i = 0; i < validSummaries.length; i++) {
            await this.summaryStore.getDatabase().run(`
        INSERT INTO summary_parents (summaryId, parentSummaryId, position)
        VALUES (?, ?, ?)
      `, [summaryId, validSummaries[i].summaryId, i]);
        }
        return {
            actionTaken: true,
            tokensBefore: validSummaries.reduce((sum, s) => sum + s.tokenCount, 0),
            tokensAfter: summaryResult.tokenCount,
            createdSummaryId: summaryId,
            condensed: true,
            level: "condensed",
        };
    }
    /**
     * Calculate total token count of messages
     */
    calculateTotalTokens(messages) {
        return messages.reduce((sum, msg) => sum + msg.tokenCount, 0);
    }
    /**
     * Find compaction candidates in a conversation
     */
    async findCompactionCandidates(conversationId) {
        const messages = await this.conversationStore.getMessagesByConversation(conversationId);
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        const summaries = await this.getConversationSummaries(conversationId);
        const leafCandidates = [];
        const condensationCandidates = [];
        // Leaf compaction candidates: find groups of messages exceeding LEAF_TRIGGER
        let currentGroup = [];
        let currentTokens = 0;
        for (const msg of messages) {
            currentTokens += msg.tokenCount;
            currentGroup.push(msg.messageId);
            if (currentTokens > COMPACTION_THRESHOLDS.LEAF_TRIGGER) {
                leafCandidates.push([...currentGroup]);
                currentGroup = [];
                currentTokens = 0;
            }
        }
        // Condensation candidates: find groups of summaries exceeding CONDENSE_TRIGGER
        const condensedSummaries = summaries.filter((s) => s.kind === "condensed");
        const leafSummaries = summaries.filter((s) => s.kind === "leaf");
        // Check if we should condense leaf summaries
        if (leafSummaries.length > 0) {
            let totalTokens = leafSummaries.reduce((sum, s) => sum + s.tokenCount, 0);
            if (totalTokens > COMPACTION_THRESHOLDS.CONDENSE_TRIGGER) {
                condensationCandidates.push(leafSummaries.map((s) => s.summaryId));
            }
        }
        // Check if we should condense condensed summaries
        if (condensedSummaries.length > 0) {
            let totalTokens = condensedSummaries.reduce((sum, s) => sum + s.tokenCount, 0);
            if (totalTokens > COMPACTION_THRESHOLDS.CONDENSE_TRIGGER) {
                condensationCandidates.push(condensedSummaries.map((s) => s.summaryId));
            }
        }
        return {
            leafCandidates,
            condensationCandidates,
        };
    }
    /**
     * Update context items after leaf compaction
     */
    async updateContextItemsForLeafCompaction(conversationId, messageIds, summaryId) {
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        // Find context items for the messages
        const itemsToRemove = contextItems
            .filter((item) => item.itemType === "message" && messageIds.includes(item.messageId));
        if (itemsToRemove.length === 0) {
            return;
        }
        const earliestPosition = Math.min(...itemsToRemove.map((item) => item.ordinal));
        // Remove old message items
        const itemIdsToRemove = itemsToRemove.map((item) => item.contextItemId);
        for (const itemId of itemIdsToRemove) {
            await this.summaryStore.getDatabase().run("DELETE FROM conversation_context WHERE contextItemId = ?", itemId);
        }
        // Add new summary item at earliest position
        await this.summaryStore.getDatabase().run(`
      INSERT INTO conversation_context (
        conversationId, ordinal, itemType, messageId, summaryId
      ) VALUES (?, ?, ?, ?, ?)
    `, [conversationId, earliestPosition, "summary", null, summaryId]);
        // Re-balance ordinals for consistency
        await this.rebalanceContextItemOrdinals(conversationId);
    }
    /**
     * Update context items after condensation
     */
    async updateContextItemsForCondensation(conversationId, summaryIds, newSummaryId) {
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        // Find context items for the summaries
        const itemsToRemove = contextItems
            .filter((item) => item.itemType === "summary" && summaryIds.includes(item.summaryId));
        if (itemsToRemove.length === 0) {
            return;
        }
        const earliestPosition = Math.min(...itemsToRemove.map((item) => item.ordinal));
        // Remove old summary items
        const itemIdsToRemove = itemsToRemove.map((item) => item.contextItemId);
        for (const itemId of itemIdsToRemove) {
            await this.summaryStore.getDatabase().run("DELETE FROM conversation_context WHERE contextItemId = ?", itemId);
        }
        // Add new condensed summary item
        await this.summaryStore.getDatabase().run(`
      INSERT INTO conversation_context (
        conversationId, ordinal, itemType, messageId, summaryId
      ) VALUES (?, ?, ?, ?, ?)
    `, [conversationId, earliestPosition, "summary", null, newSummaryId]);
        // Re-balance ordinals for consistency
        await this.rebalanceContextItemOrdinals(conversationId);
    }
    /**
     * Re-balance ordinals of context items to be consecutive starting from 0
     */
    async rebalanceContextItemOrdinals(conversationId) {
        const items = await this.summaryStore.getContextItems(conversationId);
        // Sort by current ordinal and reassign
        const sortedItems = [...items].sort((a, b) => a.ordinal - b.ordinal);
        for (let i = 0; i < sortedItems.length; i++) {
            await this.summaryStore.getDatabase().run("UPDATE conversation_context SET ordinal = ? WHERE contextItemId = ?", [i, sortedItems[i].contextItemId]);
        }
    }
    /**
     * Get all summaries for a conversation
     */
    async getConversationSummaries(conversationId) {
        const records = await this.summaryStore.getDatabase().all(`
      SELECT * FROM summaries WHERE conversationId = ?
    `, conversationId);
        return records.map((record) => ({
            summaryId: record.summaryId,
            conversationId: record.conversationId,
            kind: record.kind,
            depth: record.depth,
            earliestAt: record.earliestAt,
            latestAt: record.latestAt,
            descendantCount: record.descendantCount,
            tokenCount: record.tokenCount,
            content: record.content,
            createdAt: record.createdAt,
        }));
    }
}
//# sourceMappingURL=compaction.js.map