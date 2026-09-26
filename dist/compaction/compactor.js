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
import { buildClaudeCliArgs, claudeCliSpawnEnv, describeClaudeCliFailure, } from "../llm/claude-cli.js";
import { createMemoryNodeStore } from "../store/memory-store.js";
/** Distinguishes "the model answered badly twice" from "the call failed". */
class ValidationExhaustedError extends Error {
}
/**
 * Marker prepended to fallback "summaries" so readers see immediately that
 * the stored content is verbatim fragments, not an LLM-produced summary.
 */
/** Fixed instruction text, outside the input cap. Exported for tests. */
export const SUMMARY_PROMPT_PREFIX = "Summarize this coding session excerpt for memory. " +
    "Focus on: which files were modified and why, errors encountered and how they were fixed, " +
    "key decisions made, tools invoked. Be concise and factual.\n\n";
const SEPARATOR = "\n\n";
const DIALOGUE_HEADING = "=== DIALOGUE IN THIS WINDOW (what was said) ===";
const MESSAGES_HEADING = "=== TOOL ACTIVITY IN THIS WINDOW ===";
function renderMessage(m) {
    return `[${m.role.toUpperCase()}] ${m.content}`;
}
export const TRUNCATION_FALLBACK_MARKER = "[TRUNCATION FALLBACK — LLM unavailable]";
/**
 * Backstop for truncation fallback / unparseable LLM output. The primary
 * anchor signal now comes from a structured JSON header the LLM emits
 * (see `parseSummaryWithMetadata`); this regex only fires when no
 * structured metadata is available.
 */
const SUMMARY_ANCHOR_SIGNAL_RE = /\b(decision|decided|chose|rejected|root cause|fixed|failed|failure|error|regression)\b|决定|选择|放弃|拒绝|根因|修复|失败|报错|错误|问题在于/i;
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
/**
 * Parse the JSON metadata header the compaction prompt asks the LLM to
 * emit on the first line. Accepts a bare `{...}` line, a fenced ```json
 * block, or no header at all (returns `metadata: null`). The remaining
 * text is the actual summary body to persist.
 */
function parseSummaryWithMetadata(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed)
        return { metadata: null, content: "" };
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*\n?([\s\S]*)$/);
    if (fenced) {
        const meta = tryParseMetadata(fenced[1]);
        if (meta)
            return { metadata: meta, content: fenced[2].trim() };
    }
    const firstLineEnd = trimmed.indexOf("\n");
    const head = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
    const rest = firstLineEnd === -1 ? "" : trimmed.slice(firstLineEnd + 1);
    if (head.startsWith("{") && head.endsWith("}")) {
        const meta = tryParseMetadata(head);
        if (meta)
            return { metadata: meta, content: rest.trim() };
    }
    return { metadata: null, content: trimmed };
}
function tryParseMetadata(text) {
    try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== "object")
            return null;
        const kinds = Array.isArray(obj.kinds)
            ? obj.kinds
                .filter((k) => typeof k === "string")
                .map((k) => k.trim().toLowerCase())
                .filter((k) => ANCHOR_KIND_VOCAB.has(k))
            : [];
        return {
            anchor: obj.anchor === true,
            kinds,
            reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : undefined,
        };
    }
    catch {
        return null;
    }
}
const SUMMARY_METADATA_INSTRUCTION = 'On the very first line, emit exactly one JSON object describing whether this summary is worth anchoring as durable engineering memory. ' +
    'Format: {"anchor": true|false, "kinds": ["decision"|"constraint"|"task"|"failure"|"fix_attempt"|"root_cause"|"regression"|"open_question"], "reason": "<≤120 chars>"}. ' +
    'Set anchor=true ONLY when the summary captures a durable signal: a decision (with rationale), a recurring/root-cause failure or its fix, an explicit constraint or task, or an open question that future sessions must respect. ' +
    'Set anchor=false for routine logs, exploration, trivial mutations, or filler. ' +
    'After the JSON line, leave a blank line, then write the summary itself. Do not repeat the JSON inside the summary body.';
