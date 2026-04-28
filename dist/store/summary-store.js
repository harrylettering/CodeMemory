/**
 * CodeMemory for Claude Code - Summary DAG Storage
 *
 * Manages summary DAG storage and context item management in SQLite.
 */
export class SummaryStore {
    db;
    fts5Available;
    constructor(db, fts5Available = false) {
        this.db = db;
        this.fts5Available = fts5Available;
    }
    /** Access raw database connection for compaction use */
    getDatabase() {
        return this.db;
    }
    async getConversationBootstrapState(conversationId) {
        return this.db.get("SELECT * FROM conversation_bootstrap_state WHERE conversationId = ?", conversationId);
    }
    async upsertConversationBootstrapState(params) {
        const existing = await this.db.get("SELECT conversationId FROM conversation_bootstrap_state WHERE conversationId = ?", params.conversationId);
        if (existing) {
            await this.db.run(`
        UPDATE conversation_bootstrap_state
        SET sessionFilePath = ?, lastSeenSize = ?, lastSeenMtimeMs = ?,
            lastProcessedOffset = ?, lastProcessedEntryHash = ?
        WHERE conversationId = ?
      `, [
                params.sessionFilePath, params.lastSeenSize, params.lastSeenMtimeMs,
                params.lastProcessedOffset, params.lastProcessedEntryHash, params.conversationId
            ]);
        }
        else {
            await this.db.run(`
        INSERT INTO conversation_bootstrap_state (
          conversationId, sessionFilePath, lastSeenSize, lastSeenMtimeMs,
          lastProcessedOffset, lastProcessedEntryHash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
                params.conversationId, params.sessionFilePath, params.lastSeenSize,
                params.lastSeenMtimeMs, params.lastProcessedOffset, params.lastProcessedEntryHash
            ]);
        }
    }
    async getContextItems(conversationId) {
        return this.db.all(`
      SELECT * FROM conversation_context
      WHERE conversationId = ?
      ORDER BY ordinal
    `, conversationId);
    }
    async appendContextMessages(conversationId, messageIds) {
        const currentItems = await this.getContextItems(conversationId);
        let nextOrdinal = currentItems.length > 0
            ? Math.max(...currentItems.map(item => item.ordinal)) + 1
            : 0;
        for (const messageId of messageIds) {
            await this.db.run(`
        INSERT INTO conversation_context (conversationId, ordinal, itemType, messageId, summaryId)
        VALUES (?, ?, ?, ?, NULL)
      `, [conversationId, nextOrdinal, "message", messageId]);
            nextOrdinal++;
        }
    }
    async replaceContextItems(conversationId, items) {
        await this.db.run("DELETE FROM conversation_context WHERE conversationId = ?", conversationId);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            await this.db.run(`
        INSERT INTO conversation_context (conversationId, ordinal, itemType, messageId, summaryId)
        VALUES (?, ?, ?, ?, ?)
      `, [
                conversationId, i, item.itemType,
                item.messageId || null, item.summaryId || null
            ]);
        }
    }
    async getSummary(summaryId) {
        return this.db.get("SELECT * FROM summaries WHERE summaryId = ?", summaryId);
    }
    async getConversationMaxSummaryDepth(conversationId) {
        const result = await this.db.get("SELECT MAX(depth) as maxDepth FROM summaries WHERE conversationId = ?", conversationId);
        return result?.maxDepth ?? -1;
    }
    async searchSummaries(input) {
        let sql = "SELECT * FROM summaries";
        const params = [];
        const conditions = [];
        if (input.conversationId) {
            conditions.push("conversationId = ?");
            params.push(input.conversationId);
        }
        if (input.since) {
            conditions.push("createdAt >= ?");
            params.push(input.since.toISOString());
        }
        if (input.before) {
            conditions.push("createdAt < ?");
            params.push(input.before.toISOString());
        }
        if (input.mode === "full_text") {
            conditions.push("content LIKE ?");
            params.push(`%${input.query}%`);
        }
        else if (input.mode === "regex") {
            conditions.push("content REGEXP ?");
            params.push(input.query);
        }
        if (conditions.length > 0) {
            sql += " WHERE " + conditions.join(" AND ");
        }
        sql += " ORDER BY createdAt DESC";
        if (typeof input.limit === "number" && input.limit > 0) {
            sql += " LIMIT ?";
            params.push(input.limit);
        }
        const records = await this.db.all(sql, params);
        return records.map((record) => ({
            summaryId: record.summaryId,
            conversationId: record.conversationId,
            kind: record.kind,
            content: record.content,
            tokenCount: record.tokenCount,
            createdAt: new Date(record.createdAt),
            depth: record.depth,
            descendantCount: record.descendantCount,
            sourceMessageTokenCount: 0,
        }));
    }
    async getSummaryParents(summaryId) {
        const records = await this.db.all(`
      SELECT s.* FROM summaries s
      JOIN summary_parents sp ON s.summaryId = sp.parentSummaryId
      WHERE sp.summaryId = ?
    `, summaryId);
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
    async getSummaryChildren(summaryId) {
        const records = await this.db.all(`
      SELECT s.* FROM summaries s
      JOIN summary_parents sp ON s.summaryId = sp.summaryId
      WHERE sp.parentSummaryId = ?
    `, summaryId);
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
    async getSummaryMessages(summaryId) {
        const records = await this.db.all("SELECT messageId FROM summary_messages WHERE summaryId = ?", summaryId);
        return records.map((record) => record.messageId);
    }
    async getSummarySubtree(summaryId) {
        const result = await this.db.get("SELECT * FROM summaries WHERE summaryId = ?", summaryId);
        if (!result)
            return [];
        return [
            {
                summaryId: result.summaryId,
                parentSummaryId: null,
                depthFromRoot: 0,
                kind: result.kind,
                depth: result.depth,
                tokenCount: result.tokenCount,
                descendantCount: result.descendantCount,
                sourceMessageTokenCount: 0,
                earliestAt: result.earliestAt,
                latestAt: result.latestAt,
                childCount: 0,
                path: result.summaryId,
            },
        ];
    }
    async getLeafSummaryLinksForMessageIds(conversationId, messageIds) {
        if (messageIds.length === 0)
            return [];
        const placeholders = messageIds.map(() => "?").join(",");
        return this.db.all(`
      SELECT DISTINCT sm.summaryId, sm.messageId
      FROM summary_messages sm
      JOIN summaries s ON sm.summaryId = s.summaryId
      WHERE s.conversationId = ? AND s.kind = 'leaf'
        AND sm.messageId IN (${placeholders})
    `, [conversationId, ...messageIds]);
    }
}
//# sourceMappingURL=summary-store.js.map