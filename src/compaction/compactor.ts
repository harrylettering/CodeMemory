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

interface SummaryQualityCheck {
  ok: boolean;
  reason?: string;
  tokenCount: number;
  maxTokens: number;
}

/**
 * Marker prepended to fallback "summaries" so readers see immediately that
 * the stored content is verbatim fragments, not an LLM-produced summary.
 */
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

  constructor(
    private readonly db: any,
    private readonly config: CodeMemoryConfig,
    private readonly logger: SimpleLogger
  ) {}

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
  async forceCompact(conversationId: number): Promise<string[]> {
    if (this.compacting.get(conversationId)) {
      this.logger.info(`[compactor] compaction already in progress for conv ${conversationId}, skipping`);
      return [];
    }
    this.compacting.set(conversationId, true);
    try {
      return await this.runCompaction(conversationId);
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

  private async runCompaction(conversationId: number): Promise<string[]> {
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

    // Preserve the fresh tail — these messages stay uncompacted
    const freshTail = this.config.compactionFreshTailCount;
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

    // Cap batch size so the combined content never exceeds compactionMaxInputChars.
    // Each token ≈ 4 chars; divide by 4 to get a safe token budget per batch.
    const maxBatchTokens = Math.min(
      this.config.leafChunkTokens ?? 20000,
      Math.floor(this.config.compactionMaxInputChars / 4)
    );
    const batches = this.batchByTokens(compactable, maxBatchTokens);

    this.logger.info(
      `[compactor] compacting ${compactable.length} messages into ${batches.length} summary batch(es)`
    );

    const createdIds: string[] = [];
    for (const batch of batches) {
      const id = await this.compactBatch(conversationId, batch);
      createdIds.push(id);
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

    // Batch orphan leaves by token budget so each condensed row stays
    // within a sane size. condensedTargetTokens is the TARGET size of the
    // produced summary, but we also use it (× 4 chars/token) as the input
    // window so each batch can be realistically summarized in one LLM call.
    const targetTokens = this.config.condensedTargetTokens ?? 2000;
    const maxInputTokens = Math.min(
      targetTokens * 4,
      Math.floor(this.config.compactionMaxInputChars / 4)
    );
    const batches = this.batchLeavesByTokens(orphans, maxInputTokens);

    this.logger.info(
      `[compactor] condensing ${orphans.length} leaves into ${batches.length} condensed summary/ies`
    );

    const createdIds: string[] = [];
    for (const batch of batches) {
      if (batch.length < minFanout && batches.length > 1) {
        // A trailing sub-fanout batch (e.g. 7 leaves / minFanout 4 → [4,3]):
        // leave the stragglers un-parented so they can join the next pass.
        continue;
      }
      const id = await this.condenseBatch(conversationId, batch);
      createdIds.push(id);
    }
    return createdIds;
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

    const { content: summaryText, metadata: summaryMetadata } =
      await this.callLlmOrTruncate(prompt, combined, {
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

    this.logger.debug(
      `[compactor] created condensed ${summaryId} covering ${leaves.length} leaves (${tokenCount} tokens)`
    );
    return summaryId;
  }

  private batchByTokens(messages: MessageRow[], maxTokens: number): MessageRow[][] {
    const batches: MessageRow[][] = [];
    let current: MessageRow[] = [];
    let currentTokens = 0;

    for (const msg of messages) {
      if (currentTokens + msg.tokenCount > maxTokens && current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(msg);
      currentTokens += msg.tokenCount;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async compactBatch(conversationId: number, messages: MessageRow[]): Promise<string> {
    const combined = messages
      .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
      .join("\n\n");

    const { text: summaryText, metadata: summaryMetadata } = await this.summarize(combined);
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

    this.logger.debug(
      `[compactor] created summary ${summaryId} covering ${messages.length} messages (${tokenCount} tokens)`
    );
    return summaryId;
  }

  private async summarize(
    content: string
  ): Promise<{ text: string; metadata: SummaryMetadata | null }> {
    const maxInputChars = this.config.compactionMaxInputChars;

    // Hard cap: truncate content before building the prompt so the total
    // input to `claude --print` never exceeds the configured limit.
    const safeContent =
      content.length <= maxInputChars
        ? content
        : content.slice(0, maxInputChars) + "\n…[truncated for compaction]";

    const prompt =
      "Summarize this coding session excerpt for memory. " +
      "Focus on: which files were modified and why, errors encountered and how they were fixed, " +
      "key decisions made, tools invoked. Be concise and factual.\n\n" +
      SUMMARY_METADATA_INSTRUCTION +
      "\n\n" +
      safeContent;

    const result = await this.callLlmOrTruncate(prompt, safeContent, {
      kind: "leaf",
      targetTokens: this.config.leafTargetTokens,
    });
    return { text: result.content, metadata: result.metadata };
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
  private async callLlmOrTruncate(
    prompt: string,
    fallbackContent: string,
    options: SummaryGenerationOptions
  ): Promise<{ content: string; metadata: SummaryMetadata | null }> {
    if (!this.config.compactionDisableLlm) {
      try {
        // `--bare` skips hooks / plugin sync / CLAUDE.md discovery — critical
        // when this spawn runs from inside the daemon (or any Claude-invoked
        // process), otherwise the child reloads our own SessionStart hook
        // chain and restarts another daemon.
        const args = ["--bare", "--print", "--output-format", "text"];
        if (this.config.compactionModel) {
          args.push("--model", this.config.compactionModel);
        }
        const raw = await spawnWithStdin("claude", args, prompt, 30_000);
        const firstParsed = parseSummaryWithMetadata(raw);
        const firstCheck = this.validateSummaryQuality(
          firstParsed.content,
          fallbackContent,
          options
        );
        if (firstCheck.ok) {
          return { content: firstParsed.content, metadata: firstParsed.metadata };
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
        const retryRaw = await spawnWithStdin("claude", args, retryPrompt, 30_000);
        const retryParsed = parseSummaryWithMetadata(retryRaw);
        const retryCheck = this.validateSummaryQuality(
          retryParsed.content,
          fallbackContent,
          options
        );
        if (retryCheck.ok) {
          return { content: retryParsed.content, metadata: retryParsed.metadata };
        }

        throw new Error(
          `summary validation failed after retry: ${retryCheck.reason} (${retryCheck.tokenCount}/${retryCheck.maxTokens} tokens)`
        );
      } catch (err) {
        this.logger.warn(
          `[compactor] claude --print summarization failed, using truncation fallback: ${err}`
        );
      }
    }

    return {
      content: this.createTruncationFallback(fallbackContent, options),
      metadata: null,
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
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

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
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").slice(0, 500);
        reject(new Error(`claude --print exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8").trim());
    });

    // Write prompt to stdin then close so the process knows input is done.
    child.stdin.write(input, "utf-8");
    child.stdin.end();
  });
}
