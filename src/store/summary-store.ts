/**
 * CodeMemory for Claude Code - Summary DAG Storage
 *
 * Manages summary DAG storage and context item management in SQLite.
 */

type CodeMemoryDependencies = any;


export interface SummaryRecord {
  summaryId: string;
  conversationId: number;
  kind: "leaf" | "condensed";
  depth: number;
  earliestAt: string;
  latestAt: string;
  descendantCount: number;
  tokenCount: number;
  content: string;
  createdAt: string;
}

export interface ContextItemRecord {
  contextItemId: number;
  conversationId: number;
  ordinal: number;
  itemType: "message" | "summary";
  messageId: number | null;
  summaryId: string | null;
}

export interface SummaryMessageLink {
  summaryId: string;
  messageId: number;
  position: number;
}

export interface SummaryParentLink {
  summaryId: string;
  parentSummaryId: string;
  position: number;
}

export class SummaryStore {
  constructor(private db: any, private fts5Available: boolean = false) {}

  /** Access raw database connection for compaction use */
  getDatabase() {
    return this.db;
  }

  async getConversationBootstrapState(conversationId: number): Promise<any | null> {
    return this.db.get(
      "SELECT * FROM conversation_bootstrap_state WHERE conversationId = ?",
      conversationId
    );
  }

  async upsertConversationBootstrapState(params: {
    conversationId: number;
    sessionFilePath: string;
    lastSeenSize: number;
    lastSeenMtimeMs: number;
    lastProcessedOffset: number;
    lastProcessedEntryHash: string | null;
  }): Promise<void> {
    const existing = await this.db.get(
      "SELECT conversationId FROM conversation_bootstrap_state WHERE conversationId = ?",
      params.conversationId
    );

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
    } else {
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

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    return this.db.all(`
      SELECT * FROM conversation_context
      WHERE conversationId = ?
      ORDER BY ordinal
    `, conversationId);
  }

  async appendContextMessages(
    conversationId: number,
    messageIds: number[]
  ): Promise<void> {
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

  async replaceContextItems(
    conversationId: number,
    items: Array<{
      itemType: "message" | "summary";
      messageId?: number;
      summaryId?: string;
    }>
  ): Promise<void> {
    await this.db.run(
      "DELETE FROM conversation_context WHERE conversationId = ?",
      conversationId
    );

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

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    return this.db.get("SELECT * FROM summaries WHERE summaryId = ?", summaryId);
  }

  async getConversationMaxSummaryDepth(conversationId: number): Promise<number> {
    const result = await this.db.get(
      "SELECT MAX(depth) as maxDepth FROM summaries WHERE conversationId = ?",
      conversationId
    );
    return result?.maxDepth ?? -1;
  }

  async searchSummaries(input: {
    query: string;
    mode: "regex" | "full_text";
    conversationId?: number;
    since?: Date;
    before?: Date;
    limit?: number;
  }): Promise<any[]> {
    let sql = "SELECT * FROM summaries";
    const params: any[] = [];
    const conditions: string[] = [];

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
    } else if (input.mode === "regex") {
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
    return records.map((record: SummaryRecord) => ({
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

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const records = await this.db.all(`
      SELECT s.* FROM summaries s
      JOIN summary_parents sp ON s.summaryId = sp.parentSummaryId
      WHERE sp.summaryId = ?
    `, summaryId);
    return records.map((record: SummaryRecord) => ({
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

  async getSummaryChildren(summaryId: string): Promise<SummaryRecord[]> {
    const records = await this.db.all(`
      SELECT s.* FROM summaries s
      JOIN summary_parents sp ON s.summaryId = sp.summaryId
      WHERE sp.parentSummaryId = ?
    `, summaryId);
    return records.map((record: SummaryRecord) => ({
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

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const records = await this.db.all(
      "SELECT messageId FROM summary_messages WHERE summaryId = ?",
      summaryId
    );
    return records.map((record: { messageId: number }) => record.messageId);
  }

  async getSummarySubtree(summaryId: string): Promise<any[]> {
    const result = await this.db.get("SELECT * FROM summaries WHERE summaryId = ?", summaryId);
    if (!result) return [];

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

  async getLeafSummaryLinksForMessageIds(
    conversationId: number,
    messageIds: number[]
  ): Promise<Array<{ summaryId: string; messageId: number }>> {
    if (messageIds.length === 0) return [];

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
