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

// ---- 6. 漏警归因 ----------------------------------------------------------
// The point of the telemetry: for each failure that happened, was there an
// earlier lookup on the same target that could have warned and did not — and
// which layer swallowed it. This is only answerable because the recorded
// target is stored under the same normalization memory_tags uses.
if (hasEvents) {
  const misses = await db.all(`
    SELECT e.outcome, COUNT(*) n
      FROM memory_nodes f
      JOIN memory_tags ft ON ft.nodeId = f.nodeId AND ft.tagType = 'file'
      JOIN failure_lookup_events e
        ON e.targetFileTag = ft.tagValue
       AND e.createdAt < f.createdAt
     WHERE f.kind = 'failure'
       AND e.outcome <> 'injected'
     GROUP BY e.outcome
     ORDER BY n DESC
  `);
  const warned = await db.get(`
    SELECT COUNT(DISTINCT f.nodeId) n
      FROM memory_nodes f
      JOIN memory_tags ft ON ft.nodeId = f.nodeId AND ft.tagType = 'file'
      JOIN failure_lookup_events e
        ON e.targetFileTag = ft.tagValue
       AND e.createdAt < f.createdAt
     WHERE f.kind = 'failure' AND e.outcome = 'injected'
  `);
  console.log("\n⑥ 漏警归因  —— 失败发生前，同目标的查找为什么没警告");
  if (misses.length === 0 && !warned?.n) {
    line("可归因的样本", "0（需要埋点上线后运行一段时间）");
  } else {
    line("失败前已警告过（警告未奏效）", warned?.n ?? 0);
    for (const m of misses) line(`失败前查找过但 ${m.outcome}`, m.n);
  }
}

