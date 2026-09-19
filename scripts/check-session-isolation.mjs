/**
 * Acceptance check for session isolation.
 *
 * Memory recall had no conversation boundary: a prompt in one session could
 * surface nodes another session produced. This counts how often that actually
 * happened, using what retrieval already records rather than a reconstruction.
 *
 * `retrieval_events.surfacedNodeIds` names exactly what was injected, and each
 * node carries the conversation it came from, so the two sides join directly.
 *
 * Usage:
 *   node scripts/check-session-isolation.mjs [--since 2026-09-19] [--db path]
 *
 * --since matters for acceptance: isolation only affects rows written after
 * the change ships, so counting the whole table will always report failure.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath =
  argOf("--db") ||
  process.env.CODEMEMORY_DATABASE_PATH ||
  join(homedir(), ".claude", "codememory.db");
const since = argOf("--since");

const db = new DatabaseSync(dbPath, { readOnly: true });

const nodeConversation = new Map(
  db
    .prepare("SELECT nodeId, conversationId FROM memory_nodes")
    .all()
    .map((r) => [r.nodeId, r.conversationId])
);

const rows = db
  .prepare(
    `SELECT conversationId, surfacedNodeIds, createdAt
       FROM retrieval_events
      WHERE surfacedNodeIds IS NOT NULL
        ${since ? "AND createdAt >= ?" : ""}
      ORDER BY createdAt`
  )
  .all(...(since ? [since] : []));

let sameSession = 0;
let crossSession = 0;
let unknown = 0;
const offenders = new Map();

for (const row of rows) {
  let ids;
  try {
    ids = JSON.parse(row.surfacedNodeIds);
  } catch {
    continue;
  }
  for (const nodeId of ids) {
    const owner = nodeConversation.get(nodeId);
    if (owner == null) {
      // The node was purged after being surfaced. Counted separately rather
      // than guessed at, so it cannot quietly pad either side.
      unknown++;
      continue;
    }
    if (owner === row.conversationId) {
      sameSession++;
    } else {
      crossSession++;
      const key = `conv${row.conversationId} ← conv${owner}`;
      offenders.set(key, (offenders.get(key) ?? 0) + 1);
    }
  }
}

const total = sameSession + crossSession;
const pct = (n) => (total === 0 ? "n/a" : `${((n / total) * 100).toFixed(1)}%`);

console.log(`\n数据库: ${dbPath}`);
console.log(`范围:   ${since ? `createdAt >= ${since}` : "全部历史"}`);
console.log(`检索事件（有召回节点的）: ${rows.length}\n`);

console.log(`  召回节点属于本会话   ${String(sameSession).padStart(5)}  ${pct(sameSession)}`);
console.log(`  召回节点属于别的会话 ${String(crossSession).padStart(5)}  ${pct(crossSession)}`);
if (unknown > 0) {
  console.log(`  节点已不存在         ${String(unknown).padStart(5)}  （已被清理，不计入分母）`);
}

if (crossSession > 0) {
  console.log("\n  污染来源:");
  for (const [pair, n] of [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${pair}  ${n} 次`);
  }
}

console.log(
  crossSession === 0
    ? "\n✅ 通过：没有跨会话召回\n"
    : `\n❌ 未通过：${crossSession} 个跨会话召回\n`
);

db.close();
// Exit code carries the verdict so CI or a pre-release check can gate on it.
process.exit(crossSession === 0 ? 0 : 1);
