/**
 * One-off repair for file tags written with the wrong workspace key.
 *
 * The daemon qualified file tags against its own cwd, which is the plugin
 * install directory and therefore identical for every project. Every repo on
 * this machine hashed to one key, so tags collided across projects, and any
 * absolute path failed to relativize and was stored raw.
 *
 * This rewrites each affected tag using the project directory recorded in the
 * session transcript. Run with --apply; the default is a dry run.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const DB_PATH = join(homedir(), ".claude", "codememory.db");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

const keyFor = (root) =>
  createHash("sha256").update(root).digest("hex").slice(0, 8);

/** Recover a session's project directory from the `cwd` field of its transcript. */
function projectDirForSession(sessionId) {
  let dirs;
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    try {
      statSync(f);
    } catch {
      continue;
    }
    for (const line of readFileSync(f, "utf-8").split("\n").slice(0, 200)) {
      if (!line.trim()) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch {
        /* partial line */
      }
    }
  }
  return null;
}

const db = new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: false });

const roots = new Map();
for (const c of db.prepare("select conversationId, sessionId from conversations").all()) {
  const dir = projectDirForSession(c.sessionId);
  roots.set(c.conversationId, dir);
  console.log(
    `conv${c.conversationId}  ${c.sessionId}  ->  ${dir ?? "<unresolved>"}${dir ? `  key=${keyFor(dir)}` : ""}`
  );
}

const rows = db
  .prepare(
    `select t.nodeId, t.tagType, t.tagValue, t.weight, t.createdAt, n.conversationId
       from memory_tags t join memory_nodes n on n.nodeId = t.nodeId
      where t.tagType = 'file'`
  )
  .all();

const plan = [];
let skippedNoRoot = 0;
for (const r of rows) {
  const root = roots.get(r.conversationId);
  if (!root) {
    skippedNoRoot++;
    continue;
  }
  const correct = keyFor(root);
  const m = /^([0-9a-f]{8}):(.*)$/.exec(r.tagValue);

  let next = null;
  if (m) {
    // Already qualified: only the prefix is wrong.
    if (m[1] !== correct) next = `${correct}:${m[2]}`;
  } else if (isAbsolute(r.tagValue)) {
    // Never qualified because relativizing against the plugin dir failed.
    const rel = relative(root, r.tagValue);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      next = `${correct}:${rel.split(sep).join("/")}`;
    }
  }
  if (next && next !== r.tagValue) plan.push({ ...r, next });
}

console.log(`\n${rows.length} file tags, ${plan.length} need rewriting, ${skippedNoRoot} skipped (project dir unresolved)\n`);
for (const p of plan) {
  console.log(`  conv${p.conversationId} ${p.nodeId}`);
  console.log(`    - ${p.tagValue}`);
  console.log(`    + ${p.next}`);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

// Rewrite as delete+insert: tagValue is part of the primary key, and the
// corrected value may already exist on the same node.
db.exec("BEGIN");
try {
  let updated = 0;
  let merged = 0;
  const del = db.prepare(
    "delete from memory_tags where nodeId=? and tagType=? and tagValue=?"
  );
  const ins = db.prepare(
    "insert or ignore into memory_tags (nodeId, tagType, tagValue, weight, createdAt) values (?,?,?,?,?)"
  );
  const exists = db.prepare(
    "select 1 from memory_tags where nodeId=? and tagType=? and tagValue=?"
  );
  for (const p of plan) {
    const collides = exists.get(p.nodeId, p.tagType, p.next) !== undefined;
    del.run(p.nodeId, p.tagType, p.tagValue);
    ins.run(p.nodeId, p.tagType, p.next, p.weight, p.createdAt);
    if (collides) merged++;
    else updated++;
  }
  db.exec("COMMIT");
  console.log(`\nApplied: ${updated} rewritten, ${merged} merged into an existing tag.`);
} catch (err) {
  db.exec("ROLLBACK");
  console.error("Rolled back:", err);
  process.exit(1);
}