export class AsyncCompactor {
    db;
    config;
    logger;
    compacting = new Map();
    /**
     * Completion seam. Defaults to spawning `claude --print`; the extractor and
     * the decision judge expose the same hook. Without it a test cannot see the
     * prompt this class assembles, which is now most of what it does.
     */
    runCompletion;
    constructor(db, config, logger, deps = {}) {
        this.db = db;
        this.config = config;
        this.logger = logger;
        this.runCompletion =
            deps.runCompletion ??
                ((prompt, timeoutMs) => spawnWithStdin("claude", buildClaudeCliArgs(this.config.compactionModel), prompt, timeoutMs));
        this.warnIfCondensationUnreachable();
    }
    /**
     * The condensation input window and the leaf size target are set by separate
     * knobs that must satisfy `minFanout × leafTargetTokens <= maxInputTokens` for
     * a batch to ever reach the fanout threshold. Nothing enforced that, so a
     * config where the DAG can never grow a level looked exactly like a config
     * where it simply had not grown yet. Check it once, at construction.
     */
    warnIfCondensationUnreachable() {
        if ((this.config.incrementalMaxDepth ?? 1) < 1)
            return;
        const minFanout = this.config.condensedMinFanout ?? 4;
        const leafTokens = this.config.leafTargetTokens;
        const maxInputTokens = this.condensationInputWindowTokens();
        const required = minFanout * leafTokens;
        if (required <= maxInputTokens)
            return;
        this.logger.warn(`[compactor] condensation can never trigger with this configuration: ` +
            `minFanout ${minFanout} × leafTargetTokens ${leafTokens} = ${required} tokens ` +
            `exceeds the ${maxInputTokens}-token condensation input window ` +
            `(min(condensedTargetTokens ${this.config.condensedTargetTokens} × 4, ` +
            `compactionMaxInputChars ${this.config.compactionMaxInputChars} ÷ 4)). ` +
            `Every batch will fall below minFanout and the summary DAG will stay flat.`);
    }
    /**
     * condensedTargetTokens is the TARGET size of the produced summary; × 4 also
     * serves as the input window so a batch stays summarizable in one LLM call.
     */
    condensationInputWindowTokens() {
        const targetTokens = this.config.condensedTargetTokens ?? 2000;
        return Math.min(targetTokens * 4, Math.floor(this.config.compactionMaxInputChars / 4));
    }
    /**
     * Called after every insertMessage. Non-blocking: schedules a background
     * check via setImmediate so the ingest path returns immediately.
     */
    maybeCompact(conversationId) {
        if (!this.config.compactionEnabled)
            return;
        if (this.compacting.get(conversationId))
            return;
        setImmediate(() => {
            this.checkAndCompact(conversationId).catch((err) => this.logger.warn(`[compactor] background check failed: ${err}`));
        });
    }
    /**
     * Force compaction regardless of threshold. Used by explicit triggers
     * (codememory_compact, engine.compact, daemon /compact endpoint). Returns the
     * summary IDs created during this run so callers can report them.
     * Empty array when the call was skipped (already running) or when there
     * was nothing to compact.
     */
    async forceCompact(conversationId, options = {}) {
        if (this.compacting.get(conversationId)) {
            this.logger.info(`[compactor] compaction already in progress for conv ${conversationId}, skipping`);
            return [];
        }
        this.compacting.set(conversationId, true);
        try {
            return await this.runCompaction(conversationId, options);
        }
        catch (err) {
            this.logger.error(`[compactor] forceCompact failed for conv ${conversationId}: ${err}`);
            return [];
        }
        finally {
            this.compacting.set(conversationId, false);
        }
    }
    async checkAndCompact(conversationId) {
        // Double-check inside async context (guard against concurrent fires)
        if (this.compacting.get(conversationId))
            return;
        const row = await this.db.get(`SELECT SUM(m.tokenCount) as totalTokens
       FROM conversation_messages m
       WHERE m.conversationId = ?
         AND m.tier IN ('M', 'L')
         AND m.messageId NOT IN (SELECT messageId FROM summary_messages)`, conversationId);
        const totalTokens = row?.totalTokens ?? 0;
        if (totalTokens < this.config.compactionTokenThreshold)
            return;
        this.logger.info(`[compactor] threshold exceeded (${totalTokens} tokens > ${this.config.compactionTokenThreshold}), starting compaction for conv ${conversationId}`);
        this.compacting.set(conversationId, true);
        try {
            await this.runCompaction(conversationId);
        }
        catch (err) {
            this.logger.error(`[compactor] compaction failed for conv ${conversationId}: ${err}`);
        }
        finally {
            this.compacting.set(conversationId, false);
        }
    }
    async runCompaction(conversationId, options = {}) {
        const allMessages = await this.db.all(`SELECT messageId, seq, role, content, tokenCount, tier, createdAt
       FROM conversation_messages
       WHERE conversationId = ?
         AND tier IN ('M', 'L')
         AND messageId NOT IN (SELECT messageId FROM summary_messages)
       ORDER BY seq ASC`, conversationId);
        if (allMessages.length === 0)
            return [];
        // Preserve the fresh tail — these messages stay uncompacted. Except at
        // SessionEnd: nothing is fresh once the session is over, and holding the
        // last 20 messages back means a session's conclusions are never
        // summarized, nor read by the extraction that rides this call. A short
        // session would otherwise never be compacted at all.
        const freshTail = options.includeFreshTail
            ? 0
            : this.config.compactionFreshTailCount;
        const compactable = allMessages.length > freshTail
            ? allMessages.slice(0, allMessages.length - freshTail)
            : [];
        if (compactable.length === 0) {
            this.logger.debug(`[compactor] all ${allMessages.length} messages are within fresh-tail window, skipping`);
            return [];
        }
        // Counted as rendered, not estimated. `tokenCount * 4` understated the
        // real text -- measured ratio 4.11, plus the `[ROLE] ` prefixes -- so 82
        // of 136 leaf batches overflowed the cap and lost their tails inside
        // summarize().
        const batches = this.batchByChars(compactable, this.config.compactionBatchChars, this.config.leafChunkTokens ?? 20000);
        this.logger.info(`[compactor] compacting ${compactable.length} messages into ${batches.length} summary batch(es)`);
        // Dialogue is attributed to a batch by a contiguous seq range, not by the
        // batch's own first message. A window's prose usually opens it -- the user
        // says what to do, then the tools run -- so a range starting at the first
        // M/L message would drop exactly the message that states the task.
        const covered = await this.db.get(`SELECT MAX(m.seq) AS maxSeq
         FROM summary_messages sm
         JOIN conversation_messages m ON m.messageId = sm.messageId
        WHERE m.conversationId = ?`, conversationId);
        let dialogueFrom = (covered?.maxSeq ?? -1) + 1;
        const createdIds = [];
        for (const batch of batches) {
            const id = await this.compactBatch(conversationId, batch, dialogueFrom);
            dialogueFrom = batch[batch.length - 1].seq + 1;
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
    async runCondensation(conversationId) {
        if ((this.config.incrementalMaxDepth ?? 1) < 1)
            return [];
        const orphans = await this.db.all(`SELECT summaryId, earliestAt, latestAt, descendantCount, content, tokenCount
       FROM summaries
       WHERE conversationId = ?
         AND kind = 'leaf'
         AND summaryId NOT IN (SELECT summaryId FROM summary_parents)
       ORDER BY earliestAt ASC`, conversationId);
        const minFanout = this.config.condensedMinFanout ?? 4;
        if (orphans.length < minFanout) {
            this.logger.debug(`[compactor] condensation skipped: ${orphans.length} un-parented leaves < minFanout ${minFanout}`);
            return [];
        }
        // Batch orphan leaves by token budget so each condensed row stays within a
        // sane size.
        const maxInputTokens = this.condensationInputWindowTokens();
        const batches = this.batchLeavesByTokens(orphans, maxInputTokens);
        const createdIds = [];
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
            this.logger.info(`[compactor] condensed ${orphans.length - skippedBatches * minFanout} of ${orphans.length} un-parented leaves into ${createdIds.length} summary/ies (${skippedBatches} batch(es) left for the next pass)`);
        }
        else {
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
    warnCondensationStarved(orphans, batchCount, maxInputTokens, minFanout) {
        const totalTokens = orphans.reduce((sum, l) => sum + (l.tokenCount ?? 0), 0);
        const avgLeafTokens = Math.round(totalTokens / Math.max(orphans.length, 1));
        const leavesPerBatch = Math.floor(maxInputTokens / Math.max(avgLeafTokens, 1));
        this.logger.warn(`[compactor] condensation produced nothing: ${orphans.length} un-parented leaves ` +
            `formed ${batchCount} batch(es), all below minFanout ${minFanout}. ` +
            `Leaves average ${avgLeafTokens} tokens against a ${maxInputTokens}-token input window, ` +
            `so a batch holds about ${leavesPerBatch}. ` +
            `Raise CODEMEMORY_CONDENSED_TARGET_TOKENS or CODEMEMORY_COMPACTION_MAX_INPUT_CHARS, ` +
            `lower CODEMEMORY_CONDENSED_MIN_FANOUT, or find out why leaves are oversized ` +
            `(truncation fallbacks are pinned at the fallback cap, not leafTargetTokens).`);
    }
    batchLeavesByTokens(leaves, maxTokens) {
        const batches = [];
        let current = [];
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
        if (current.length > 0)
            batches.push(current);
        return batches;
    }
    async condenseBatch(conversationId, leaves) {
        const combined = leaves
            .map((l, i) => `## Leaf summary ${i + 1} (${l.earliestAt} — ${l.latestAt})\n${l.content}`)
            .join("\n\n---\n\n");
        const prompt = "You are combining several coding-session leaf summaries into one higher-level summary. " +
            "Preserve: file-level decisions, recurring errors and their fixes, open questions, and any explicit decisions. " +
            "Drop turn-by-turn detail. Be concise.\n\n" +
            SUMMARY_METADATA_INSTRUCTION +
            "\n\n" +
            combined;
        const { content: summaryText, metadata: summaryMetadata, telemetry, } = await this.callLlmOrTruncate(prompt, combined, {
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
        await this.db.run(`INSERT INTO summaries
         (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount)
       VALUES (?, ?, 'condensed', 1, ?, ?, ?, ?, ?)`, [summaryId, conversationId, earliestAt, latestAt, descendantCount, summaryText, tokenCount]);
        for (let i = 0; i < leaves.length; i++) {
            await this.db.run("INSERT INTO summary_parents (summaryId, parentSummaryId, position) VALUES (?, ?, ?)", [leaves[i].summaryId, summaryId, i]);
        }
        await this.createSummaryMemoryNode({
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
        }, summaryMetadata);
        await this.recordCompactionEvent({
            conversationId,
            kind: "condensed",
            summaryId,
            inputCount: leaves.length,
            inputChars: combined.length,
            outputTokens: tokenCount,
            telemetry,
        });
        this.logger.debug(`[compactor] created condensed ${summaryId} covering ${leaves.length} leaves (${tokenCount} tokens)`);
        return summaryId;
    }
    /**
     * Closes a batch on whichever bound is reached first: the characters this
     * class will actually send, or `leafChunkTokens`. The token bound is what
     * the condensation fanout math is expressed in, so it stays; the character
     * bound is the one that was missing, and the one that decides whether
     * summarize() has to cut the tail off.
     */
    batchByChars(messages, maxChars, maxTokens) {
        const batches = [];
        let current = [];
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
        if (current.length > 0)
            batches.push(current);
        return batches;
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
    async dialogueForRange(conversationId, loSeq, hiSeq) {
        const rows = await this.db.all(`SELECT messageId, seq, role, content, tokenCount, tier, createdAt
         FROM conversation_messages
        WHERE conversationId = ?
          AND seq BETWEEN ? AND ?
          AND tier = 'S'
          AND (tags IS NULL OR tags NOT LIKE '%"tool_result"%')
        ORDER BY seq ASC`, [conversationId, loSeq, hiSeq]);
        if (rows.length === 0)
            return "";
        const budget = this.config.compactionDialogueChars;
        const kept = [];
        let used = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
            const rendered = renderMessage(rows[i]);
            if (used + rendered.length > budget)
                break;
            kept.unshift(rendered);
            used += rendered.length + SEPARATOR.length;
        }
        return kept.join(SEPARATOR);
    }
    async compactBatch(conversationId, messages, dialogueFromSeq = messages[0].seq) {
        const combined = messages.map(renderMessage).join(SEPARATOR);
        const dialogue = await this.dialogueForRange(conversationId, Math.min(dialogueFromSeq, messages[0].seq), messages[messages.length - 1].seq);
        const { text: summaryText, metadata: summaryMetadata, telemetry, inputChars, } = await this.summarize(combined, dialogue);
        const summaryId = `leaf-${conversationId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
        const earliestAt = messages[0].createdAt;
        const latestAt = messages[messages.length - 1].createdAt;
        const tokenCount = Math.ceil(summaryText.length / 4);
        await this.db.run(`INSERT INTO summaries
         (summaryId, conversationId, kind, depth, earliestAt, latestAt, descendantCount, content, tokenCount)
       VALUES (?, ?, 'leaf', 0, ?, ?, ?, ?, ?)`, [summaryId, conversationId, earliestAt, latestAt, messages.length, summaryText, tokenCount]);
        for (let i = 0; i < messages.length; i++) {
            await this.db.run("INSERT INTO summary_messages (summaryId, messageId, position) VALUES (?, ?, ?)", [summaryId, messages[i].messageId, i]);
        }
        await this.createSummaryMemoryNode({
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
        }, summaryMetadata);
        await this.recordCompactionEvent({
            conversationId,
            kind: "leaf",
            summaryId,
            inputCount: messages.length,
            inputChars,
            outputTokens: tokenCount,
            telemetry,
        });
        this.logger.debug(`[compactor] created summary ${summaryId} covering ${messages.length} messages (${tokenCount} tokens)`);
        return summaryId;
    }
    async summarize(content, dialogue = "") {
        const header = SUMMARY_PROMPT_PREFIX +
            SUMMARY_METADATA_INSTRUCTION +
            "\n\n";
        const dialogueBlock = dialogue
            ? `${DIALOGUE_HEADING}\n${dialogue}\n\n${MESSAGES_HEADING}\n`
            : "";
        // The cap bounds the transcript this call carries -- dialogue plus tool
        // activity -- not the fixed instructions, which is what it meant before
        // the dialogue existed. Counting the instructions against it would starve
        // the content whenever the cap is small.
        //
        // Tool activity gives way first: the dialogue is the smaller part and the
        // only place decisions, tasks and constraints are stated.
        const room = this.config.compactionMaxInputChars - dialogueBlock.length;
        const safeContent = content.length <= room
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
        };
    }
    async createSummaryMemoryNode(summary, metadata) {
        if (!this.shouldCreateSummaryAnchor(summary.content, metadata)) {
            this.logger.debug(`[compactor] summary ${summary.summaryId} has no high-value memory signal; skipping summary anchor`);
            return;
        }
        try {
            await createMemoryNodeStore(this.db).createSummaryNode(summary);
        }
        catch (err) {
            this.logger.warn(`[compactor] failed to create memory node for ${summary.summaryId}: ${err}`);
        }
    }
    shouldCreateSummaryAnchor(content, metadata) {
        if (metadata)
            return metadata.anchor === true;
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
    async recordCompactionEvent(input) {
        try {
            await this.db.run(`INSERT INTO compaction_events (
           conversationId, kind, trigger, summaryId, inputCount, inputChars,
           outputTokens, llmOutcome, usedFallback, errorMessage, model,
           latencyMs, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
            ]);
        }
        catch (err) {
            this.logger.debug(`[compactor] compaction telemetry write failed: ${err}`);
        }
    }
    async callLlmOrTruncate(prompt, fallbackContent, options) {
        const startedAt = Date.now();
        const model = this.config.compactionModel;
        if (!this.config.compactionDisableLlm) {
            try {
                const raw = await this.runCompletion(prompt, this.config.compactionTimeoutMs);
                const firstParsed = parseSummaryWithMetadata(raw);
                const firstCheck = this.validateSummaryQuality(firstParsed.content, fallbackContent, options);
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
                this.logger.warn(`[compactor] ${options.kind} summary failed validation (${firstCheck.reason}, ${firstCheck.tokenCount}/${firstCheck.maxTokens} tokens); retrying once`);
                const retryPrompt = this.buildSummaryRetryPrompt(prompt, raw, firstCheck, options);
                const retryRaw = await this.runCompletion(retryPrompt, this.config.compactionTimeoutMs);
                const retryParsed = parseSummaryWithMetadata(retryRaw);
                const retryCheck = this.validateSummaryQuality(retryParsed.content, fallbackContent, options);
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
                throw new ValidationExhaustedError(`summary validation failed after retry: ${retryCheck.reason} (${retryCheck.tokenCount}/${retryCheck.maxTokens} tokens)`);
            }
            catch (err) {
                this.logger.warn(`[compactor] claude --print summarization failed, using truncation fallback: ${err}`);
                return {
                    content: this.createTruncationFallback(fallbackContent, options),
                    metadata: null,
                    telemetry: {
                        // A summary rejected twice on quality and a CLI that never ran are
                        // both fallbacks, but only one of them is an outage.
                        llmOutcome: err instanceof ValidationExhaustedError
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
    validateSummaryQuality(summary, source, options) {
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
        if (normalizedSummary.length > 500 &&
            normalizedSource.includes(normalizedSummary.slice(0, 500))) {
            return { ok: false, reason: "verbatim_source_fragment", tokenCount, maxTokens };
        }
        return { ok: true, tokenCount, maxTokens };
    }
    buildSummaryRetryPrompt(originalPrompt, rejectedSummary, check, options) {
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
    createTruncationFallback(fallbackContent, options) {
        const maxTokens = this.maxSummaryTokens(options.targetTokens);
        const marker = `${TRUNCATION_FALLBACK_MARKER}\n\n`;
        const suffix = "\n…[truncated]";
        const maxChars = Math.max(0, maxTokens * 4 - marker.length - suffix.length);
        const truncated = fallbackContent.length <= maxChars
            ? fallbackContent
            : fallbackContent.slice(0, maxChars) + suffix;
        return `${marker}${truncated}`;
    }
    maxSummaryTokens(targetTokens) {
        const factor = Number.isFinite(this.config.summaryMaxOverageFactor) &&
            this.config.summaryMaxOverageFactor > 0
            ? this.config.summaryMaxOverageFactor
            : 3;
        return Math.max(1, Math.ceil(targetTokens * factor));
    }
}
function normalizeForOverlap(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}
/**
 * Spawn a command, write `input` to its stdin, collect stdout, and resolve
 * with the trimmed output. Rejects on non-zero exit, timeout, or stderr.
 */
function spawnWithStdin(cmd, args, input, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeCliSpawnEnv(),
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`claude --print timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                const reason = describeClaudeCliFailure(Buffer.concat(stdoutChunks).toString("utf-8"), Buffer.concat(stderrChunks).toString("utf-8"));
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
//# sourceMappingURL=compactor.js.map