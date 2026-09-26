/**
 * CodeMemory - Async Compactor
 *
 * Token-threshold triggered summarization of M/L-tier messages.
 * Called from the JSONL ingest path — fires async so it never blocks ingest.
 *
 * Algorithm:
 *   1. After each insertMessage, maybeCompact() checks if uncompacted M/L
 *      tokens exceed the configured threshold.
 *   2. If triggered and no compaction is already in progress for this
 *      conversation, schedules runCompaction() via setImmediate.
 *   3. runCompaction() fetches compactable messages (all uncompacted M/L
 *      excluding the fresh-tail window), batches them by leafChunkTokens,
 *      summarizes each batch via LLM (or truncation fallback), and stores
 *      the result in summaries + summary_messages.
 *
 * "Compacted" detection: a message is compacted iff its messageId appears
 * in summary_messages. No extra column needed.
 */

import { spawn } from "node:child_process";
import { collectCandidateMemories, type CandidateMemory } from "./memory-candidates.js";
import { parseExtractedMemories } from "./extracted-memories.js";
import { applyExtractedMemories } from "./extraction-apply.js";
import { extractPromptPivots, inferTopics, qualifyFileTag } from "../retrieval-plan.js";
import {
  buildClaudeCliArgs,
  claudeCliSpawnEnv,
  describeClaudeCliFailure,
} from "../llm/claude-cli.js";
import type { CodeMemoryConfig } from "../db/config.js";
import { createMemoryNodeStore } from "../store/memory-store.js";

interface SimpleLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

interface MessageRow {
  messageId: number;
  seq: number;
  role: string;
  content: string;
  tokenCount: number;
  tier: string;
  createdAt: string;
}

interface LeafSummaryRow {
  summaryId: string;
  earliestAt: string;
  latestAt: string;
  descendantCount: number;
  content: string;
  tokenCount: number;
}

interface SummaryGenerationOptions {
  kind: "leaf" | "condensed";
  targetTokens: number;
}

/**
 * What actually happened inside one summary generation. The stored summary
 * looks the same whether the model produced it on the first try or a quota
 * error forced the truncation fallback, so the distinction has to be carried
 * out of band.
 */
export interface SummaryGenerationTelemetry {
  llmOutcome:
    | "ok"
    | "ok_after_retry"
    | "validation_failed"
    | "error"
    | "disabled";
  usedFallback: boolean;
  errorMessage?: string;
  model?: string;
  latencyMs: number;
}

interface SummaryQualityCheck {
  ok: boolean;
  reason?: string;
  tokenCount: number;
  maxTokens: number;
}

/** Distinguishes "the model answered badly twice" from "the call failed". */
class ValidationExhaustedError extends Error {}

/**
 * Marker prepended to fallback "summaries" so readers see immediately that
 * the stored content is verbatim fragments, not an LLM-produced summary.
 */
/** Fixed instruction text, outside the input cap. Exported for tests. */
const EXTRACTION_INSTRUCTION =
  'Also report what this window decided, started or constrained, in a "memories" array on that same JSON line. ' +
  'Each entry: {"kind": "decision"|"task"|"constraint", "op": "ADD"|"UPDATE"|"INVALIDATE"|"NOOP", "text": "<one sentence>", "targetNodeId": "<id from KNOWN MEMORIES>", "reason": "<≤80 chars>"}. ' +
  "Take decisions, tasks and constraints from what was SAID in the dialogue; use the tool activity only as evidence that a task finished. Never invent a task from a tool call alone. " +
  "UPDATE or INVALIDATE only a targetNodeId listed under KNOWN MEMORIES; to revise something stated earlier in this same window, use ADD with a \"revises\" field quoting that earlier statement. " +
  'Report nothing rather than guessing: an empty array, or {"op":"NOOP"}, is the right answer for a window that decided nothing.';

const CANDIDATES_HEADING = "=== KNOWN MEMORIES IN THIS SESSION (id · kind/status · date · claim) ===";

export const SUMMARY_PROMPT_PREFIX =
  "Summarize this coding session excerpt for memory. " +
  "Focus on: which files were modified and why, errors encountered and how they were fixed, " +
  "key decisions made, tools invoked. Be concise and factual.\n\n";

const SEPARATOR = "\n\n";
const DIALOGUE_HEADING = "=== DIALOGUE IN THIS WINDOW (what was said) ===";
const MESSAGES_HEADING = "=== TOOL ACTIVITY IN THIS WINDOW ===";

function renderMessage(m: { role: string; content: string }): string {
  return `[${m.role.toUpperCase()}] ${m.content}`;
}

export const TRUNCATION_FALLBACK_MARKER = "[TRUNCATION FALLBACK — LLM unavailable]";

/**
 * Backstop for truncation fallback / unparseable LLM output. The primary
 * anchor signal now comes from a structured JSON header the LLM emits
 * (see `parseSummaryWithMetadata`); this regex only fires when no
 * structured metadata is available.
 */
const SUMMARY_ANCHOR_SIGNAL_RE =
  /\b(decision|decided|chose|rejected|root cause|fixed|failed|failure|error|regression)\b|决定|选择|放弃|拒绝|根因|修复|失败|报错|错误|问题在于/i;

/** Vocabulary the LLM is allowed to emit in the metadata `kinds` field. */
const ANCHOR_KIND_VOCAB = new Set([
  "decision",
  "constraint",
  "task",
  "failure",
  "fix_attempt",
  "root_cause",
  "regression",
  "open_question",
]);

interface SummaryMetadata {
  anchor: boolean;
  kinds: string[];
  reason?: string;
  /**
   * The header object as it arrived. Extraction reads `memories` off it, and
   * only the caller knows which candidate ids were offered, so validation
   * cannot happen here.
   */
  raw?: Record<string, unknown>;
}

/**
 * Parse the JSON metadata header the compaction prompt asks the LLM to
 * emit on the first line. Accepts a bare `{...}` line, a fenced ```json
 * block, or no header at all (returns `metadata: null`). The remaining
 * text is the actual summary body to persist.
 */
