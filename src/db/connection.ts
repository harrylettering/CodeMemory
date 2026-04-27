/**
 * CodeMemory for Claude Code - Database Connection Management
 *
 * SQLite database connection handling with migration support.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

export async function createCodeMemoryDatabaseConnection(dbPath: string): Promise<any> {
  const dbDir = dirname(dbPath);
  await mkdir(dbDir, { recursive: true });

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  await runCodeMemoryMigrations(db);

  return db;
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
    await db.exec("PRAGMA foreign_keys = ON");
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
