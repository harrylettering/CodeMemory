/**
 * CodeMemory for Claude Code - Context Engine
 *
 * Thin orchestrator that owns the sqlite handle + stores and exposes the
 * one operation external callers actually invoke today: `compact`.
 *
 * The class used to advertise bootstrap/ingest/ingestBatch/afterTurn/
 * assemble/getRetrieval/getCompaction/handleBeforeReset stubs from the
 * v1 plan, but no caller ever bound to them — ingest goes through the
 * daemon's jsonl-watcher pipeline directly. They were misleading API
 * surface and were removed.
 */

import type { CodeMemoryDependencies } from "./types.js";
import type { CodeMemoryConfig } from "./db/config.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { AsyncCompactor } from "./compaction/compactor.js";

export interface CompactResult {
  actionTaken: boolean;
  tokensBefore: number;
  tokensAfter: number;
  createdSummaryId?: string;
  condensed: boolean;
  level?: string;
  authFailure?: boolean;
}

export class CodeMemoryContextEngine {
  private config: CodeMemoryConfig;
  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private deps: CodeMemoryDependencies;
  private db: any;

  constructor(params: {
    db: any;
    config: CodeMemoryConfig;
    deps: CodeMemoryDependencies;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.deps = params.deps;

    this.conversationStore = new ConversationStore(this.db);
    this.summaryStore = new SummaryStore(this.db);
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getSummaryStore(): SummaryStore {
    return this.summaryStore;
  }

  async compact(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile?: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    const conv = await this.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    if (!conv) {
      return { actionTaken: false, tokensBefore: 0, tokensAfter: 0, condensed: false };
    }

    const convId = conv.conversationId;
    const noop = console.error.bind(console);
    const noopLogger = { debug: noop, info: noop, warn: noop, error: noop };
    const compactor = new AsyncCompactor(this.db, this.config, noopLogger);

    const before: { total: number | null } | undefined = await this.db.get(
      `SELECT SUM(tokenCount) as total FROM conversation_messages
       WHERE conversationId = ? AND tier IN ('M','L')
         AND messageId NOT IN (SELECT messageId FROM summary_messages)`,
      convId
    );
    const tokensBefore = before?.total ?? 0;

    // Force compaction regardless of threshold (explicit trigger).
    const createdSummaryIds = await compactor.forceCompact(convId);

    const after: { total: number | null } | undefined = await this.db.get(
      `SELECT SUM(tokenCount) as total FROM conversation_messages
       WHERE conversationId = ? AND tier IN ('M','L')
         AND messageId NOT IN (SELECT messageId FROM summary_messages)`,
      convId
    );
    const tokensAfter = after?.total ?? 0;

    const actionTaken = createdSummaryIds.length > 0;
    // Prefer a condensed id as the top-level result when the run produced
    // one — it represents the higher rung of the DAG created this call.
    const condensedId = [...createdSummaryIds].reverse().find((id) => id.startsWith("cond-"));
    const leafId = [...createdSummaryIds].reverse().find((id) => id.startsWith("leaf-"));
    const topId = condensedId ?? leafId;

    return {
      actionTaken,
      tokensBefore,
      tokensAfter,
      condensed: !!condensedId,
      createdSummaryId: topId,
      level: condensedId ? "condensed" : leafId ? "leaf" : undefined,
    };
  }
}