function parseSummaryWithMetadata(raw: string): {
  metadata: SummaryMetadata | null;
  content: string;
} {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { metadata: null, content: "" };

  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*\n?([\s\S]*)$/);
  if (fenced) {
    const meta = tryParseMetadata(fenced[1]);
    if (meta) return { metadata: meta, content: fenced[2].trim() };
  }

  const firstLineEnd = trimmed.indexOf("\n");
  const head = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  const rest = firstLineEnd === -1 ? "" : trimmed.slice(firstLineEnd + 1);
  if (head.startsWith("{") && head.endsWith("}")) {
    const meta = tryParseMetadata(head);
    if (meta) return { metadata: meta, content: rest.trim() };
  }

  return { metadata: null, content: trimmed };
}

function tryParseMetadata(text: string): SummaryMetadata | null {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    const kinds = Array.isArray(obj.kinds)
      ? obj.kinds
          .filter((k: unknown): k is string => typeof k === "string")
          .map((k: string) => k.trim().toLowerCase())
          .filter((k: string) => ANCHOR_KIND_VOCAB.has(k))
      : [];
    return {
      anchor: obj.anchor === true,
      kinds,
      reason:
        typeof obj.reason === "string" ? obj.reason.slice(0, 200) : undefined,
      raw: obj,
    };
  } catch {
    return null;
  }
}

const SUMMARY_METADATA_INSTRUCTION =
  'On the very first line, emit exactly one JSON object describing whether this summary is worth anchoring as durable engineering memory. ' +
  'Format: {"anchor": true|false, "kinds": ["decision"|"constraint"|"task"|"failure"|"fix_attempt"|"root_cause"|"regression"|"open_question"], "reason": "<≤120 chars>"}. ' +
  'Set anchor=true ONLY when the summary captures a durable signal: a decision (with rationale), a recurring/root-cause failure or its fix, an explicit constraint or task, or an open question that future sessions must respect. ' +
  'Set anchor=false for routine logs, exploration, trivial mutations, or filler. ' +
  'After the JSON line, leave a blank line, then write the summary itself. Do not repeat the JSON inside the summary body.';

export class AsyncCompactor {
  private readonly compacting = new Map<number, boolean>();

  /**
   * Completion seam. Defaults to spawning `claude --print`; the extractor and
   * the decision judge expose the same hook. Without it a test cannot see the
   * prompt this class assembles, which is now most of what it does.
   */
  private readonly runCompletion: (prompt: string, timeoutMs: number) => Promise<string>;

  constructor(
    private readonly db: any,
    private readonly config: CodeMemoryConfig,
    private readonly logger: SimpleLogger,
    deps: {
      runCompletion?: (prompt: string, timeoutMs: number) => Promise<string>;
    } = {}
  ) {
    this.runCompletion =
      deps.runCompletion ??
      ((prompt, timeoutMs) =>
        spawnWithStdin("claude", buildClaudeCliArgs(this.config.compactionModel), prompt, timeoutMs));
    this.warnIfCondensationUnreachable();
  }

  /**
   * The condensation input window and the leaf size target are set by separate
   * knobs that must satisfy `minFanout × leafTargetTokens <= maxInputTokens` for
   * a batch to ever reach the fanout threshold. Nothing enforced that, so a
   * config where the DAG can never grow a level looked exactly like a config
   * where it simply had not grown yet. Check it once, at construction.
   */
  private warnIfCondensationUnreachable(): void {
    if ((this.config.incrementalMaxDepth ?? 1) < 1) return;

    const minFanout = this.config.condensedMinFanout ?? 4;
    const leafTokens = this.config.leafTargetTokens;
    const maxInputTokens = this.condensationInputWindowTokens();
    const required = minFanout * leafTokens;
    if (required <= maxInputTokens) return;

    this.logger.warn(
      `[compactor] condensation can never trigger with this configuration: ` +
        `minFanout ${minFanout} × leafTargetTokens ${leafTokens} = ${required} tokens ` +
        `exceeds the ${maxInputTokens}-token condensation input window ` +
        `(min(condensedTargetTokens ${this.config.condensedTargetTokens} × 4, ` +
        `compactionMaxInputChars ${this.config.compactionMaxInputChars} ÷ 4)). ` +
        `Every batch will fall below minFanout and the summary DAG will stay flat.`
    );
  }

  /**
   * condensedTargetTokens is the TARGET size of the produced summary; × 4 also
   * serves as the input window so a batch stays summarizable in one LLM call.
   */
  private condensationInputWindowTokens(): number {
    const targetTokens = this.config.condensedTargetTokens ?? 2000;
    return Math.min(
      targetTokens * 4,
      Math.floor(this.config.compactionMaxInputChars / 4)
    );
  }

  /**
   * Called after every insertMessage. Non-blocking: schedules a background
   * check via setImmediate so the ingest path returns immediately.
   */
  maybeCompact(conversationId: number): void {
    if (!this.config.compactionEnabled) return;
    if (this.compacting.get(conversationId)) return;

    setImmediate(() => {
      this.checkAndCompact(conversationId).catch((err) =>
        this.logger.warn(`[compactor] background check failed: ${err}`)
      );
    });
  }

  /**
   * Force compaction regardless of threshold. Used by explicit triggers
   * (codememory_compact, engine.compact, daemon /compact endpoint). Returns the
   * summary IDs created during this run so callers can report them.
   * Empty array when the call was skipped (already running) or when there
   * was nothing to compact.
   */
  async forceCompact(
    conversationId: number,
    options: { includeFreshTail?: boolean } = {}
  ): Promise<string[]> {
    if (this.compacting.get(conversationId)) {
      this.logger.info(`[compactor] compaction already in progress for conv ${conversationId}, skipping`);
      return [];
    }
    this.compacting.set(conversationId, true);
    try {
      return await this.runCompaction(conversationId, options);
    } catch (err) {
      this.logger.error(`[compactor] forceCompact failed for conv ${conversationId}: ${err}`);
      return [];
    } finally {
      this.compacting.set(conversationId, false);
    }
  }

