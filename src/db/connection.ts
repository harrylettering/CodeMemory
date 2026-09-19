/**
 * CodeMemory for Claude Code - Database Connection Management
 *
 * SQLite database connection handling with migration support.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * We deliberately depend on the built-in `node:sqlite` rather than the
 * `sqlite3` npm package. Plugin hosts install plugins with `--ignore-scripts`,
 * which silently skips `sqlite3`'s native `install` step
 * (`prebuild-install -r napi || node-gyp rebuild`). The result is a package
 * tree with sources but no `node_sqlite3.node`, so every daemon start dies on
 * "Could not locate the bindings file". A built-in has no install step to skip.
 *
 * The cost is a Node floor: `node:sqlite` landed in 22.5.0.
 */
const MIN_NODE_VERSION_FOR_SQLITE = "22.5.0";

/** Prepared statements are cached per SQL text; the hot lookup path re-runs a
 * small, fixed set of queries and re-preparing each time is pure overhead. */
const STATEMENT_CACHE_LIMIT = 256;

/** Bindable SQLite primitive, after normalization. */
type SqliteBindable = null | number | bigint | string | Uint8Array;

export interface CodeMemoryRunResult {
  /** Named `lastID` for parity with the previous `sqlite` wrapper. */
  lastID: number;
  changes: number;
}

/**
 * The async surface the stores are written against. `node:sqlite` is
 * synchronous, so this adapter exists purely to keep the ~80 existing
 * `await db.run(...)` call sites unchanged.
 */
export interface CodeMemoryDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<CodeMemoryRunResult>;
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function createCodeMemoryDatabaseConnection(
  dbPath: string
): Promise<CodeMemoryDatabase> {
  const dbDir = dirname(dbPath);
  await mkdir(dbDir, { recursive: true });

  const { DatabaseSync: Database } = await loadNodeSqlite();

  const handle = new Database(dbPath, {
    // The daemon and the one-shot fallback CLI can touch the same file
    // concurrently. Without a busy timeout `node:sqlite` fails immediately on
    // SQLITE_BUSY instead of waiting for the other writer to finish.
    timeout: 5000,
    // SQLite (and therefore the previous `sqlite3` driver) leaves foreign key
    // enforcement OFF by default; `node:sqlite` turns it ON. Every table here
    // was written against the unenforced default — nodes are routinely
    // inserted before the conversation row they reference — so enabling it
    // would turn the driver swap into a schema change.
    enableForeignKeyConstraints: false,
  });

  const db = createDatabaseAdapter(handle);
  await runCodeMemoryMigrations(db);

  return db;
}

/**
 * Loads the built-in lazily so an unsupported Node version produces an
 * actionable message instead of a bare ERR_UNKNOWN_BUILTIN_MODULE stack.
 */
async function loadNodeSqlite(): Promise<typeof import("node:sqlite")> {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `[codememory] CodeMemory requires Node >= ${MIN_NODE_VERSION_FOR_SQLITE} ` +
        `for the built-in node:sqlite module (found ${process.version}). ` +
        `Upgrade Node and restart the session.`,
      { cause: error }
    );
  }
}

export function createDatabaseAdapter(handle: DatabaseSync): CodeMemoryDatabase {
  const statements = new Map<string, StatementSync>();

  function prepare(sql: string): StatementSync {
    const cached = statements.get(sql);
    if (cached) return cached;

    const statement = handle.prepare(sql);
    if (statements.size >= STATEMENT_CACHE_LIMIT) {
      // FIFO eviction: insertion order is good enough for a fixed query set.
      const oldest = statements.keys().next();
      if (!oldest.done) statements.delete(oldest.value);
    }
    statements.set(sql, statement);
    return statement;
  }

  return {
    async exec(sql: string): Promise<void> {
      handle.exec(sql);
    },

    async run(sql: string, ...params: unknown[]): Promise<CodeMemoryRunResult> {
      const result = prepare(sql).run(...bindParams(params));
      return {
        lastID: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    },

    async get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined> {
      const row = prepare(sql).get(...bindParams(params));
      return row === undefined ? undefined : (toPlainRow(row) as T);
    },

    async all<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
      return prepare(sql)
        .all(...bindParams(params))
        .map((row) => toPlainRow(row) as T);
    },

    async close(): Promise<void> {
      statements.clear();
      handle.close();
    },
  };
}

