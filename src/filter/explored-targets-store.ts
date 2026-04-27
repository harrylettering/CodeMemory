/**
 * Persistence adapter for the Filter/Score dedup state.
 *
 * The scorer keeps `exploredTargets` in memory; this module rehydrates
 * that map from SQLite at daemon startup and flushes dirty entries back
 * after each scoreMessage call. Kept as a separate module so the scorer
 * itself stays a pure function and has no direct DB dependency.
 */

import type { ScorerSessionState } from "./scorer.js";

/**
 * Load recently-seen exploration targets for a conversation. Entries
 * older than `windowMs` are skipped — they wouldn't block a re-read
 * anyway, so there's no reason to pull them into memory.
 */
export async function loadExploredTargets(
  db: any,
  conversationId: number,
  windowMs: number,
  nowMs: number = Date.now()
): Promise<Map<string, number>> {
  const cutoff = nowMs - windowMs;
  const rows: Array<{ target: string; lastSeenAt: number }> = await db.all(
    `SELECT target, lastSeenAt FROM explored_targets
     WHERE conversationId = ? AND lastSeenAt >= ?`,
    conversationId,
    cutoff
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.target, r.lastSeenAt);
  }
  return map;
}

/**
 * Persist any targets added or refreshed during recent scoreMessage calls.
 * Clears `_dirtyTargets` on success so each flush is idempotent from the
 * caller's perspective. Uses a single transaction — the cost is one DB
 * round-trip per ingested message with exploration activity.
 */
export async function flushExploredTargets(
  db: any,
  conversationId: number,
  state: ScorerSessionState
): Promise<void> {
  if (state._dirtyTargets.size === 0) return;

  const dirtyList = Array.from(state._dirtyTargets);
  await db.exec("BEGIN");
  try {
    for (const target of dirtyList) {
      const lastSeen = state.exploredTargets.get(target);
      if (lastSeen === undefined) continue;
      await db.run(
        `INSERT INTO explored_targets (conversationId, target, lastSeenAt)
         VALUES (?, ?, ?)
         ON CONFLICT(conversationId, target)
         DO UPDATE SET lastSeenAt = excluded.lastSeenAt`,
        conversationId,
        target,
        lastSeen
      );
    }
    await db.exec("COMMIT");
    state._dirtyTargets.clear();
  } catch (err) {
    await db.exec("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Drop entries older than `windowMs` from the table. Optional — the
 * table is self-bounded in practice (one row per file a session reads),
 * but a periodic sweep keeps size predictable for long-lived projects.
 */
export async function pruneExploredTargets(
  db: any,
  conversationId: number,
  windowMs: number,
  nowMs: number = Date.now()
): Promise<number> {
  const cutoff = nowMs - windowMs;
  const result = await db.run(
    `DELETE FROM explored_targets
     WHERE conversationId = ? AND lastSeenAt < ?`,
    conversationId,
    cutoff
  );
  return result?.changes ?? 0;
}