  private async checkAndCompact(conversationId: number): Promise<void> {
    // Double-check inside async context (guard against concurrent fires)
    if (this.compacting.get(conversationId)) return;

    const row: { totalTokens: number | null } | undefined = await this.db.get(
      `SELECT SUM(m.tokenCount) as totalTokens
       FROM conversation_messages m
       WHERE m.conversationId = ?
         AND m.tier IN ('M', 'L')
         AND m.messageId NOT IN (SELECT messageId FROM summary_messages)`,
      conversationId
    );

    const totalTokens = row?.totalTokens ?? 0;
    if (totalTokens < this.config.compactionTokenThreshold) return;

    this.logger.info(
      `[compactor] threshold exceeded (${totalTokens} tokens > ${this.config.compactionTokenThreshold}), starting compaction for conv ${conversationId}`
    );

    this.compacting.set(conversationId, true);
    try {
      await this.runCompaction(conversationId);
    } catch (err) {
      this.logger.error(`[compactor] compaction failed for conv ${conversationId}: ${err}`);
    } finally {
      this.compacting.set(conversationId, false);
    }
  }

  private async runCompaction(
    conversationId: number,
    options: { includeFreshTail?: boolean } = {}
  ): Promise<string[]> {
    const allMessages: MessageRow[] = await this.db.all(
      `SELECT messageId, seq, role, content, tokenCount, tier, createdAt
       FROM conversation_messages
       WHERE conversationId = ?
         AND tier IN ('M', 'L')
         AND messageId NOT IN (SELECT messageId FROM summary_messages)
       ORDER BY seq ASC`,
      conversationId
    );

    if (allMessages.length === 0) return [];

    // Preserve the fresh tail — these messages stay uncompacted. Except at
    // SessionEnd: nothing is fresh once the session is over, and holding the
    // last 20 messages back means a session's conclusions are never
    // summarized, nor read by the extraction that rides this call. A short
    // session would otherwise never be compacted at all.
    const freshTail = options.includeFreshTail
      ? 0
      : this.config.compactionFreshTailCount;
    const compactable =
      allMessages.length > freshTail
        ? allMessages.slice(0, allMessages.length - freshTail)
        : [];

    if (compactable.length === 0) {
      this.logger.debug(
        `[compactor] all ${allMessages.length} messages are within fresh-tail window, skipping`
      );
      return [];
    }

    // Counted as rendered, not estimated. `tokenCount * 4` understated the
    // real text -- measured ratio 4.11, plus the `[ROLE] ` prefixes -- so 82
    // of 136 leaf batches overflowed the cap and lost their tails inside
    // summarize().
    const batches = this.batchByChars(
      compactable,
      this.config.compactionBatchChars,
      this.config.leafChunkTokens ?? 20000
    );

    this.logger.info(
      `[compactor] compacting ${compactable.length} messages into ${batches.length} summary batch(es)`
    );

    // Dialogue is attributed to a batch by a contiguous seq range, not by the
    // batch's own first message. A window's prose usually opens it -- the user
    // says what to do, then the tools run -- so a range starting at the first
    // M/L message would drop exactly the message that states the task.
    const covered: { maxSeq: number | null } | undefined = await this.db.get(
      `SELECT MAX(m.seq) AS maxSeq
         FROM summary_messages sm
         JOIN conversation_messages m ON m.messageId = sm.messageId
        WHERE m.conversationId = ?`,
      conversationId
    );
    let dialogueFrom = (covered?.maxSeq ?? -1) + 1;

    const createdIds: string[] = [];
    for (const batch of batches) {
      const id = await this.compactBatch(conversationId, batch, dialogueFrom);
      dialogueFrom = batch[batch.length - 1].seq + 1;
      createdIds.push(id);
    }

    // One window per run, after this run's own batches: a fallback is usually
    // a session limit, and retrying inside the same minute would hit it again.
    // Never at the expense of the compaction itself -- telemetry is where the
    // pending window is recorded, and a missing table must not abort the run.
    try {
      await this.retryPendingExtraction(conversationId);
    } catch (err) {
      this.logger.debug(`[compactor] extraction retry skipped: ${err}`);
    }

    // After leaves are written, try a single condensation pass. Bounded by
    // incrementalMaxDepth so each trigger only climbs one level.
    const condensedIds = await this.runCondensation(conversationId);
    return [...createdIds, ...condensedIds];
  }

  /**
   * Condense un-parented leaf summaries into `kind='condensed'` rows when
   * the fanout threshold is met. Bounded by `incrementalMaxDepth` — we only
   * promote one depth level per call, so long-lived conversations climb
   * incrementally across many triggers.
   */
  private async runCondensation(conversationId: number): Promise<string[]> {
    if ((this.config.incrementalMaxDepth ?? 1) < 1) return [];

    const orphans: LeafSummaryRow[] = await this.db.all(
      `SELECT summaryId, earliestAt, latestAt, descendantCount, content, tokenCount
       FROM summaries
       WHERE conversationId = ?
         AND kind = 'leaf'
         AND summaryId NOT IN (SELECT summaryId FROM summary_parents)
       ORDER BY earliestAt ASC`,
      conversationId
    );

    const minFanout = this.config.condensedMinFanout ?? 4;
    if (orphans.length < minFanout) {
      this.logger.debug(
        `[compactor] condensation skipped: ${orphans.length} un-parented leaves < minFanout ${minFanout}`
      );
      return [];
    }

    // Batch orphan leaves by token budget so each condensed row stays within a
    // sane size.
    const maxInputTokens = this.condensationInputWindowTokens();
    const batches = this.batchLeavesByTokens(orphans, maxInputTokens);

    const createdIds: string[] = [];
    let skippedBatches = 0;
    for (const batch of batches) {
      if (batch.length < minFanout && batches.length > 1) {
        // A trailing sub-fanout batch (e.g. 7 leaves / minFanout 4 → [4,3]):
        // leave the stragglers un-parented so they can join the next pass.
        skippedBatches++;
        continue;
      }
      const id = await this.condenseBatch(conversationId, batch);
      createdIds.push(id);
    }

    // Report what happened, not what was attempted. This used to log
    // "condensing N leaves into M condensed summary/ies" *before* the loop, so
    // a pass that skipped every batch still read as a success — the DAG stayed
    // flat for months while the log claimed otherwise.
    if (createdIds.length > 0) {
      this.logger.info(
        `[compactor] condensed ${orphans.length - skippedBatches * minFanout} of ${orphans.length} un-parented leaves into ${createdIds.length} summary/ies (${skippedBatches} batch(es) left for the next pass)`
      );
    } else {
      this.warnCondensationStarved(orphans, batches.length, maxInputTokens, minFanout);
    }

    return createdIds;
  }

