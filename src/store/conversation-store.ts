/**
 * CodeMemory for Claude Code - Conversation and Message Storage
 *
 * Manages conversations and message storage in SQLite.
 */

type CodeMemoryDependencies = any;


export interface CreateMessagePartInput {
  partType: string;
  textContent?: string;
  metadata?: string;
}

export interface MessagePartRecord {
  messageId: number;
  partId: number;
  partType: string;
  textContent: string | null;
  metadata: string | null;
}

export interface MessageRecord {
  messageId: number;
  conversationId: number;
  seq: number;
  role: string;
  content: string;
  tokenCount: number;
  createdAt: string;
}

export interface ConversationRecord {
  conversationId: number;
  sessionId: string;
  sessionKey: string;
  bootstrappedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ConversationStore {
  constructor(private db: any, private fts5Available: boolean = false) {}

  /** Access raw database connection for compaction use */
  getDatabase() {
    return this.db;
  }

  async getOrCreateConversation(params: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationRecord> {
    const normalizedSessionId = params.sessionId?.trim();
    const normalizedSessionKey = params.sessionKey?.trim();

    if (!normalizedSessionId && !normalizedSessionKey) {
      throw new Error("Either sessionId or sessionKey is required");
    }

    let existing: ConversationRecord | null = null;

    if (normalizedSessionId) {
      existing = await this.db.get(
        "SELECT * FROM conversations WHERE sessionId = ?",
        normalizedSessionId
      );
    }
    if (!existing && normalizedSessionKey) {
      existing = await this.db.get(
        "SELECT * FROM conversations WHERE sessionKey = ?",
        normalizedSessionKey
      );
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

  async getConversationForSession(params: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationRecord | null> {
    if (params.sessionKey) {
      const record = await this.db.get(
        "SELECT * FROM conversations WHERE sessionKey = ?",
        params.sessionKey
      );
      if (record) return record;
    }
    if (params.sessionId) {
      const record = await this.db.get(
        "SELECT * FROM conversations WHERE sessionId = ?",
        params.sessionId
      );
      if (record) return record;
    }
    return null;
  }

  async insertMessage(params: {
    conversationId: number;
    role: string;
    content: string;
    tokenCount: number;
    parts: CreateMessagePartInput[];
    /** Filter/Score tier: S (skeleton) | M (metadata) | L (fact) | N (noise). */
    tier?: "S" | "M" | "L" | "N";
    /** Filter/Score tags (e.g. ["mutation", "exec"]). */
    tags?: string[];
    /**
     * uuid of the transcript line this row came from, when it has one.
     * Two processes reading the same project directory would otherwise both
     * store it, and messageId is an AUTOINCREMENT key that cannot collide.
     */
    sourceUuid?: string;
    /**
     * The subagent that produced this line, absent for the main agent.
     * Stored as NULL rather than a sentinel: real main-agent entries carry no
     * agentId, so absence is the identity.
     */
    producerAgentId?: string;
    /** The dispatch it belongs to; separates subagents launched in one turn. */
    producerPromptId?: string;
  }): Promise<MessageRecord> {
    const now = new Date().toISOString();

    // Already stored, by this process or another one watching the same
    // directory. Return the original rather than failing: ingestion threads
    // messageId into fix-attempt tracking and telemetry, so a repeat has to
    // be a no-op, not an aborted ingest.
    if (params.sourceUuid) {
      const existing = await this.db.get(
        `SELECT * FROM conversation_messages
          WHERE conversationId = ? AND sourceUuid = ?`,
        [params.conversationId, params.sourceUuid]
      );
      if (existing) {
        return {
          messageId: existing.messageId,
          conversationId: existing.conversationId,
          seq: existing.seq,
          role: existing.role,
          content: existing.content,
          tokenCount: existing.tokenCount,
          createdAt: existing.createdAt,
        };
      }
    }

    const maxSeqResult = await this.db.get(
      "SELECT MAX(seq) as maxSeq FROM conversation_messages WHERE conversationId = ?",
      params.conversationId
    );
    // Use ?? not || here: maxSeq=0 must be treated as "first message exists",
    // not "no messages yet". The previous `||` collapsed both cases and made
    // every row keep seq=0, breaking intra-conversation ordering.
    const seq = (maxSeqResult?.maxSeq ?? -1) + 1;

    const tier = params.tier ?? "S";
    const tagsJson =
      params.tags && params.tags.length > 0 ? JSON.stringify(params.tags) : null;

    let messageId: number;
    try {
      const result = await this.db.run(`
        INSERT INTO conversation_messages (
          conversationId, seq, role, content, tokenCount, createdAt, tier, tags,
          sourceUuid, producerAgentId, producerPromptId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        params.conversationId, seq, params.role, params.content,
        params.tokenCount, now, tier, tagsJson, params.sourceUuid ?? null,
        params.producerAgentId ?? null, params.producerPromptId ?? null
      ]);
      messageId = result.lastID;
    } catch (error) {
      // The check above has a window: two daemons watching the same project
      // directory can both find no row and both insert. Within one process
      // dispatch is sequential, so this only fires across processes -- which
      // is the case this whole change exists for. The index is the authority;
      // the check is only there to avoid the exception on the common path.
      const existing = params.sourceUuid
        ? await this.db.get(
            `SELECT * FROM conversation_messages
              WHERE conversationId = ? AND sourceUuid = ?`,
            [params.conversationId, params.sourceUuid]
          )
        : null;
      if (!existing) throw error;
      return {
        messageId: existing.messageId,
        conversationId: existing.conversationId,
        seq: existing.seq,
        role: existing.role,
        content: existing.content,
        tokenCount: existing.tokenCount,
        createdAt: existing.createdAt,
      };
    }

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

  async getMessage(messageId: number): Promise<MessageRecord | null> {
    return this.db.get("SELECT * FROM conversation_messages WHERE messageId = ?", messageId);
  }

  async getMessageParts(messageId: number): Promise<MessagePartRecord[]> {
    return this.db.all("SELECT * FROM message_parts WHERE messageId = ? ORDER BY partId", messageId);
  }

  async getMessagesByConversation(conversationId: number): Promise<MessageRecord[]> {
    return this.db.all(`
      SELECT * FROM conversation_messages
      WHERE conversationId = ?
      ORDER BY seq
    `, conversationId);
  }

  async markConversationBootstrapped(conversationId: number): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET bootstrappedAt = ?, updatedAt = ? WHERE conversationId = ?",
      [new Date().toISOString(), new Date().toISOString(), conversationId]
    );
  }

  async searchMessages(input: {
    query: string;
    mode: "regex" | "full_text";
    conversationId?: number;
    since?: Date;
    before?: Date;
    limit?: number;
  }): Promise<any[]> {
    let sql = "SELECT * FROM conversation_messages";
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

    const records: any[] = await this.db.all(sql, params);
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

  async getMessageById(messageId: number): Promise<MessageRecord | null> {
    return this.db.get("SELECT * FROM conversation_messages WHERE messageId = ?", messageId);
  }

  async getMessageCount(conversationId: number): Promise<number> {
    const result = await this.db.get(
      "SELECT COUNT(*) as count FROM conversation_messages WHERE conversationId = ?",
      conversationId
    );
    return result?.count ?? 0;
  }

  async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.db.run("BEGIN TRANSACTION");
      const result = await operation();
      await this.db.run("COMMIT");
      return result;
    } catch (error) {
      await this.db.run("ROLLBACK");
      throw error;
    }
  }
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}
