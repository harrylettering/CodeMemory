const TABLE_NAME = "negative_experiences";
export class SqliteNegativeExperienceStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(record) {
        const result = await this.db.run(`INSERT INTO ${TABLE_NAME} (
        conversationId, seq, tier, role, type, signature, raw, location,
        attemptedFix, resolved, resolution, resolvedAt,
        sessionId, filePath, command, symbol, messageId, weight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            record.conversationId,
            record.seq,
            record.tier,
            record.role,
            record.type,
            record.signature,
            record.raw,
            record.location || null,
            record.attemptedFix || null,
            record.resolved ? 1 : 0,
            record.resolution || null,
            record.resolvedAt || null,
            record.sessionId || null,
            record.filePath || null,
            record.command || null,
            record.symbol || null,
            record.messageId || null,
            record.weight ?? 1.0,
        ]);
        return {
            ...record,
            id: result.lastID,
        };
    }
    async getById(id) {
        return await this.db.get(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`, id);
    }
    async getByConversationAndSeq(conversationId, seq) {
        return await this.db.get(`SELECT * FROM ${TABLE_NAME} WHERE conversationId = ? AND seq = ?`, [conversationId, seq]);
    }
    async getBySignatureRange(signature, conversationId, sinceSeq = 0, limit = 10) {
        // Parameter binding handles escaping; do NOT manually replace quotes.
        return await this.db.all(`SELECT * FROM ${TABLE_NAME} WHERE conversationId = ? AND seq > ?
       AND signature LIKE ?
       ORDER BY seq DESC LIMIT ?`, [
            conversationId,
            sinceSeq,
            `%${signature}%`,
            limit,
        ]);
    }
    async markResolved(id, resolution) {
        await this.db.run(`UPDATE ${TABLE_NAME} SET resolved = 1, resolution = ?, resolvedAt = ?
       WHERE id = ?`, [resolution, Date.now(), id]);
        return await this.getById(id);
    }
    async markUnresolved(id, reason) {
        await this.db.run(`UPDATE ${TABLE_NAME} SET resolved = 0, resolution = ?, resolvedAt = NULL
       WHERE id = ?`, [`reopened: ${reason}`, id]);
        return await this.getById(id);
    }
    async autoResolveStale(conversationId, currentSeq, olderThanSeqs, resolution) {
        // An unresolved record is "stale" if (a) it's old enough and
        // (b) its signature hasn't recurred since (no later record with
        // the same signature in this conversation). We don't have a
        // separate "last seen" column so we use seq directly — there's
        // no inserts within DEDUP_SEQ_WINDOW so each row is the latest
        // occurrence in its window.
        const cutoff = currentSeq - olderThanSeqs;
        if (cutoff <= 0)
            return 0;
        const result = await this.db.run(`UPDATE ${TABLE_NAME}
         SET resolved = 1, resolution = ?, resolvedAt = ?
       WHERE conversationId = ?
         AND resolved = 0
         AND seq < ?
         AND NOT EXISTS (
           SELECT 1 FROM ${TABLE_NAME} later
            WHERE later.conversationId = ${TABLE_NAME}.conversationId
              AND later.signature = ${TABLE_NAME}.signature
              AND later.seq > ${TABLE_NAME}.seq
         )`, [resolution, Date.now(), conversationId, cutoff]);
        return result.changes ?? 0;
    }
    async markResolvedByTarget(conversationId, target, resolution) {
        if (!target.filePath && !target.command)
            return 0;
        const conds = ["conversationId = ?", "resolved = 0"];
        const params = [conversationId];
        const targetConds = [];
        if (target.filePath) {
            targetConds.push("filePath = ?");
            params.push(target.filePath);
        }
        if (target.command) {
            // Match by leading binary token, same heuristic as the retriever.
            const head = target.command.trim().split(/\s+/)[0];
            if (head) {
                targetConds.push("command LIKE ?");
                params.push(`${head}%`);
            }
        }
        if (targetConds.length === 0)
            return 0;
        conds.push(`(${targetConds.join(" OR ")})`);
        const result = await this.db.run(`UPDATE ${TABLE_NAME}
         SET resolved = 1, resolution = ?, resolvedAt = ?
       WHERE ${conds.join(" AND ")}`, [resolution, Date.now(), ...params]);
        return result.changes ?? 0;
    }
    async deleteById(id) {
        const result = await this.db.run(`DELETE FROM ${TABLE_NAME} WHERE id = ?`, id);
        return result.changes > 0;
    }
}
export function createNegativeExperienceStore(db) {
    return new SqliteNegativeExperienceStore(db);
}
//# sourceMappingURL=store.js.map