// ---- 7. LLM 判官 ----------------------------------------------------------
// The judge writes a row for every invocation now, which is the only way to
// separate "never triggered" from "triggered and kept everything" from
// "failed on every call". They previously all looked like an empty table.
const hasJudgeEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='decision_judge_events'`
);
if (hasJudgeEvents) {
  const rows = await db.all(
    `SELECT outcome, COUNT(*) n, AVG(latencyMs) ms FROM decision_judge_events
      GROUP BY outcome ORDER BY n DESC`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑦ 自动 supersede 判官  —— 开关打开不等于跑过");
  if (total === 0) {
    line("调用次数", "0（埋点已就绪；此前无法区分「没触发」与「跑了但都判 KEEP」）");
  } else {
    for (const r of rows) {
      const ms = r.ms ? `  均 ${Math.round(r.ms)}ms` : "";
      line(r.outcome, `${r.n}  ${pct(r.n, total)}${ms}`);
    }
    const errs = await db.all(
      `SELECT errorMessage, COUNT(*) n FROM decision_judge_events
        WHERE outcome = 'error' GROUP BY errorMessage ORDER BY n DESC LIMIT 3`
    );
    for (const e of errs) {
      line("  失败原因", `${String(e.errorMessage).slice(0, 70)} ×${e.n}`);
    }
  }
}

// ---- 8. 查询规划器 --------------------------------------------------------
const hasRetrievalEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_events'`
);
if (hasRetrievalEvents) {
  const rows = await db.all(
    `SELECT plannerSource, COUNT(*) n,
            SUM(CASE WHEN outcome = 'injected' THEN 1 ELSE 0 END) injected,
            AVG(memoryNodeCount) nodes
       FROM retrieval_events GROUP BY plannerSource ORDER BY n DESC`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑧ 查询规划器  —— smart 路径有没有被走过，走了有没有更好");
  if (total === 0) {
    line("检索次数", "0（埋点已就绪，尚未产生数据）");
  } else {
    for (const r of rows) {
      line(
        r.plannerSource,
        `${r.n}  ${pct(r.n, total)}   注入率 ${pct(r.injected, r.n)}   均召回 ${(r.nodes ?? 0).toFixed(1)} 节点`
      );
    }
    const fallbacks = await db.all(
      `SELECT plannerError, COUNT(*) n FROM retrieval_events
        WHERE plannerSource = 'fallback' GROUP BY plannerError ORDER BY n DESC LIMIT 3`
    );
    for (const f of fallbacks) {
      line("  fallback 原因", `${String(f.plannerError).slice(0, 70)} ×${f.n}`);
    }

    // The funnel. A low injection rate has opposite fixes depending on which
    // stage lost the candidates.
    const funnel = await db.get(
      `SELECT SUM(candidateCount) cand, SUM(selectedNodeCount) sel,
              SUM(stitchedRelationCount) rel, SUM(summaryEvidenceCount) sum_
         FROM retrieval_events WHERE candidateCount IS NOT NULL`
    );
    if (funnel?.cand != null) {
      line("候选 → 选中", `${funnel.cand} → ${funnel.sel}  存活 ${pct(funnel.sel, funnel.cand)}`);
      line("关系缝合贡献", `${funnel.rel ?? 0} 条边`);
      line("摘要证据贡献", `${funnel.sum_ ?? 0} 条`);
    }

    const byIntent = await db.all(
      `SELECT intent, COUNT(*) n,
              SUM(CASE WHEN outcome = 'injected' THEN 1 ELSE 0 END) injected
         FROM retrieval_events WHERE intent IS NOT NULL
        GROUP BY intent ORDER BY n DESC`
    );
    for (const i of byIntent) {
      line(`  intent ${i.intent}`, `${i.n} 次   注入率 ${pct(i.injected, i.n)}`);
    }

    const paths = await db.get(
      `SELECT SUM(failureHits) f, SUM(decisionHits) d, SUM(messageHits) m
         FROM retrieval_events WHERE failureHits IS NOT NULL`
    );
    if (paths && (paths.f || paths.d || paths.m)) {
      const tot = (paths.f ?? 0) + (paths.d ?? 0) + (paths.m ?? 0);
      line("路径归因 failure", `${paths.f ?? 0}  ${pct(paths.f ?? 0, tot)}`);
      line("路径归因 decision", `${paths.d ?? 0}  ${pct(paths.d ?? 0, tot)}`);
      line("路径归因 message", `${paths.m ?? 0}  ${pct(paths.m ?? 0, tot)}`);
    }
  }
}

// ---- 9. 压缩 --------------------------------------------------------------
// Compression ratio is the value compaction claims to deliver; the fallback
// rate is what silently takes it away. Both belong in the same view.
const hasCompactionEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='compaction_events'`
);
if (hasCompactionEvents) {
  const rows = await db.all(
    `SELECT kind, llmOutcome, COUNT(*) n, AVG(latencyMs) ms,
            SUM(inputChars) inChars, SUM(outputTokens) outTok, SUM(inputCount) inCount
       FROM compaction_events GROUP BY kind, llmOutcome ORDER BY n DESC`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑨ 压缩  —— 摘要是模型写的还是降级截断的");
  if (total === 0) {
    line("压缩次数", "0（埋点已就绪，尚未产生数据）");
  } else {
    for (const r of rows) {
      const ms = r.ms ? `  均 ${Math.round(r.ms)}ms` : "";
      line(`${r.kind} / ${r.llmOutcome}`, `${r.n}  ${pct(r.n, total)}${ms}`);
    }
    const fb = await db.get(
      `SELECT COUNT(*) n FROM compaction_events WHERE usedFallback = 1`
    );
    line("降级率", `${pct(fb?.n ?? 0, total)}  （降级 = 存的是原文片段，不是摘要）`);

    const ratio = await db.get(
      `SELECT SUM(inputChars) inChars, SUM(outputTokens) outTok
         FROM compaction_events WHERE kind = 'leaf'`
    );
    if (ratio?.inChars) {
      const inTok = Math.ceil(ratio.inChars / 4);
      line("leaf 压缩比", `${inTok} → ${ratio.outTok} tokens  (${pct(ratio.outTok, inTok)})`);
    }

    const errs = await db.all(
      `SELECT errorMessage, COUNT(*) n FROM compaction_events
        WHERE errorMessage IS NOT NULL GROUP BY errorMessage ORDER BY n DESC LIMIT 3`
    );
    for (const e of errs) {
      line("  降级原因", `${String(e.errorMessage).slice(0, 70)} ×${e.n}`);
    }
  }
}

// ---- 10. 写入侧 ------------------------------------------------------------
// The drop rate is the filter's whole value proposition and its whole risk.
// Too low and noise reaches storage; too high and the memory is missing the
// thing you will look for later.
const hasIngestionEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='ingestion_events'`
);
if (hasIngestionEvents) {
  const rows = await db.all(
    `SELECT tier, COUNT(*) n, SUM(rawChars) raw, SUM(storedChars) kept
       FROM ingestion_events GROUP BY tier ORDER BY tier`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑩ 写入侧  —— 进来多少，留下多少");
  if (total === 0) {
    line("消息数", "0（埋点已就绪，尚未产生数据）");
  } else {
    for (const r of rows) {
      line(`tier ${r.tier}`, `${r.n}  ${pct(r.n, total)}`);
    }
    const dropped = rows.find((r) => r.tier === "N")?.n ?? 0;
    line("丢弃率", pct(dropped, total));

    const raw = rows.reduce((s, r) => s + (r.raw ?? 0), 0);
    const kept = rows.reduce((s, r) => s + (r.kept ?? 0), 0);
    if (raw > 0) line("字符留存", `${raw} → ${kept}  ${pct(kept, raw)}`);

    // Which rule did the discarding. A single tag dominating the drops is
    // worth reading as either the filter working or one rule overreaching.
    const dropRows = await db.all(
      `SELECT tags FROM ingestion_events WHERE tier = 'N' AND tags IS NOT NULL`
    );
    const tagCounts = {};
    for (const r of dropRows) {
      try {
        for (const t of JSON.parse(r.tags)) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      } catch {
        /* malformed tag blob */
      }
    }
    for (const [tag, n] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      line(`  丢弃原因 ${tag}`, `${n}  ${pct(n, dropped)}`);
    }

    const sub = await db.get(
      `SELECT COUNT(*) n FROM ingestion_events WHERE subagent = 1`
    );
    if (sub?.n) line("来自 subagent", `${sub.n}  ${pct(sub.n, total)}`);
  }
}

// ---- 11. 关键记忆抽取 ------------------------------------------------------
const hasExtractionEvents = await db.get(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_events'`
);
if (hasExtractionEvents) {
  const rows = await db.all(
    `SELECT outcome, COUNT(*) n, AVG(latencyMs) ms FROM extraction_events
      GROUP BY outcome ORDER BY n DESC`
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log("\n⑪ 关键记忆抽取  —— 报出来的条数，是几个 chunk 换来的");
  if (total === 0) {
    line("chunk 调用", "0（埋点已就绪，尚未产生数据）");
  } else {
    for (const r of rows) {
      const ms = r.ms ? `  均 ${Math.round(r.ms / 1000)}s` : "";
      line(r.outcome, `${r.n}  ${pct(r.n, total)}${ms}`);
    }
    const runs = await db.all(
      `SELECT runId, COUNT(*) chunks,
              SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) okChunks,
              SUM(itemCount) items, SUM(revisesCount) revises,
              MAX(sourceRawChars) raw, MAX(sourceProseChars) prose
         FROM extraction_events GROUP BY runId ORDER BY runId DESC LIMIT 5`
    );
    for (const r of runs) {
      line(
        `  ${r.runId}`,
        `${r.okChunks}/${r.chunks} chunk 成功，产出 ${r.items} 条（含 ${r.revises} 条修订）`
      );
      if (r.raw) {
        line("    prose 过滤", `${r.raw} → ${r.prose}  ${pct(r.prose, r.raw)}`);
      }
    }
  }
}

await db.close();
console.log("");
