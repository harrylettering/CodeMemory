/**
 * Retrospective baseline for the prior-failure path.
 *
 * The PreToolUse hot path never calls markUsed, so useCount is 0 for every
 * failure node and the database cannot say whether a warning has ever fired.
 * This reconstructs the answer without instrumentation: for each failure that
 * was captured, replay its own anchors through the real lookup and ask whether
 * an *earlier* failure would have been surfaced before it happened.
 *
 * Uses the shipped findFailuresByAnchors and scoreMatch rather than a
 * reimplementation, so the numbers describe the system as built.
 */

import { createCodeMemoryDatabaseConnection } from "../dist/db/connection.js";
import { createMemoryNodeStore } from "../dist/store/memory-store.js";
import { scoreMatch, FAILURE_LOOKUP_MIN_CONFIDENCE } from "../dist/failure-lookup.js";

const dbPath = process.env.CODEMEMORY_DATABASE_PATH
  || `${process.env.HOME}/.claude/codememory.db`;

const db = await createCodeMemoryDatabaseConnection(dbPath);
const store = createMemoryNodeStore(db, {});

const failures = await db.all(
  `SELECT nodeId, conversationId, content, metadata, createdAt, status, useCount
     FROM memory_nodes WHERE kind = 'failure' ORDER BY createdAt ASC`
);

const tagsFor = async (nodeId) =>
  db.all(`SELECT tagType, tagValue FROM memory_tags WHERE nodeId = ?`, nodeId);

const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);

console.log(`\n数据库: ${dbPath}`);
console.log(`失败节点: ${failures.length}\n`);

// ---- 1. anchor 覆盖率 -----------------------------------------------------
console.log("① Anchor 覆盖率  —— 没有 anchor 的失败永远不可能被召回");
const anchorCounts = { file: 0, command: 0, symbol: 0, signature: 0 };
const perNode = new Map();
let noAnchor = 0;
for (const f of failures) {
  const tags = await tagsFor(f.nodeId);
  const byType = {};
  for (const t of tags) (byType[t.tagType] ??= []).push(t.tagValue);
  perNode.set(f.nodeId, byType);
  for (const k of Object.keys(anchorCounts)) if (byType[k]?.length) anchorCounts[k]++;
  if (!byType.file?.length && !byType.command?.length && !byType.symbol?.length) noAnchor++;
}
for (const [k, v] of Object.entries(anchorCounts)) {
  line(`带 ${k} tag 的节点`, `${v}/${failures.length}  ${pct(v, failures.length)}`);
}
line("无任何 file/command/symbol anchor", `${noAnchor}  ${pct(noAnchor, failures.length)}`);

// ---- 2. signature 泛化性 --------------------------------------------------
console.log("\n② Signature 泛化性  —— 过长 = 掺进了一次性上下文，永远匹配不上");
const sigLens = [];
for (const [, byType] of perNode) for (const s of byType.signature ?? []) sigLens.push(s.length);
sigLens.sort((a, b) => a - b);
if (sigLens.length) {
  const at = (p) => sigLens[Math.min(sigLens.length - 1, Math.floor(sigLens.length * p))];
  line("signature 数量", sigLens.length);
  line("长度 中位数 / p90 / 最大", `${at(0.5)} / ${at(0.9)} / ${sigLens[sigLens.length - 1]}`);
  const short = sigLens.filter((l) => l <= 120).length;
  line("≤120 字符（可复用指纹）", `${short}  ${pct(short, sigLens.length)}`);
}

// ---- 3. 回溯召回模拟 ------------------------------------------------------
console.log("\n③ 回溯召回  —— 每个失败发生时，之前的失败会不会被拦下来");
let wouldWarn = 0, hadEarlierCandidate = 0, belowThreshold = 0;
const now = Date.now();
for (let i = 0; i < failures.length; i++) {
  const f = failures[i];
  const byType = perNode.get(f.nodeId) ?? {};
  const candidates = await store.findFailuresByAnchors({
    files: byType.file, commands: byType.command,
    symbols: byType.symbol, signatures: byType.signature,
    limit: 20,
  });
  // 只保留严格早于当前失败的节点：模拟"当时"的库状态
  const earlier = candidates.filter(
    (c) => c.node.nodeId !== f.nodeId && c.node.createdAt < f.createdAt
  );
  if (earlier.length === 0) continue;
  hadEarlierCandidate++;
  // scoreMatch compares the stored node against the target being touched, so
  // replay this failure's own file/command as if a tool were about to run it.
  const meta = (() => { try { return JSON.parse(f.metadata || "{}"); } catch { return {}; } })();
  const targets = {
    filePath: meta.filePath ?? byType.file?.[0],
    command: meta.command ?? byType.command?.[0],
  };
  const at = new Date(f.createdAt).getTime() || now;
  const passing = earlier.filter(
    (c) => scoreMatch(c.node, targets, at) >= FAILURE_LOOKUP_MIN_CONFIDENCE
  );
  if (passing.length > 0) wouldWarn++; else belowThreshold++;
}
line("有更早的同 anchor 候选", `${hadEarlierCandidate}/${failures.length}  ${pct(hadEarlierCandidate, failures.length)}`);
line("其中会真正触发警告", `${wouldWarn}  ${pct(wouldWarn, hadEarlierCandidate)}`);
line("被置信度阈值挡下", `${belowThreshold}`);
line("阈值", FAILURE_LOOKUP_MIN_CONFIDENCE);

// ---- 4. 复发 --------------------------------------------------------------
console.log("\n④ 复发  —— 记忆本该阻止的事");
const reopen = await db.get(
  `SELECT COUNT(*) n FROM memory_lifecycle_events WHERE eventType = 'reopen_failure'`
);
const dupSig = await db.all(
  `SELECT t.tagValue, COUNT(DISTINCT n.nodeId) c FROM memory_tags t
     JOIN memory_nodes n ON n.nodeId = t.nodeId
    WHERE t.tagType='signature' AND n.kind='failure'
    GROUP BY t.tagValue HAVING c > 1`
);
line("reopen_failure 事件", reopen?.n ?? 0);
line("出现 >1 次的 signature", dupSig.length);
line("failure 节点累计被检索命中", failures.reduce((s, f) => s + (f.useCount || 0), 0));

// ---- 5. 实测埋点 ----------------------------------------------------------
const hasEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='failure_lookup_events'`
);
if (hasEvents) {
  const rows = await db.all(
    `SELECT outcome, COUNT(*) n FROM failure_lookup_events GROUP BY outcome ORDER BY n DESC`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑤ 实测查找结果  —— 埋点上线后才有数据");
  if (total === 0) {
    line("记录数", "0（埋点已就绪，尚未产生数据）");
  } else {
    for (const r of rows) line(r.outcome, `${r.n}  ${pct(r.n, total)}`);
    const injected = rows.find((r) => r.outcome === "injected")?.n ?? 0;
    const hadSomething = rows
      .filter((r) => r.outcome !== "no_target" && r.outcome !== "no_candidates")
      .reduce((s, r) => s + r.n, 0);
    line("注入率（占全部查找）", pct(injected, total));
    if (hadSomething > 0) {
      line("有候选时的注入率", pct(injected, hadSomething));
    }
    const supp = await db.get(
      `SELECT COUNT(*) n, MAX(topScore) best FROM failure_lookup_events
        WHERE outcome = 'below_confidence'`
    );
    if (supp?.n) {
      line("被阈值挡下时的最高分", `${(supp.best ?? 0).toFixed(2)} (阈值 ${FAILURE_LOOKUP_MIN_CONFIDENCE})`);
    }
  }
}

await db.close();
console.log("");