  /**
   * Every batch fell below minFanout, so condensation ran and produced nothing.
   * That happens when leaves are large relative to the condensation input
   * window: at `maxInputTokens` 6000 with 3600-token leaves, each batch holds a
   * single leaf and the sub-fanout guard then discards all of them. The DAG can
   * never grow a level in that state, so say so with the numbers needed to fix
   * it rather than failing silently.
   */
  private warnCondensationStarved(
    orphans: LeafSummaryRow[],
    batchCount: number,
    maxInputTokens: number,
    minFanout: number
  ): void {
    const totalTokens = orphans.reduce((sum, l) => sum + (l.tokenCount ?? 0), 0);
    const avgLeafTokens = Math.round(totalTokens / Math.max(orphans.length, 1));
    const leavesPerBatch = Math.floor(maxInputTokens / Math.max(avgLeafTokens, 1));

    this.logger.warn(
      `[compactor] condensation produced nothing: ${orphans.length} un-parented leaves ` +
        `formed ${batchCount} batch(es), all below minFanout ${minFanout}. ` +
        `Leaves average ${avgLeafTokens} tokens against a ${maxInputTokens}-token input window, ` +
        `so a batch holds about ${leavesPerBatch}. ` +
        `Raise CODEMEMORY_CONDENSED_TARGET_TOKENS or CODEMEMORY_COMPACTION_MAX_INPUT_CHARS, ` +
        `lower CODEMEMORY_CONDENSED_MIN_FANOUT, or find out why leaves are oversized ` +
        `(truncation fallbacks are pinned at the fallback cap, not leafTargetTokens).`
    );
  }