/**
 * Call sites use both `run(sql, a, b)` and `run(sql, [a, b])`; the previous
 * `sqlite` wrapper accepted either, so we keep accepting both.
 */
function bindParams(params: unknown[]): SqliteBindable[] {
  const flat =
    params.length === 1 && Array.isArray(params[0])
      ? (params[0] as unknown[])
      : params;
  return flat.map(normalizeParam);
}

/**
 * `node:sqlite` throws on values the old `sqlite3` driver coerced silently.
 * Reproducing that coercion here keeps the migration behavior-preserving —
 * without it, any code path that binds an optional field would start throwing
 * "Provided value cannot be bound to SQLite parameter N" at runtime.
 */
function normalizeParam(value: unknown): SqliteBindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value === "string" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(
    `[codememory] Cannot bind ${typeof value} to a SQLite parameter: ${String(value)}`
  );
}

/**
 * Rows come back with a null prototype. Callers spread and JSON-serialize
 * them, so hand back ordinary objects to match the previous driver.
 */
function toPlainRow(row: unknown): Record<string, unknown> {
  return Object.assign({}, row as Record<string, unknown>);
}

export async function runCodeMemoryMigrations(db: any): Promise<void> {
  // Migration 1: Create conversations table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversationId INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT UNIQUE,
      sessionKey TEXT,
      bootstrappedAt TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration 2: Create conversation messages table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      messageId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokenCount INTEGER NOT NULL,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
    )
  `);

  // Migration 3: Create message parts table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS message_parts (
      partId INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId INTEGER NOT NULL,
      partType TEXT NOT NULL,
      textContent TEXT,
      metadata TEXT,
      FOREIGN KEY (messageId) REFERENCES conversation_messages(messageId)
    )
  `);

  // Migration 4: Create conversation context items table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_context (
      contextItemId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      itemType TEXT NOT NULL CHECK(itemType IN ('message', 'summary')),
      messageId INTEGER,
      summaryId TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId),
      FOREIGN KEY (messageId) REFERENCES conversation_messages(messageId)
    )
  `);

  // Migration 5: Create conversation context index
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_context ON conversation_context(
      conversationId, ordinal
    )
  `);

  // Migration 6: Create summaries table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      summaryId TEXT PRIMARY KEY,
      conversationId INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL,
      earliestAt TEXT NOT NULL,
      latestAt TEXT NOT NULL,
      descendantCount INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      tokenCount INTEGER NOT NULL,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
    )
  `);

  // Migration 7: Create summary message links table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS summary_messages (
      summaryId TEXT NOT NULL,
      messageId INTEGER NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY (summaryId) REFERENCES summaries(summaryId),
      FOREIGN KEY (messageId) REFERENCES conversation_messages(messageId)
    )
  `);

  // Migration 8: Create summary parents table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS summary_parents (
      summaryId TEXT NOT NULL,
      parentSummaryId TEXT NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY (summaryId) REFERENCES summaries(summaryId),
      FOREIGN KEY (parentSummaryId) REFERENCES summaries(summaryId)
    )
  `);

  // Migration 9: Create conversation bootstrap state table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_bootstrap_state (
      conversationId INTEGER PRIMARY KEY,
      sessionFilePath TEXT NOT NULL,
      lastSeenSize INTEGER NOT NULL,
      lastSeenMtimeMs INTEGER NOT NULL,
      lastProcessedOffset INTEGER NOT NULL,
      lastProcessedEntryHash TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
    )
  `);

  // Migration 10: Create message index by conversation and sequence
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_seq ON conversation_messages(
      conversationId, seq
    )
  `);

  // Migration 11: Create summary index by conversation and depth
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_depth ON summaries(
      conversationId, depth
    )
  `);

  // Migration 13: Filter/Score columns on conversation_messages.
  // SQLite ADD COLUMN is idempotent only if we guard against re-runs;
  // we wrap each in try/catch to ignore "duplicate column" errors.
  await addColumnIfMissing(
    db,
    "conversation_messages",
    "tier",
    "TEXT NOT NULL DEFAULT 'S'"
  );
  await addColumnIfMissing(
    db,
    "conversation_messages",
    "tags",
    "TEXT" // JSON-encoded string array; null when no tags
  );

  // Migration 14: Index on tier for fast filtered retrieval.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_tier ON conversation_messages(
      conversationId, tier
    )
  `);

  // The `negative_experiences` table has been collapsed into
  // `memory_nodes` (kind='failure'). Drop the legacy table and its
  // indexes — failures now live as memory nodes and are queried via
  // `findFailuresByAnchors` against `memory_tags`.
  await db.exec(`DROP TABLE IF EXISTS negative_experiences`);

  // Migration 17: Exploration dedup persistence. Without this table the
  // Filter/Score layer's `exploredTargets` Set lives only in daemon memory,
  // so a restart or a second daemon for the same project loses the dedup
  // signal entirely and every re-read of the same file gets re-ingested.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS explored_targets (
      conversationId INTEGER NOT NULL,
      target TEXT NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      PRIMARY KEY (conversationId, target),
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
    )
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_explored_targets_seen ON explored_targets(
      conversationId, lastSeenAt
    )
  `);

  // Migration 18: Memory Nodes. These are durable recall objects built
  // from high-value events (decisions, failures, summaries) so prompt-time
  // retrieval can search stable facts instead of replaying raw transcripts.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_nodes (
      nodeId TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('task', 'constraint', 'decision', 'failure', 'fix_attempt', 'summary')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'superseded', 'stale')),
      confidence REAL NOT NULL DEFAULT 1.0,
      conversationId INTEGER,
      sessionId TEXT,
      source TEXT NOT NULL,
      sourceId TEXT,
      sourceToolUseId TEXT,
      summaryId TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      supersedesNodeId TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastUsedAt TEXT,
      useCount INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId),
      FOREIGN KEY (summaryId) REFERENCES summaries(summaryId)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_status ON memory_nodes(
      kind, status, updatedAt
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_conversation ON memory_nodes(
      conversationId, updatedAt
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(
      source, sourceId
    )
  `);

  // Migration 19: Memory Tags. Tags are the compact index used by the
  // RetrievalPlan to match prompt entities (file, command, topic, etc.)
  // to Memory Nodes with lightweight scoring.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      nodeId TEXT NOT NULL,
      tagType TEXT NOT NULL,
      tagValue TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (nodeId, tagType, tagValue),
      FOREIGN KEY (nodeId) REFERENCES memory_nodes(nodeId) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_tags_lookup ON memory_tags(
      tagType, tagValue, weight
    )
  `);

  // Migration 20: Memory Relations. Relations are typed edges used for
  // precise lifecycle updates (for example decision supersedes decision,
  // fix_attempt resolves failure, summary node derives from summary DAG).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      relationId INTEGER PRIMARY KEY AUTOINCREMENT,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      relationType TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      evidenceMessageId INTEGER,
      evidenceSummaryId TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(fromNodeId, toNodeId, relationType)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(
      fromNodeId, relationType
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(
      toNodeId, relationType
    )
  `);

  // Migration 21: Memory Lifecycle Events. Status transitions are append-
  // only so lifecycle decisions are auditable and can be debugged later.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeId TEXT NOT NULL,
      fromStatus TEXT,
      toStatus TEXT NOT NULL,
      eventType TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      reason TEXT,
      evidenceMessageId INTEGER,
      evidenceSummaryId TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (nodeId) REFERENCES memory_nodes(nodeId) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_node ON memory_lifecycle_events(
      nodeId, createdAt
    )
  `);

  // Migration 22: Pending lifecycle updates. Weak lifecycle matches are
  // recorded here instead of mutating memory_nodes directly, so ambiguous
  // "this is fixed" signals never silently rewrite history.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_pending_updates (
      pendingId INTEGER PRIMARY KEY AUTOINCREMENT,
      transition TEXT NOT NULL,
      eventType TEXT NOT NULL,
      targetNodeId TEXT,
      targetCandidates TEXT,
      fromStatus TEXT,
      toStatus TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      reason TEXT,
      evidenceMessageId INTEGER,
      evidenceSummaryId TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'applied', 'dismissed')),
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_pending_status ON memory_pending_updates(
      status, transition, createdAt
    )
  `);

  // Migration 23: Attempt spans. These track the high-signal coding loop
  // "mutation(s) -> validation command -> succeeded/failed" and back the
  // fix_attempt Memory Node lifecycle.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS attempt_spans (
      attemptId TEXT PRIMARY KEY,
      conversationId INTEGER NOT NULL,
      sessionId TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed')),
      outcome TEXT NOT NULL DEFAULT 'unknown' CHECK(outcome IN ('unknown', 'succeeded', 'failed', 'partial')),
      startedAtSeq INTEGER NOT NULL,
      endedAtSeq INTEGER,
      touchedFiles TEXT,
      commandsRun TEXT,
      relatedFailureNodeIds TEXT,
      fixAttemptNodeId TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_attempt_spans_active ON attempt_spans(
      conversationId, sessionId, status, startedAtSeq
    )
  `);

  // Migration 24: Extend memory_nodes.kind to support task / constraint so
  // long-session requirements become first-class memory recall objects.
  await ensureMemoryNodeKindSupport(db);

  // Migration 25: sourceToolUseId column + partial UNIQUE index. The Skill →
  // daemon write path needs an idempotency key so a retried tool_use does
  // not produce two memory_nodes for the same intent.
  await addColumnIfMissing(db, "memory_nodes", "sourceToolUseId", "TEXT");
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_nodes_source_tool_use
      ON memory_nodes(sourceToolUseId)
      WHERE sourceToolUseId IS NOT NULL
  `);

  // Migration 26: Prior-failure lookup telemetry. The PreToolUse path is the
  // product's headline behavior and was entirely unobservable: markUsed was
  // never called from it, so useCount stayed 0 across every failure node and
  // the database could not say whether a warning had ever fired. Worse, a
  // silent lookup has four different causes — no target, no candidate, below
  // the confidence floor, debounced — and they demand opposite fixes.
  //
  // A row per lookup, including the ones that surfaced nothing, is what makes
  // recall measurable and lets an injection be joined against whatever failed
  // afterwards.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS failure_lookup_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER,
      sessionId TEXT,
      toolName TEXT NOT NULL,
      targetFile TEXT,
      targetCommand TEXT,
      targetFileTag TEXT,
      targetCommandTag TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN (
        'injected', 'debounced', 'below_confidence', 'no_candidates', 'no_target'
      )),
      candidateCount INTEGER NOT NULL DEFAULT 0,
      passedCount INTEGER NOT NULL DEFAULT 0,
      topScore REAL,
      surfacedNodeIds TEXT,
      source TEXT NOT NULL DEFAULT 'daemon',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_failure_lookup_events_outcome ON failure_lookup_events(
      outcome, createdAt
    )
  `);

  // The joinable columns were added after the table shipped in a working
  // branch, so upgrade in place rather than assuming a fresh database.
  await addColumnIfMissing(db, "failure_lookup_events", "targetFileTag", "TEXT");
  await addColumnIfMissing(db, "failure_lookup_events", "targetCommandTag", "TEXT");

  // Indexed on the normalized forms: joining telemetry to memory_tags is the
  // whole reason these columns exist, and the raw path cannot serve for it.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_failure_lookup_events_target ON failure_lookup_events(
      targetFileTag, createdAt
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_failure_lookup_events_command ON failure_lookup_events(
      targetCommandTag, createdAt
    )
  `);

  // Migration 27: Telemetry for the two LLM-backed features that were opt-in
  // but unobservable. Both were switched on in settings and neither could be
  // shown to have ever run.
  //
  // The decision judge left a trace only when it ruled SUPERSEDED_BY_NEW, and
  // its call site swallowed every error with a bare catch, so "never fired",
  // "fired and correctly kept everything", and "failed on every invocation"
  // were indistinguishable from outside. They need opposite fixes.
  //
  // The query planner computed a source/reason pair and returned it in the
  // response, where it was discarded. A row per prompt makes it answerable
  // whether the smart path was ever taken and whether it retrieved more than
  // the deterministic plan it replaced.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS decision_judge_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER,
      sessionId TEXT,
      newNodeId TEXT NOT NULL,
      candidateCount INTEGER NOT NULL DEFAULT 0,
      supersededCount INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL CHECK(outcome IN (
        'superseded', 'all_kept', 'no_candidates', 'empty_verdict', 'error'
      )),
      supersededNodeIds TEXT,
      errorMessage TEXT,
      latencyMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_decision_judge_events_outcome ON decision_judge_events(
      outcome, createdAt
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER,
      sessionId TEXT,
      promptLength INTEGER NOT NULL DEFAULT 0,
      -- 'fallback' is the planner having been attempted and thrown. It looks
      -- like 'fast' in the retrieved result but means the opposite: the fast
      -- plan was judged insufficient and the replacement failed.
      plannerSource TEXT NOT NULL CHECK(plannerSource IN ('fast', 'smart', 'fallback')),
      plannerAttempted INTEGER NOT NULL DEFAULT 0,
      plannerReason TEXT,
      plannerError TEXT,
      memoryNodeCount INTEGER NOT NULL DEFAULT 0,
      injectedChars INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL CHECK(outcome IN ('injected', 'empty')),
      latencyMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_events_planner ON retrieval_events(
      plannerSource, createdAt
    )
  `);

  // Migration 28: Round out the two telemetry surfaces so the system can be
  // evaluated rather than described.
  //
  // Retrieval already computed a full funnel on every call — how many nodes
  // matched a tag, how many survived selection, what relation stitching added,
  // which of the four paths produced the surfaced content — and returned it in
  // the response, where it was dropped. Storing only the final count answers
  // "did anything come back" and nothing about why. A low injection rate has
  // opposite fixes depending on whether candidates were never found or found
  // and then filtered away.
  //
  // Compaction had no durable record at all. Whether a summary came from the
  // model or from the truncation fallback survived only as a marker embedded
  // in the summary text, and the reason for a fallback — quota exhausted,
  // timeout, validation failure after retry — existed only as an untimestamped
  // log line. 224 fallbacks were logged against 0 recoverable in the database.
  for (const [column, type] of [
    ["candidateCount", "INTEGER"],
    ["selectedNodeCount", "INTEGER"],
    ["stitchedRelationCount", "INTEGER"],
    ["stitchedChainCount", "INTEGER"],
    ["summaryEvidenceCount", "INTEGER"],
    ["firstHopNodeCount", "INTEGER"],
    ["secondHopNodeCount", "INTEGER"],
    ["estimatedTokens", "INTEGER"],
    ["queryCount", "INTEGER"],
    ["failureLookupCount", "INTEGER"],
    ["failureHits", "INTEGER"],
    ["decisionHits", "INTEGER"],
    ["messageHits", "INTEGER"],
    ["intent", "TEXT"],
    // Joinable back to memory_nodes, which is what makes "was the surfaced
    // memory any good" answerable after the fact.
    ["surfacedNodeIds", "TEXT"],
  ] as const) {
    await addColumnIfMissing(db, "retrieval_events", column, type);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_events_intent ON retrieval_events(
      intent, createdAt
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER,
      sessionId TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('leaf', 'condensed')),
      trigger TEXT NOT NULL DEFAULT 'background',
      summaryId TEXT,
      inputCount INTEGER NOT NULL DEFAULT 0,
      inputChars INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0,
      -- 'ok' first try, 'ok_after_retry' the quality retry saved it,
      -- 'validation_failed' both attempts were rejected, 'error' the CLI
      -- itself failed, 'disabled' the LLM was switched off by config.
      llmOutcome TEXT NOT NULL CHECK(llmOutcome IN (
        'ok', 'ok_after_retry', 'validation_failed', 'error', 'disabled'
      )),
      usedFallback INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT,
      model TEXT,
      latencyMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_events_outcome ON compaction_events(
      llmOutcome, createdAt
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_events_conversation ON compaction_events(
      conversationId, createdAt
    )
  `);

  // Migration 29: The write side. Retrieval and compaction were observable
  // after migrations 26-28; what entered the system was not.
  //
  // N-tier messages are dropped by the scorer and never written anywhere, so
  // the single most important ingestion number — what fraction of a session is
  // discarded as noise, and under which rule — had no record at all. The
  // stored tiers are recoverable from conversation_messages, but a rate needs
  // its denominator, and the denominator was exactly the part being thrown
  // away.
  //
  // Key-memory extraction runs one LLM call per transcript chunk and catches
  // per-chunk failures so a partial rebuild survives. That is the right
  // behavior and it means a run reporting 12 memories may have silently lost
  // eight chunks.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ingestion_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER,
      sessionId TEXT,
      messageId INTEGER,
      role TEXT,
      tier TEXT NOT NULL CHECK(tier IN ('S', 'M', 'L', 'N')),
      tags TEXT,
      rawChars INTEGER NOT NULL DEFAULT 0,
      storedChars INTEGER NOT NULL DEFAULT 0,
      stored INTEGER NOT NULL DEFAULT 0,
      subagent INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ingestion_events_tier ON ingestion_events(
      tier, createdAt
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ingestion_events_conversation ON ingestion_events(
      conversationId, createdAt
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      conversationId INTEGER,
      sessionId TEXT,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      chunkCount INTEGER NOT NULL DEFAULT 0,
      chunkChars INTEGER NOT NULL DEFAULT 0,
      -- Whole-run figures, repeated on each chunk so one row is self-contained.
      -- The prose filter drops tool traffic; the ratio between these two is how
      -- much of a transcript the model never has to read.
      sourceRawChars INTEGER,
      sourceProseChars INTEGER,
      outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'parse_empty', 'error')),
      itemCount INTEGER NOT NULL DEFAULT 0,
      decisionCount INTEGER NOT NULL DEFAULT 0,
      taskCount INTEGER NOT NULL DEFAULT 0,
      constraintCount INTEGER NOT NULL DEFAULT 0,
      revisesCount INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT,
      model TEXT,
      latencyMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_extraction_events_run ON extraction_events(
      runId, chunkIndex
    )
  `);

  // Migration 30: Persist how far each transcript has been read.
  //
  // The watcher's offset map is process-local. A restart therefore had two
  // options, both lossy. Rewinding to 0 re-emitted every prefix, and since
  // nothing dedupes on the way in, a static 10-line transcript became 10 rows,
  // then 20, then 30. Seeding to the end of the file instead (the mitigation
  // that shipped) silently drops everything written while the daemon was down.
  //
  // That second cost is paid on every `--resume`, every crash recovery, and
  // every plugin upgrade, and it is about to be paid far more often once the
  // daemon is allowed to exit when idle and be respawned on demand. An offset
  // that survives the process makes a restart a seamless continuation instead
  // of a choice between duplicating and losing.
  //
  // Keyed by file, not conversation. conversation_bootstrap_state was designed
  // for this and never wired up, but its conversationId primary key cannot
  // hold the several transcripts one conversation owns -- a main file plus one
  // per subagent -- and offsets must load before any conversation row exists.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS watcher_offsets (
      filePath TEXT PRIMARY KEY,
      -- Character offset into the decoded file, matching how the watcher
      -- measures. Not stat().size, which drifts on any multi-byte content.
      charOffset INTEGER NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration 31: distinguish a lookup that ran and found nothing from one
  // that never ran because the calling session could not be resolved.
  //
  // Both would otherwise be recorded as 'no_candidates', and they need
  // opposite fixes: the first is a coverage problem, the second is a wiring
  // problem that silently disables recall. A column rather than a new outcome
  // value because the outcome CHECK cannot be extended without rebuilding the
  // table, and the rebuild would cost more than it buys.
  await addColumnIfMissing(
    db,
    "failure_lookup_events",
    "unresolvedConversation",
    "INTEGER NOT NULL DEFAULT 0"
  );


  // Migration 32: let the database refuse a line it has already stored.
  //
  // The watcher observes a project directory and filters by extension, not by
  // session, while the daemon owning it is per-session. Two sessions in one
  // project means two processes reading every transcript in it. Nothing
  // stopped the second read from landing: messageId is an AUTOINCREMENT
  // primary key with no relationship to the line it came from.
  //
  // Measured live: conversation 11 held 910 rows from a 776-line transcript,
  // with 138 groups of byte-identical content at evenly spaced seq values.
  //
  // Scoped by conversation rather than global. A re-import purges and rebuilds
  // one conversation, and a subagent transcript is read by the session that
  // dispatched it; neither should be blocked by a row belonging elsewhere.
  //
  // Nullable on purpose. SQLite treats NULLs in a unique index as distinct, so
  // rows that predate this column -- and the metadata lines that carry no uuid
  // and never become messages anyway -- are left alone rather than colliding.
  await addColumnIfMissing(db, "conversation_messages", "sourceUuid", "TEXT");

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_source
      ON conversation_messages(conversationId, sourceUuid)
      WHERE sourceUuid IS NOT NULL
  `);

  console.log(`[codememory] Database migrations completed successfully`);
}

/**
 * Idempotent ADD COLUMN helper. Inspects table schema via PRAGMA and only
 * issues the ALTER if the column does not yet exist.
 */
async function addColumnIfMissing(
  db: any,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function columnExists(
  db: any,
  table: string,
  column: string
): Promise<boolean> {
  const rows: Array<{ name: string }> = await db.all(
    `PRAGMA table_info(${table})`
  );
  return rows.some((r) => r.name === column);
}

async function ensureMemoryNodeKindSupport(db: any): Promise<void> {
  const table = await db.get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_nodes'`
  );
  const sql = String(table?.sql || "");
  if (sql.includes("'task'") && sql.includes("'constraint'")) return;

  // The table rebuild below drops and renames `memory_nodes`, so foreign key
  // enforcement has to come off for the duration. Capture the current setting
  // rather than assuming it: this migration only runs for databases created
  // before kind='task'/'constraint' existed, and unconditionally restoring it
  // to ON left those sessions enforcing foreign keys while freshly created
  // databases did not — the same connection behaving two different ways
  // depending on how old the file on disk was.
  const foreignKeysPragma = (await db.get("PRAGMA foreign_keys")) as
    | { foreign_keys: number }
    | undefined;
  const foreignKeysWereEnabled = (foreignKeysPragma?.foreign_keys ?? 0) === 1;

  await db.exec("PRAGMA foreign_keys = OFF");
  try {
    await db.exec("BEGIN TRANSACTION");
    await db.exec("DROP TABLE IF EXISTS memory_nodes_v2");
    const hasSourceToolUseIdColumn = await columnExists(
      db,
      "memory_nodes",
      "sourceToolUseId"
    );
    await db.exec(`
      CREATE TABLE memory_nodes_v2 (
        nodeId TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('task', 'constraint', 'decision', 'failure', 'fix_attempt', 'summary')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'superseded', 'stale')),
        confidence REAL NOT NULL DEFAULT 1.0,
        conversationId INTEGER,
        sessionId TEXT,
        source TEXT NOT NULL,
        sourceId TEXT,
        sourceToolUseId TEXT,
        summaryId TEXT,
        content TEXT NOT NULL,
        metadata TEXT,
        supersedesNodeId TEXT,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lastUsedAt TEXT,
        useCount INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (conversationId) REFERENCES conversations(conversationId),
        FOREIGN KEY (summaryId) REFERENCES summaries(summaryId)
      )
    `);
    const sourceToolUseIdSelect = hasSourceToolUseIdColumn
      ? "sourceToolUseId"
      : "NULL AS sourceToolUseId";
    await db.exec(`
      INSERT INTO memory_nodes_v2 (
        nodeId, kind, status, confidence, conversationId, sessionId,
        source, sourceId, sourceToolUseId, summaryId, content, metadata,
        supersedesNodeId, createdAt, updatedAt, lastUsedAt, useCount
      )
      SELECT
        nodeId, kind, status, confidence, conversationId, sessionId,
        source, sourceId, ${sourceToolUseIdSelect}, summaryId, content, metadata,
        supersedesNodeId, createdAt, updatedAt, lastUsedAt, useCount
      FROM memory_nodes
    `);
    await db.exec("DROP TABLE memory_nodes");
    await db.exec("ALTER TABLE memory_nodes_v2 RENAME TO memory_nodes");
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_status ON memory_nodes(
        kind, status, updatedAt
      )
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_conversation ON memory_nodes(
        conversationId, updatedAt
      )
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(
        source, sourceId
      )
    `);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  } finally {
    await db.exec(
      `PRAGMA foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`
    );
  }
}

export async function getCodeMemoryDbFeatures(db: any): Promise<{
  hasFts5: boolean;
  hasJson: boolean;
}> {
  return {
    hasFts5: false,
    hasJson: true,
  };
}
