/**
 * CodeMemory for Claude Code - Conversation and Message Storage
 *
 * Manages conversations and message storage in SQLite.
 */
export class ConversationStore {
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
    async getOrCreateConversation(params) {
        const normalizedSessionId = params.sessionId?.trim();
        const normalizedSessionKey = params.sessionKey?.trim();
        if (!normalizedSessionId && !normalizedSessionKey) {
            throw new Error("Either sessionId or sessionKey is required");
        }
        let existing = null;
        if (normalizedSessionId) {
            existing = await this.db.get("SELECT * FROM conversations WHERE sessionId = ?", normalizedSessionId);
        }
        if (!existing && normalizedSessionKey) {
            existing = await this.db.get("SELECT * FROM conversations WHERE sessionKey = ?", normalizedSessionKey);
        }
        if (existing) {
            return existing;
        }
        const now = new Date().toISOString();
        const result = await this.db.run(`
      INSERT INTO conversations (sessionId, sessionKey, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
    `, [
            normalizedSessionId || null,
            normalizedSessionKey || null,
            now,
            now
        ]);
        return {
            conversationId: result.lastID,
            sessionId: normalizedSessionId || "",
            sessionKey: normalizedSessionKey || "",
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now
        };
    }
    async getConversationForSession(params) {
        if (params.sessionKey) {
            const record = await this.db.get("SELECT * FROM conversations WHERE sessionKey = ?", params.sessionKey);
            if (record)
                return record;
        }
        if (params.sessionId) {
            const record = await this.db.get("SELECT * FROM conversations WHERE sessionId = ?", params.sessionId);
            if (record)
                return record;
        }
        return null;
    }
    async insertMessage(params) {
        const now = new Date().toISOString();
        const maxSeqResult = await this.db.get("SELECT MAX(seq) as maxSeq FROM conversation_messages WHERE conversationId = ?", params.conversationId);
        // Use ?? not || here: maxSeq=0 must be treated as "first message exists",
        // not "no messages yet". The previous `||` collapsed both cases and made
        // every row keep seq=0, breaking intra-conversation ordering.
        const seq = (maxSeqResult?.maxSeq ?? -1) + 1;
        const tier = params.tier ?? "S";
        const tagsJson = params.tags && params.tags.length > 0 ? JSON.stringify(params.tags) : null;
        const result = await this.db.run(`
      INSERT INTO conversation_messages (
        conversationId, seq, role, content, tokenCount, createdAt, tier, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            params.conversationId, seq, params.role, params.content,
            params.tokenCount, now, tier, tagsJson
        ]);
        const messageId = result.lastID;
        for (const part of params.parts) {
            await this.db.run(`
        INSERT INTO message_parts (
          messageId, partType, textContent, metadata
        ) VALUES (?, ?, ?, ?)
      `, [
                messageId, part.partType, part.textContent || null,
                part.metadata || null
            ]);
        }
        return {
            messageId,
            conversationId: params.conversationId,
            seq,
            role: params.role,
            content: params.content,
            tokenCount: params.tokenCount,
            createdAt: now
        };
    }
    async getMessage(messageId) {
        return this.db.get("SELECT * FROM conversation_messages WHERE messageId = ?", messageId);
    }
    async getMessageParts(messageId) {
        return this.db.all("SELECT * FROM message_parts WHERE messageId = ? ORDER BY partId", messageId);
    }
    async getMessagesByConversation(conversationId) {
        return this.db.all(`
      SELECT * FROM conversation_messages
      WHERE conversationId = ?
      ORDER BY seq
    `, conversationId);
    }
    async markConversationBootstrapped(conversationId) {
        await this.db.run("UPDATE conversations SET bootstrappedAt = ?, updatedAt = ? WHERE conversationId = ?", [new Date().toISOString(), new Date().toISOString(), conversationId]);
    }
    async searchMessages(input) {
        let sql = "SELECT * FROM conversation_messages";
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
        return records.map(record => ({
            messageId: record.messageId,
            conversationId: record.conversationId,
            role: record.role,
            content: record.content,
            tokenCount: record.tokenCount,
            tags: parseTags(record.tags),
            createdAt: new Date(record.createdAt),
        }));
    }
    async getMessageById(messageId) {
        return this.db.get("SELECT * FROM conversation_messages WHERE messageId = ?", messageId);
    }
    async getMessageCount(conversationId) {
        const result = await this.db.get("SELECT COUNT(*) as count FROM conversation_messages WHERE conversationId = ?", conversationId);
        return result?.count ?? 0;
    }
    async withTransaction(operation) {
        try {
            await this.db.run("BEGIN TRANSACTION");
            const result = await operation();
            await this.db.run("COMMIT");
            return result;
        }
        catch (error) {
            await this.db.run("ROLLBACK");
            throw error;
        }
    }
}
function parseTags(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=conversation-store.js.map