  private batchLeavesByTokens(leaves: LeafSummaryRow[], maxTokens: number): LeafSummaryRow[][] {
    const batches: LeafSummaryRow[][] = [];
    let current: LeafSummaryRow[] = [];
    let currentTokens = 0;

    for (const leaf of leaves) {
      if (currentTokens + leaf.tokenCount > maxTokens && current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(leaf);
      currentTokens += leaf.tokenCount;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async condenseBatch(
    conversationId: number,
    leaves: LeafSummaryRow[]
  ): Promise<string> {
    const combined = leaves
      .map((l, i) => `## Leaf summary ${i + 1} (${l.earliestAt} — ${l.latestAt})\n${l.content}`)
      .join("\n\n---\n\n");

    const prompt =
      "You are combining several coding-session leaf summaries into one higher-level summary. " +
      "Preserve: file-level decisions, recurring errors and their fixes, open questions, and any explicit decisions. " +
      "Drop turn-by-turn detail. Be concise.\n\n" +
      SUMMARY_METADATA_INSTRUCTION +
      "\n\n" +
      combined;

    const {
      content: summaryText,
      metadata: summaryMetadata,
      telemetry,
    } = await this.callLlmOrTruncate(prompt, combined, {
      kind: "condensed",
      targetTokens: this.config.condensedTargetTokens,
    });

    const summaryId = `cond-${conversationId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const earliestAt = leaves[0].earliestAt;
    const latestAt = leaves[leaves.length - 1].latestAt;
    const descendantCount = leaves.reduce((sum, l) => sum + (l.descendantCount ?? 0), 0);
    const tokenCount = Math.ceil(summaryText.length / 4);

    await this.db.run(
      `INSERT INTO summaries
         (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount)
       VALUES (?, ?, 'condensed', 1, ?, ?, ?, ?, ?)`,
      [summaryId, conversationId, earliestAt, latestAt, descendantCount, summaryText, tokenCount]
    );

    for (let i = 0; i < leaves.length; i++) {
      await this.db.run(
        "INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)",
        [leaves[i].summaryId, summaryId, i]
      );
    }

    await this.createSummaryMemoryNode(
      {
        summaryId,
        conversationId,
        kind: "condensed",
        depth: 1,
        earliestAt,
        latestAt,
        descendantCount,
        content: summaryText,
        tokenCount,
        createdAt: new Date().toISOString(),
      },
      summaryMetadata
    );

    await this.recordCompactionEvent({
      conversationId,
      kind: "condensed",
      summaryId,
      inputCount: leaves.length,
      inputChars: combined.length,
      outputTokens: tokenCount,
      telemetry,
    });

    this.logger.debug(
      `[compactor] created condensed ${summaryId} covering ${leaves.length} leaves (${tokenCount} tokens)`
    );
    return summaryId;
  }

  /**
   * Closes a batch on whichever bound is reached first: the characters this
   * class will actually send, or `leafChunkTokens`. The token bound is what
   * the condensation fanout math is expressed in, so it stays; the character
   * bound is the one that was missing, and the one that decides whether
   * summarize() has to cut the tail off.
   */
  private batchByChars(
    messages: MessageRow[],
    maxChars: number,
    maxTokens: number
  ): MessageRow[][] {
    const batches: MessageRow[][] = [];
    let current: MessageRow[] = [];
    let currentChars = 0;
    let currentTokens = 0;

    for (const msg of messages) {
      const cost = renderMessage(msg).length + SEPARATOR.length;
      const overChars = currentChars + cost > maxChars;
      const overTokens = currentTokens + msg.tokenCount > maxTokens;
      if ((overChars || overTokens) && current.length > 0) {
        batches.push(current);
        current = [];
        currentChars = 0;
        currentTokens = 0;
      }
      current.push(msg);
      currentChars += cost;
      currentTokens += msg.tokenCount;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /**
   * Anchors for the fallback candidate scan: what this window touched.
   *
   * Files and commands come from the tool metadata, symbols and topics from
   * what was said. Node tags are sparse on files (21) and topics (25) and
   * dense on symbols (415), so symbols carry most of this.
   */
  private anchorsFromWindow(toolActivity: string, dialogue: string) {
    const pivots = extractPromptPivots(`${dialogue}\n${toolActivity}`);
    return {
      files: pivots.filePaths.map(qualifyFileTag),
      commands: pivots.commands,
      symbols: pivots.symbols,
      topics: inferTopics(dialogue, pivots),
    };
  }

  /**
   * The window's own dialogue: S-tier prose in the same seq range.
   *
   * Compaction reads M/L -- tool metadata -- while decisions, tasks and
   * constraints are stated in prose. S-tier tool results are left out: they
   * are error output, already covered by failure nodes, and 29% of S-tier
   * characters.
   *
   * Oldest are dropped first when over budget: a window's conclusions sit at
   * its end.
   */
  private async dialogueForRange(
    conversationId: number,
    loSeq: number,
    hiSeq: number
  ): Promise<string> {
    const rows: MessageRow[] = await this.db.all(
      `SELECT messageId, seq, role, content, tokenCount, tier, createdAt
         FROM conversation_messages
        WHERE conversationId = ?
          AND seq BETWEEN ? AND ?
          AND tier = 'S'
          AND (tags IS NULL OR tags NOT LIKE '%"tool_result"%')
        ORDER BY seq ASC`,
      [conversationId, loSeq, hiSeq]
    );
    if (rows.length === 0) return "";

    const budget = this.config.compactionDialogueChars;
    const kept: string[] = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const rendered = renderMessage(rows[i]);
      if (used + rendered.length > budget) break;
      kept.unshift(rendered);
      used += rendered.length + SEPARATOR.length;
    }
    return kept.join(SEPARATOR);
  }

  private async compactBatch(
    conversationId: number,
    messages: MessageRow[],
    dialogueFromSeq = messages[0].seq
  ): Promise<string> {
    const combined = messages.map(renderMessage).join(SEPARATOR);
    const dialogue = await this.dialogueForRange(
      conversationId,
      Math.min(dialogueFromSeq, messages[0].seq),
      messages[messages.length - 1].seq
    );

    // Extraction only runs where there is something to extract from: 16% of
    // real windows are pure tool calls, and those must not pay for the
    // instruction, the candidate list or the dialogue section.
    let candidates: CandidateMemory[] = [];
    let candidatesRendered = "";
    let candidatesDropped = 0;
    let candidateSources = { fromSurfaced: 0, fromRecentWrites: 0, fromTagScan: 0 };
    if (dialogue) {
      try {
        const collected = await collectCandidateMemories(this.db, {
          conversationId,
          windowFrom: messages[0].createdAt,
          windowTo: messages[messages.length - 1].createdAt,
          writtenSince: await this.lastCompactionAt(conversationId),
          anchors: this.anchorsFromWindow(combined, dialogue),
          budgetChars: this.config.compactionCandidateChars,
        });
        candidates = collected.items;
        candidatesRendered = collected.rendered;
        candidatesDropped = collected.counts.dropped;
        candidateSources = collected.counts;
      } catch (err) {
        this.logger.warn(`[compactor] candidate collection failed: ${err}`);
      }
    }

    const {
      text: summaryText,
      metadata: summaryMetadata,
      telemetry,
      inputChars,
      promptChars,
    } = await this.summarize(combined, dialogue, candidatesRendered);
    const summaryId = `leaf-${conversationId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const earliestAt = messages[0].createdAt;
    const latestAt = messages[messages.length - 1].createdAt;
    const tokenCount = Math.ceil(summaryText.length / 4);

    await this.db.run(
      `INSERT INTO summaries
         (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount)
       VALUES (?, ?, 'leaf', 0, ?, ?, ?, ?, ?)`,
      [summaryId, conversationId, earliestAt, latestAt, messages.length, summaryText, tokenCount]
    );

    for (let i = 0; i < messages.length; i++) {
      await this.db.run(
        "INSERT INTO summary_messages (summaryId, messageId, position) VALUES (?, ?, ?)",
        [summaryId, messages[i].messageId, i]
      );
    }

    await this.createSummaryMemoryNode(
      {
        summaryId,
        conversationId,
        kind: "leaf",
        depth: 0,
        earliestAt,
        latestAt,
        descendantCount: messages.length,
        content: summaryText,
        tokenCount,
        createdAt: new Date().toISOString(),
      },
      summaryMetadata
    );

    const extraction = await this.applyExtraction({
      conversationId,
      summaryId,
      metadata: summaryMetadata,
      candidates,
      enabled: Boolean(dialogue),
    });

    await this.recordCompactionEvent({
      conversationId,
      kind: "leaf",
      summaryId,
      inputCount: messages.length,
      inputChars,
      outputTokens: tokenCount,
      telemetry,
      promptChars,
      extraction: {
        ...extraction,
        candidateCount: candidates.length,
        candidateDropped: candidatesDropped,
        candidateFromSurfaced: candidateSources.fromSurfaced,
        candidateFromRecent: candidateSources.fromRecentWrites,
        candidateFromScan: candidateSources.fromTagScan,
        dialogueChars: dialogue.length,
      },
    });

    this.logger.debug(
      `[compactor] created summary ${summaryId} covering ${messages.length} messages (${tokenCount} tokens)`
    );
    return summaryId;
  }

  private async summarize(
    content: string,
    dialogue = "",
    candidates = ""
  ): Promise<{
    text: string;
    metadata: SummaryMetadata | null;
    telemetry: SummaryGenerationTelemetry;
    inputChars: number;
    /** The whole prompt, which is what the call is actually billed for. */
    promptChars: number;
  }> {
    // The extraction instruction only appears when there is dialogue to
    // extract from; a pure tool-call window keeps the prompt it always had.
    const header =
      SUMMARY_PROMPT_PREFIX +
      SUMMARY_METADATA_INSTRUCTION +
      (dialogue ? `\n\n${EXTRACTION_INSTRUCTION}` : "") +
      "\n\n";
    const candidateBlock = candidates ? `${CANDIDATES_HEADING}\n${candidates}\n\n` : "";
    const dialogueBlock = dialogue
      ? `${candidateBlock}${DIALOGUE_HEADING}\n${dialogue}\n\n${MESSAGES_HEADING}\n`
      : "";

    // The cap bounds the transcript this call carries -- dialogue plus tool
    // activity -- not the fixed instructions, which is what it meant before
    // the dialogue existed. Counting the instructions against it would starve
    // the content whenever the cap is small.
    //
    // Tool activity gives way first: the dialogue is the smaller part and the
    // only place decisions, tasks and constraints are stated.
    const room = this.config.compactionMaxInputChars - dialogueBlock.length;
    const safeContent =
      content.length <= room
        ? content
        : content.slice(0, Math.max(0, room)) + "\n…[truncated for compaction]";

    const prompt = header + dialogueBlock + safeContent;

    const result = await this.callLlmOrTruncate(prompt, safeContent, {
      kind: "leaf",
      targetTokens: this.config.leafTargetTokens,
    });
    return {
      text: result.content,
      metadata: result.metadata,
      telemetry: result.telemetry,
      inputChars: safeContent.length + dialogueBlock.length,
      promptChars: prompt.length,
    };
  }

  private async createSummaryMemoryNode(
    summary: {
      summaryId: string;
      conversationId: number;
      kind: "leaf" | "condensed";
      depth: number;
      earliestAt: string;
      latestAt: string;
      descendantCount: number;
      content: string;
      tokenCount: number;
      createdAt: string;
    },
    metadata: SummaryMetadata | null
  ): Promise<void> {
    if (!this.shouldCreateSummaryAnchor(summary.content, metadata)) {
      this.logger.debug(
        `[compactor] summary ${summary.summaryId} has no high-value memory signal; skipping summary anchor`
      );
      return;
    }

    try {
      await createMemoryNodeStore(this.db).createSummaryNode(summary);
    } catch (err) {
      this.logger.warn(`[compactor] failed to create memory node for ${summary.summaryId}: ${err}`);
    }
  }

  private shouldCreateSummaryAnchor(
    content: string,
    metadata: SummaryMetadata | null
  ): boolean {
    if (metadata) return metadata.anchor === true;
    return SUMMARY_ANCHOR_SIGNAL_RE.test(content);
  }

  /**
   * Core LLM call with truncation fallback. Used by both leaf compaction
   * (`summarize`) and condensation (`condenseBatch`). When the LLM is
   * unavailable, returns the raw input prefixed with TRUNCATION_FALLBACK_MARKER
   * so readers can tell they're looking at verbatim fragments.
   *
   * Returns the parsed summary body plus the optional structured anchor
   * metadata the LLM emitted as a JSON header. Truncation fallbacks have
   * `metadata: null` so callers fall back to regex-based anchor detection.
   */
  /**
   * Single writer for compaction_events, alongside the summaries write it
   * describes. A summary row cannot say whether the model produced it, how
   * long it took, or why it fell back — and the fallback marker in the text
   * only survives while the text does.
   */
  /** A window may be retried twice; after that its decisions are written off. */
  private static readonly MAX_EXTRACTION_RETRIES = 2;

  /**
   * Re-run extraction for one window whose call fell back.
   *
   * A fallback writes a truncation summary and marks the messages covered, so
   * nothing revisits them: the summary survives, the extraction does not.
   * Steady-state fallback is about 5%, but it arrives in bursts -- a re-import
   * once drove 36 session-limit failures in a day -- and without this a burst
   * costs a day of decisions.
   *
   * Re-summarizing is deliberately not attempted. The summary exists and is
   * marked as a truncation fallback; paying a second call to improve it is a
   * different trade from paying one to recover what the window decided.
   */
  private async retryPendingExtraction(conversationId: number): Promise<void> {
    const pending = await this.db.get(
      `SELECT eventId, summaryId, COALESCE(extractionRetries, 0) AS retries
         FROM compaction_events
        WHERE conversationId = ?
          AND kind = 'leaf'
          AND usedFallback = 1
          AND summaryId IS NOT NULL
          -- A fallback never reached the model, so it never extracted
          -- anything; a successful call that found nothing is not pending.
          AND COALESCE(extractionAdded, 0) = 0
          AND COALESCE(extractionInvalidated, 0) = 0
          -- Nothing was said in that window, so there is nothing to recover.
          AND COALESCE(dialogueChars, 0) > 0
          AND COALESCE(extractionRetries, 0) < ?
        ORDER BY eventId ASC
        LIMIT 1`,
      [conversationId, AsyncCompactor.MAX_EXTRACTION_RETRIES]
    );
    if (!pending) return;

    const messages: MessageRow[] = await this.db.all(
      `SELECT m.messageId, m.seq, m.role, m.content, m.tokenCount, m.tier, m.createdAt
         FROM summary_messages sm
         JOIN conversation_messages m ON m.messageId = sm.messageId
        WHERE sm.summaryId = ?
        ORDER BY m.seq ASC`,
      pending.summaryId
    );
    if (messages.length === 0) return;

    await this.db.run(
      "UPDATE compaction_events SET extractionRetries = ? WHERE eventId = ?",
      [pending.retries + 1, pending.eventId]
    );

    const combined = messages.map(renderMessage).join(SEPARATOR);
    // The same contiguous range the original call used, not this batch's own
    // first message: a window's prose opens it, before any tool runs, so a
    // range starting at the first M/L message drops the message that states
    // the task. Reconstructed here from what earlier summaries already cover.
    const priorCovered = await this.db.get(
      `SELECT MAX(m.seq) AS maxSeq
         FROM summary_messages sm
         JOIN conversation_messages m ON m.messageId = sm.messageId
        WHERE m.conversationId = ? AND m.seq < ?`,
      [conversationId, messages[0].seq]
    );
    const dialogue = await this.dialogueForRange(
      conversationId,
      (priorCovered?.maxSeq ?? -1) + 1,
      messages[messages.length - 1].seq
    );
    if (!dialogue) {
      // Nothing was said in that window after all, so there is nothing to
      // recover. Stop it from being picked again on every future run.
      await this.db.run(
        "UPDATE compaction_events SET dialogueChars = 0 WHERE eventId = ?",
        pending.eventId
      );
      return;
    }

    let candidates: CandidateMemory[] = [];
    let rendered = "";
    try {
      const collected = await collectCandidateMemories(this.db, {
        conversationId,
        windowFrom: messages[0].createdAt,
        windowTo: messages[messages.length - 1].createdAt,
        writtenSince: await this.lastCompactionAt(conversationId),
        anchors: this.anchorsFromWindow(combined, dialogue),
        budgetChars: this.config.compactionCandidateChars,
      });
      candidates = collected.items;
      rendered = collected.rendered;
    } catch (err) {
      this.logger.warn(`[compactor] retry candidate collection failed: ${err}`);
    }

    const result = await this.summarize(combined, dialogue, rendered);
    if (result.telemetry.usedFallback) {
      this.logger.debug(
        `[compactor] extraction retry for ${pending.summaryId} fell back again`
      );
      return;
    }

    const extraction = await this.applyExtraction({
      conversationId,
      summaryId: pending.summaryId,
      metadata: result.metadata,
      candidates,
      enabled: true,
    });

    // The counts land on the original row, so one window stays one row.
    await this.db.run(
      `UPDATE compaction_events
          SET extractionAdded = ?, extractionUpdated = ?,
              extractionInvalidated = ?, extractionRejected = ?
        WHERE eventId = ?`,
      [
        extraction.added,
        extraction.updated,
        extraction.invalidated,
        extraction.rejected,
        pending.eventId,
      ]
    );
    this.logger.info(
      `[compactor] recovered extraction for ${pending.summaryId}: ` +
        `${extraction.added} added, ${extraction.invalidated} invalidated`
    );
  }

  /**
   * Nodes written after the previous compaction are candidates regardless of
   * whether retrieval ever surfaced them -- the previous window's own output
   * and anything a mark skill stored are both too new to have been surfaced.
   */
  private async lastCompactionAt(conversationId: number): Promise<string> {
    const row = await this.db.get(
      "SELECT MAX(createdAt) AS at FROM summaries WHERE conversationId = ?",
      conversationId
    );
    // Before the first compaction there is no "since": everything this session
    // knows is unseen by extraction, and a session that has never been
    // compacted holds few memories anyway. The budget bounds the rest.
    return row?.at ?? "";
  }

  /**
   * Write what the call reported. Everything refused here is counted, not
   * silently dropped: a model that keeps naming ids it was never shown is a
   * prompt problem, and the only way to see it is to log the refusals.
   */
  private async applyExtraction(input: {
    conversationId: number;
    summaryId: string;
    metadata: SummaryMetadata | null;
    candidates: CandidateMemory[];
    enabled: boolean;
  }): Promise<{
    added: number;
    updated: number;
    invalidated: number;
    rejected: number;
  }> {
    const empty = { added: 0, updated: 0, invalidated: 0, rejected: 0 };
    if (!input.enabled || !input.metadata?.raw) return empty;

    try {
      const parsed = parseExtractedMemories(
        input.metadata.raw,
        input.candidates.map((c) => c.nodeId)
      );
      if (parsed.accepted.length === 0 && parsed.rejected.length === 0) return empty;

      const applied = await applyExtractedMemories(createMemoryNodeStore(this.db), {
        conversationId: input.conversationId,
        summaryId: input.summaryId,
        memories: parsed.accepted,
      });
      if (parsed.rejected.length > 0) {
        this.logger.warn(
          `[compactor] refused ${parsed.rejected.length} extracted memory op(s): ` +
            parsed.rejected.map((r) => `${r.op}/${r.reason}`).join(", ")
        );
      }
      return {
        added: applied.counts.added,
        updated: applied.counts.updated,
        invalidated: applied.counts.invalidated,
        rejected: parsed.rejected.length + applied.counts.skipped,
      };
    } catch (err) {
      this.logger.warn(`[compactor] extraction failed: ${err}`);
      return empty;
    }
  }

  private async recordCompactionEvent(input: {
    conversationId: number;
    kind: "leaf" | "condensed";
    summaryId: string | null;
    inputCount: number;
    inputChars: number;
    outputTokens: number;
    trigger?: string;
    telemetry: SummaryGenerationTelemetry;
    /** Length of the whole prompt, which is what the call is billed for. */
    promptChars?: number;
    /** What the extraction riding this call did, when it ran. */
    extraction?: {
      added: number;
      updated: number;
      invalidated: number;
      rejected: number;
      candidateCount: number;
      candidateDropped: number;
      candidateFromSurfaced: number;
      candidateFromRecent: number;
      candidateFromScan: number;
      dialogueChars: number;
    };
  }): Promise<void> {
    try {
      const x = input.extraction;
      await this.db.run(
        `INSERT INTO compaction_events (
           conversationId, kind, trigger, summaryId, inputCount, inputChars,
           outputTokens, llmOutcome, usedFallback, errorMessage, model,
           latencyMs, createdAt,
           extractionAdded, extractionUpdated, extractionInvalidated,
           extractionRejected, candidateCount, candidateDropped, dialogueChars,
           promptChars, candidateFromSurfaced, candidateFromRecent, candidateFromScan
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.conversationId,
          input.kind,
          input.trigger ?? "background",
          input.summaryId,
          input.inputCount,
          input.inputChars,
          input.outputTokens,
          input.telemetry.llmOutcome,
          input.telemetry.usedFallback ? 1 : 0,
          input.telemetry.errorMessage ?? null,
          input.telemetry.model ?? null,
          input.telemetry.latencyMs,
          new Date().toISOString(),
          x?.added ?? null,
          x?.updated ?? null,
          x?.invalidated ?? null,
          x?.rejected ?? null,
          x?.candidateCount ?? null,
          x?.candidateDropped ?? null,
          x?.dialogueChars ?? null,
          input.promptChars ?? null,
          x?.candidateFromSurfaced ?? null,
          x?.candidateFromRecent ?? null,
          x?.candidateFromScan ?? null,
        ]
      );
    } catch (err) {
      this.logger.debug(`[compactor] compaction telemetry write failed: ${err}`);
    }
  }

  private async callLlmOrTruncate(
    prompt: string,
    fallbackContent: string,
    options: SummaryGenerationOptions
  ): Promise<{
    content: string;
    metadata: SummaryMetadata | null;
    telemetry: SummaryGenerationTelemetry;
  }> {
    const startedAt = Date.now();
    const model = this.config.compactionModel;
    if (!this.config.compactionDisableLlm) {
      try {
        const raw = await this.runCompletion(prompt, this.config.compactionTimeoutMs);
        const firstParsed = parseSummaryWithMetadata(raw);
        const firstCheck = this.validateSummaryQuality(
          firstParsed.content,
          fallbackContent,
          options
        );
        if (firstCheck.ok) {
          return {
            content: firstParsed.content,
            metadata: firstParsed.metadata,
            telemetry: {
              llmOutcome: "ok",
              usedFallback: false,
              model,
              latencyMs: Date.now() - startedAt,
            },
          };
        }

        this.logger.warn(
          `[compactor] ${options.kind} summary failed validation (${firstCheck.reason}, ${firstCheck.tokenCount}/${firstCheck.maxTokens} tokens); retrying once`
        );

        const retryPrompt = this.buildSummaryRetryPrompt(
          prompt,
          raw,
          firstCheck,
          options
        );
        const retryRaw = await this.runCompletion(retryPrompt, this.config.compactionTimeoutMs);
        const retryParsed = parseSummaryWithMetadata(retryRaw);
        const retryCheck = this.validateSummaryQuality(
          retryParsed.content,
          fallbackContent,
          options
        );
        if (retryCheck.ok) {
          return {
            content: retryParsed.content,
            metadata: retryParsed.metadata,
            telemetry: {
              llmOutcome: "ok_after_retry",
              usedFallback: false,
              model,
              latencyMs: Date.now() - startedAt,
            },
          };
        }

        throw new ValidationExhaustedError(
          `summary validation failed after retry: ${retryCheck.reason} (${retryCheck.tokenCount}/${retryCheck.maxTokens} tokens)`
        );
      } catch (err) {
        this.logger.warn(
          `[compactor] claude --print summarization failed, using truncation fallback: ${err}`
        );
        return {
          content: this.createTruncationFallback(fallbackContent, options),
          metadata: null,
          telemetry: {
            // A summary rejected twice on quality and a CLI that never ran are
            // both fallbacks, but only one of them is an outage.
            llmOutcome:
              err instanceof ValidationExhaustedError
                ? "validation_failed"
                : "error",
            usedFallback: true,
            errorMessage: err instanceof Error ? err.message : String(err),
            model,
            latencyMs: Date.now() - startedAt,
          },
        };
      }
    }

    return {
      content: this.createTruncationFallback(fallbackContent, options),
      metadata: null,
      telemetry: {
        llmOutcome: "disabled",
        usedFallback: true,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  private validateSummaryQuality(
    summary: string,
    source: string,
    options: SummaryGenerationOptions
  ): SummaryQualityCheck {
    const text = (summary || "").trim();
    const tokenCount = Math.ceil(text.length / 4);
    const maxTokens = this.maxSummaryTokens(options.targetTokens);

    if (!text) {
      return { ok: false, reason: "empty", tokenCount, maxTokens };
    }
    if (tokenCount > maxTokens) {
      return { ok: false, reason: "over_token_budget", tokenCount, maxTokens };
    }

    const sourceTokens = Math.ceil(source.length / 4);
    if (sourceTokens > maxTokens * 2 && tokenCount > sourceTokens * 0.8) {
      return {
        ok: false,
        reason: "too_close_to_source_length",
        tokenCount,
        maxTokens,
      };
    }

    const normalizedSummary = normalizeForOverlap(text);
    const normalizedSource = normalizeForOverlap(source);
    if (
      normalizedSummary.length > 500 &&
      normalizedSource.includes(normalizedSummary.slice(0, 500))
    ) {
      return { ok: false, reason: "verbatim_source_fragment", tokenCount, maxTokens };
    }

    return { ok: true, tokenCount, maxTokens };
  }

  private buildSummaryRetryPrompt(
    originalPrompt: string,
    rejectedSummary: string,
    check: SummaryQualityCheck,
    options: SummaryGenerationOptions
  ): string {
    const maxTokens = this.maxSummaryTokens(options.targetTokens);
    return [
      `Previous summary failed validation: ${check.reason}.`,
      `Rewrite it as a ${options.kind} memory summary.`,
      `Hard cap: ${maxTokens} estimated tokens. Target: ${options.targetTokens} tokens.`,
      "Keep only durable facts: decisions, files, errors, fixes, root causes, and unresolved questions.",
      "Do not copy long source passages or repeat turn-by-turn logs.",
      "",
      SUMMARY_METADATA_INSTRUCTION,
      "",
      "Original task:",
      originalPrompt.slice(0, this.config.compactionMaxInputChars),
      "",
      "Rejected summary:",
      rejectedSummary.slice(0, 6000),
    ].join("\n");
  }

  private createTruncationFallback(
    fallbackContent: string,
    options: SummaryGenerationOptions
  ): string {
    const maxTokens = this.maxSummaryTokens(options.targetTokens);
    const marker = `${TRUNCATION_FALLBACK_MARKER}\n\n`;
    const suffix = "\n…[truncated]";
    const maxChars = Math.max(0, maxTokens * 4 - marker.length - suffix.length);
    const truncated =
      fallbackContent.length <= maxChars
        ? fallbackContent
        : fallbackContent.slice(0, maxChars) + suffix;
    return `${marker}${truncated}`;
  }

  private maxSummaryTokens(targetTokens: number): number {
    const factor =
      Number.isFinite(this.config.summaryMaxOverageFactor) &&
      this.config.summaryMaxOverageFactor > 0
        ? this.config.summaryMaxOverageFactor
        : 3;
    return Math.max(1, Math.ceil(targetTokens * factor));
  }
}

function normalizeForOverlap(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Spawn a command, write `input` to its stdin, collect stdout, and resolve
 * with the trimmed output. Rejects on non-zero exit, timeout, or stderr.
 */
function spawnWithStdin(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeCliSpawnEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`claude --print timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const reason = describeClaudeCliFailure(
          Buffer.concat(stdoutChunks).toString("utf-8"),
          Buffer.concat(stderrChunks).toString("utf-8")
        );
        reject(new Error(`claude --print exited with code ${code}: ${reason}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8").trim());
    });

    // Write prompt to stdin then close so the process knows input is done.
    child.stdin.write(input, "utf-8");
    child.stdin.end();
  });
}
