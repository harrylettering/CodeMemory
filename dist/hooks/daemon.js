#!/usr/bin/env node
/**
 * CodeMemory - Project Watcher Daemon
 *
 * Background daemon that monitors a specific project's JSONL files.
 * Started by SessionStart hook, stopped by SessionEnd hook.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startProjectWatcher } from "./project-watcher-manager.js";
import { buildExtractionTranscript, extractKeyMemories, } from "../memory/extract-key-memories.js";
import { resolveCodeMemoryConfig } from "../db/config.js";
import { createCodeMemoryDatabaseConnection } from "../db/connection.js";
import { ConversationStore } from "../store/conversation-store.js";
import { scoreMessage, createSessionState } from "../filter/scorer.js";
import { loadExploredTargets, flushExploredTargets, } from "../filter/explored-targets-store.js";
import { NegExpExtractor } from "../negexp/extractor.js";
import { lookupForPreToolUse } from "../failure-lookup.js";
import { RetrievalEngine } from "../retrieval.js";
import { createSmartQueryPlanner } from "../query-planner.js";
import { SummaryStore } from "../store/summary-store.js";
import { createMemoryNodeStore } from "../store/memory-store.js";
import { createDecisionSupersedeJudge } from "../store/decision-supersede-judge.js";
import { LifecycleResolver } from "../lifecycle-resolver.js";
import { FixAttemptTracker } from "../fix-attempt-tracker.js";
import { AsyncCompactor } from "../compaction/compactor.js";
import { CodeMemoryMarkDecisionTool } from "../tools/codememory-mark-decision-tool.js";
import { CodeMemoryMarkRequirementTool } from "../tools/codememory-mark-requirement-tool.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Simple logger
const logger = {
    debug: (...args) => console.error("[codememory-daemon]", ...args),
    info: (...args) => console.error("[codememory-daemon]", ...args),
    warn: (...args) => console.error("[codememory-daemon]", ...args),
    error: (...args) => console.error("[codememory-daemon]", ...args),
};
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command === "start") {
        await startDaemon(args.slice(1));
    }
    else if (command === "stop") {
        await stopDaemon(args.slice(1));
    }
    else if (command === "status") {
        await checkStatus(args.slice(1));
    }
    else {
        console.error(`Usage: ${process.argv[1]} <start|stop|status> [sessionId] [projectPath]`);
        process.exit(1);
    }
}
function getRuntimeDir() {
    const runtimeDir = path.join(process.env.HOME || "/tmp", ".claude", "codememory-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    return runtimeDir;
}
function getPidFilePath(sessionId) {
    return path.join(getRuntimeDir(), `${sessionId}.pid`);
}
function getSocketPath(sessionId) {
    return path.join(getRuntimeDir(), `${sessionId}.sock`);
}
async function startDaemon(args) {
    const sessionId = args[0];
    const projectPath = args[1];
    if (!sessionId || !projectPath) {
        console.error("Usage: start <sessionId> <projectPath>");
        process.exit(1);
    }
    const pidFile = getPidFilePath(sessionId);
    // Check if already running
    if (fs.existsSync(pidFile)) {
        try {
            const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
            // Check if process is still running
            process.kill(oldPid, 0);
            logger.warn(`Daemon already running for session ${sessionId} (PID ${oldPid})`);
            process.exit(0);
        }
        catch {
            // Process not running, remove stale pid file
            fs.unlinkSync(pidFile);
        }
    }
    // Write our PID
    fs.writeFileSync(pidFile, process.pid.toString(), "utf-8");
    logger.info(`Starting daemon for session ${sessionId}, project ${projectPath}`);
    let watcher = null;
    try {
        const config = resolveCodeMemoryConfig();
        const db = await createCodeMemoryDatabaseConnection(config.databasePath);
        const conversationStore = new ConversationStore(db);
        const summaryStore = new SummaryStore(db);
        const memoryStore = createMemoryNodeStore(db, {
            autoSupersedeViaLlm: config.autoSupersedeViaLlm,
            autoSupersedeMaxCandidates: config.autoSupersedeMaxCandidates,
            decisionJudge: config.autoSupersedeViaLlm
                ? createDecisionSupersedeJudge({
                    model: config.autoSupersedeModel,
                    timeoutMs: config.autoSupersedeTimeoutMs,
                })
                : undefined,
        });
        const lifecycleResolver = new LifecycleResolver(memoryStore);
        const fixAttemptTracker = new FixAttemptTracker(db, memoryStore, lifecycleResolver);
        const retrievalEngine = new RetrievalEngine(conversationStore, summaryStore, memoryStore, config.queryPlannerEnabled ? createSmartQueryPlanner(config) : undefined, config.queryPlannerEnabled);
        const compactor = new AsyncCompactor(db, config, logger);
        const markDecisionTool = new CodeMemoryMarkDecisionTool(conversationStore, () => sessionId, memoryStore);
        const markRequirementTool = new CodeMemoryMarkRequirementTool(conversationStore, () => sessionId, memoryStore);
        // Auto-resolve tuning. After this many seqs of no recurrence, an
        // unresolved failure is considered resolved (assistant moved on, no
        // more errors on the same signature).
        const RESOLVE_STALE_WINDOW = 50;
        const STALE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
        let lastStaleMaintenanceAt = 0;
        // Anti-flood debounce. The same target won't be warned about more
        // than once within this many milliseconds (cleared on daemon restart).
        const WARN_DEBOUNCE_MS = 60_000;
        const recentlyWarned = new Map();
        // Pattern that signals the user is acknowledging a fix.
        const USER_RESOLVED_PATTERNS = [
            /\b(fixed|works now|works again|resolved|all good|that worked|nice|perfect)\b/i,
            /好了|搞定|可以了|修好了|没问题了|成功了|对了/,
        ];
        // Start the PreToolUse lookup socket. The bash hook curls this with a
        // hard timeout so the model doesn't pay node-cold-start latency on
        // every tool call. Falls back to retrieve-cli.ts if the socket is
        // missing or unresponsive.
        const socketPath = getSocketPath(sessionId);
        if (fs.existsSync(socketPath)) {
            try {
                fs.unlinkSync(socketPath);
            }
            catch {
                /* ignore */
            }
        }
        /**
         * Telemetry must never be able to break a tool call, so every failure here
         * is swallowed. A missing row is a gap in measurement; a thrown error
         * would be a blocked Edit.
         */
        const recordLookup = async (body, response, outcome, surfacedNodeIds) => {
            try {
                const conv = await conversationStore.getConversationForSession({
                    sessionId,
                });
                await memoryStore.recordFailureLookup({
                    conversationId: conv?.conversationId ?? null,
                    sessionId,
                    toolName: String(body?.toolName ?? "unknown"),
                    targetFile: response.diagnostics.targetFile,
                    targetCommand: response.diagnostics.targetCommand,
                    targetFileTag: response.diagnostics.targetFileTag,
                    targetCommandTag: response.diagnostics.targetCommandTag,
                    outcome,
                    candidateCount: response.diagnostics.candidateCount,
                    passedCount: response.diagnostics.passedCount,
                    topScore: response.diagnostics.topScore,
                    surfacedNodeIds,
                    source: "daemon",
                });
            }
            catch (err) {
                logger.warn(`recordFailureLookup failed: ${err}`);
            }
        };
        const lookupServer = http.createServer((req, res) => {
            if (req.method !== "POST") {
                res.statusCode = 404;
                res.end();
                return;
            }
            // ----- /retrieval/onPrompt: UserPromptSubmit injection ------------
            if (req.url === "/retrieval/onPrompt") {
                const chunks = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", async () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                        const prompt = body.prompt || "";
                        // Best-effort: scope to the current session's conversation if
                        // we can find one. Cross-session failure recall still happens
                        // via the retrieval engine's default behavior.
                        let conversationId;
                        try {
                            const conv = await conversationStore.getConversationForSession({
                                sessionId,
                            });
                            conversationId = conv?.conversationId;
                        }
                        catch {
                            /* ignore — first prompt of a new session has no conv yet */
                        }
                        const result = await retrievalEngine.retrieveForPrompt({
                            prompt,
                            conversationId,
                        });
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({
                            shouldInject: result.markdown.length > 0,
                            markdown: result.markdown,
                            pivots: result.pivots,
                            plan: result.plan,
                            planner: result.planner,
                            metrics: result.metrics,
                            counts: {
                                memoryNodes: result.memoryNodes?.length ?? 0,
                                stitchedRelations: result.stitchedRelations?.length ?? 0,
                                stitchedChains: result.stitchedChains?.length ?? 0,
                                decisions: result.decisions.length,
                                messages: result.messages.length,
                                failures: result.failures.length,
                            },
                        }));
                    }
                    catch (err) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({
                            shouldInject: false,
                            reason: `Internal error: ${err}`,
                        }));
                    }
                });
                return;
            }
            // ----- /compact: force-compaction trigger from PreCompact / ------
            // SessionEnd hooks. Body is optional JSON `{sessionId?}`; defaults to
            // the daemon's own sessionId. Fire-and-forget: we 202 immediately and
            // run the work in the background so the hook never blocks the user.
            if (req.url === "/reimport") {
                const chunks = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", async () => {
                    try {
                        const raw = Buffer.concat(chunks).toString("utf-8").trim();
                        const body = raw ? JSON.parse(raw) : {};
                        const target = typeof body.sessionId === "string" && body.sessionId
                            ? body.sessionId
                            : sessionId;
                        logger.info(`[reimport] rebuilding session ${target}`);
                        const result = await reimportSession(target);
                        logger.info(`[reimport] ${JSON.stringify(result)}`);
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ ok: true, ...result }));
                    }
                    catch (err) {
                        logger.error(`[reimport] failed: ${err}`);
                        res.writeHead(500, { "content-type": "application/json" });
                        res.end(JSON.stringify({ ok: false, error: String(err) }));
                    }
                });
                return;
            }
            if (req.url === "/compact") {
                const chunks = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", async () => {
                    let targetSessionId = sessionId;
                    try {
                        const raw = Buffer.concat(chunks).toString("utf-8").trim();
                        if (raw) {
                            const body = JSON.parse(raw);
                            if (typeof body.sessionId === "string" && body.sessionId) {
                                targetSessionId = body.sessionId;
                            }
                        }
                    }
                    catch {
                        /* empty or malformed body → use daemon's sessionId */
                    }
                    res.statusCode = 202;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ accepted: true, sessionId: targetSessionId }));
                    // Background work — never blocks the HTTP response.
                    setImmediate(async () => {
                        try {
                            const conv = await conversationStore.getConversationForSession({
                                sessionId: targetSessionId,
                            });
                            if (!conv) {
                                logger.info(`[compact] no conversation for session ${targetSessionId}, skipping`);
                                return;
                            }
                            await compactor.forceCompact(conv.conversationId);
                            logger.info(`[compact] force-compaction completed for conv ${conv.conversationId} (session ${targetSessionId})`);
                        }
                        catch (err) {
                            logger.warn(`[compact] background compaction failed: ${err}`);
                        }
                    });
                });
                return;
            }
            // ----- /mark/decision: durable decision Memory Node write --------
            // Skill body curls this with the decision payload. Daemon is the
            // sole writer of memory_nodes; the matching S-tier
            // conversation_messages row is produced by the JSONL watcher when
            // it sees the Skill tool_use side-effect.
            if (req.url === "/mark/decision") {
                const chunks = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", async () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                        const result = await markDecisionTool.mark({
                            decision: body.decision,
                            rationale: body.rationale,
                            alternatives_rejected: body.alternatives_rejected,
                            sessionId: body.sessionId,
                            supersedesNodeId: body.supersedesNodeId,
                            sourceToolUseId: body.sourceToolUseId,
                        });
                        res.statusCode = result.ok ? 200 : 400;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify(result));
                    }
                    catch (err) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ ok: false, reason: `Internal error: ${err}` }));
                    }
                });
                return;
            }
            // ----- /mark/requirement: durable task / constraint Memory Node ---
            if (req.url === "/mark/requirement") {
                const chunks = [];
                req.on("data", (c) => chunks.push(c));
                req.on("end", async () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                        const result = await markRequirementTool.mark({
                            kind: body.kind,
                            requirement: body.requirement,
                            details: body.details,
                            acceptance_criteria: body.acceptance_criteria,
                            sessionId: body.sessionId,
                            supersedesNodeId: body.supersedesNodeId,
                            sourceToolUseId: body.sourceToolUseId,
                        });
                        res.statusCode = result.ok ? 200 : 400;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify(result));
                    }
                    catch (err) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ ok: false, reason: `Internal error: ${err}` }));
                    }
                });
                return;
            }
            if (req.url !== "/failure/lookup" && req.url !== "/negexp/lookup") {
                res.statusCode = 404;
                res.end();
                return;
            }
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                    const response = await lookupForPreToolUse(memoryStore, body.toolName, body.toolInput);
                    // Anti-flood: if we already warned about any of these targets
                    // recently, swallow the injection so the model doesn't get the
                    // same warning N times in a row on consecutive Edits to the
                    // same file. The data is still in the DB; only the surfacing
                    // is debounced.
                    if (response.shouldInject && response.failures.length > 0) {
                        const now = Date.now();
                        const keys = response.failures.map((f) => f.nodeId);
                        const allRecent = keys.every((k) => {
                            const last = recentlyWarned.get(k);
                            return last != null && now - last < WARN_DEBOUNCE_MS;
                        });
                        if (allRecent) {
                            await recordLookup(body, response, "debounced", keys);
                            res.setHeader("content-type", "application/json");
                            res.end(JSON.stringify({
                                shouldInject: false,
                                reason: "Debounced: already warned recently",
                                failures: [],
                            }));
                            return;
                        }
                        for (const k of keys)
                            recentlyWarned.set(k, now);
                        // "Used" means actually surfaced to the model, so it is recorded
                        // here rather than at lookup time — a debounced hit is not a use.
                        try {
                            await memoryStore.markUsed(keys);
                        }
                        catch (err) {
                            logger.warn(`markUsed failed: ${err}`);
                        }
                    }
                    await recordLookup(body, response, response.diagnostics.outcome, response.diagnostics.surfacedNodeIds);
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify(response));
                }
                catch (err) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({
                        shouldInject: false,
                        reason: `Internal error: ${err}`,
                        failures: [],
                    }));
                }
            });
        });
        lookupServer.listen(socketPath, () => {
            try {
                fs.chmodSync(socketPath, 0o600);
            }
            catch {
                /* ignore */
            }
            logger.info(`Lookup socket listening at ${socketPath}`);
        });
        // Per-session extractor/scorer states. Exploration targets persist
        // across daemon restarts via SQLite (see filter/explored-targets-store),
        // so a restart doesn't lose dedup signal. We rehydrate the map on
        // first use per (sessionId, conversationId) pair.
        const scorerStates = new Map();
        const hydratedConversations = new Set();
        const getScorerState = async (sid, conversationId) => {
            let s = scorerStates.get(sid);
            if (!s) {
                s = createSessionState();
                scorerStates.set(sid, s);
            }
            if (!hydratedConversations.has(conversationId)) {
                try {
                    const loaded = await loadExploredTargets(db, conversationId, config.exploredTargetWindowMs);
                    for (const [t, ts] of loaded) {
                        s.exploredTargets.set(t, ts);
                    }
                }
                catch (err) {
                    logger.warn(`Failed to hydrate exploredTargets for conv ${conversationId}: ${err}`);
                }
                hydratedConversations.add(conversationId);
            }
            return s;
        };
        const extractors = new Map();
        const getExtractor = (sid) => {
            let e = extractors.get(sid);
            if (!e) {
                e = new NegExpExtractor();
                extractors.set(sid, e);
            }
            return e;
        };
        /**
         * The one place a transcript line becomes rows. The watcher calls it
         * live; /reimport calls it again when rebuilding a session from its
         * jsonl, so both paths cannot drift apart.
         */
        const ingestOne = async (message, filePath) => {
            // Get or create conversation for this session
            const fileName = path.basename(filePath, ".jsonl");
            const fileSessionId = fileName || sessionId;
            try {
                // Extract phase: observe every message for mutation tracking
                // (even if it might be dropped later).
                const extractor = getExtractor(fileSessionId);
                const conversation = await conversationStore.getOrCreateConversation({
                    sessionId: fileSessionId,
                });
                const nextSeqResult = await conversationStore.getDatabase().get(`SELECT MAX(seq) as maxSeq FROM conversation_messages WHERE conversationId = ?`, conversation.conversationId);
                const seq = (nextSeqResult?.maxSeq ?? -1) + 1;
                extractor.observeMessage(message, seq);
                // Filter/Score: decide tier + final content. N tier is dropped.
                const scorerState = await getScorerState(fileSessionId, conversation.conversationId);
                const score = scoreMessage(message, scorerState, {
                    exploredTargetWindowMs: config.exploredTargetWindowMs,
                });
                // Flush dedup state regardless of tier — even N (duplicate)
                // messages update lastSeenAt on the pattern side; and on first-
                // seen targets we want to persist before a potential crash.
                try {
                    await flushExploredTargets(db, conversation.conversationId, scorerState);
                }
                catch (err) {
                    logger.warn(`flushExploredTargets failed: ${err}`);
                }
                if (score.tier === "N") {
                    logger.debug(`Dropping ${message.role} message (N tier, tags=${score.tags.join(",")})`);
                    return;
                }
                logger.debug(`Ingesting ${message.role} message: tier=${score.tier} tags=${score.tags.join(",")}`);
                const tokenCount = Math.ceil((score.content || "").length / 4);
                const insertedMessage = await conversationStore.insertMessage({
                    conversationId: conversation.conversationId,
                    role: message.role || "assistant",
                    content: score.content,
                    tokenCount,
                    tier: score.tier,
                    tags: score.tags,
                    parts: [{
                            partType: "text",
                            textContent: score.content,
                        }],
                });
                try {
                    await fixAttemptTracker.observeToolUses(message, {
                        conversationId: conversation.conversationId,
                        sessionId: fileSessionId,
                        seq,
                        messageId: insertedMessage.messageId,
                    });
                }
                catch (err) {
                    logger.warn(`fixAttemptTracker.observeToolUses failed: ${err}`);
                }
                // Async compaction check — fires in background, never blocks ingest.
                compactor.maybeCompact(conversation.conversationId);
                // Auto-resolve sweep: any active failure node older than the
                // staleness window (and with no later recurrence on the same
                // signature) gets marked resolved. Runs once per ingested
                // message so the PreToolUse hook stops warning about solved
                // problems promptly.
                try {
                    const resolvedCount = await memoryStore.autoResolveStaleFailureNodes({
                        conversationId: conversation.conversationId,
                        currentSeq: seq,
                        olderThanSeqs: RESOLVE_STALE_WINDOW,
                        resolution: `auto: no recurrence within ${RESOLVE_STALE_WINDOW} seqs`,
                    });
                    if (resolvedCount > 0) {
                        logger.debug(`auto-resolved ${resolvedCount} stale failure node(s)`);
                    }
                }
                catch (err) {
                    logger.warn(`autoResolveStaleFailureNodes failed: ${err}`);
                }
                // User-signal resolution: if a user message reads as "fixed /
                // works now / 好了", mark the most recent active failure on
                // the same target as resolved. This is the explicit closing
                // signal that complements the staleness sweep.
                if (message.role === "user" &&
                    USER_RESOLVED_PATTERNS.some((re) => re.test(message.content || ""))) {
                    // Most recent mutation tells us which target the user is
                    // referring to. Without this we'd resolve everything, which
                    // is too aggressive.
                    const recentMutation = extractor.getMostRecentMutation();
                    if (recentMutation) {
                        try {
                            const n = await memoryStore.resolveFailureNodesByTarget({
                                conversationId: conversation.conversationId,
                                target: {
                                    filePath: recentMutation.filePath,
                                    command: recentMutation.command,
                                },
                                resolution: `user signaled resolution: "${(message.content || "").slice(0, 80)}"`,
                                evidenceMessageId: insertedMessage.messageId,
                            });
                            if (n > 0) {
                                logger.debug(`user-resolved ${n} failure node(s)`);
                            }
                        }
                        catch (err) {
                            logger.warn(`resolveFailureNodesByTarget failed: ${err}`);
                        }
                    }
                }
                // Extract failure if this is an error and write directly as a
                // memory_node (kind='failure'). Then check whether a prior
                // failure with the same anchors should be reopened.
                const failureNodeIds = [];
                if (score.tags.includes("error")) {
                    const extracted = extractor.extractFromErrorMessage(message, conversation.conversationId, seq);
                    if (extracted) {
                        logger.debug(`Extracting failure (type=${extracted.type}, file=${extracted.filePath}, cmd=${extracted.command})`);
                        const failureNode = await memoryStore.createFailureNode({
                            conversationId: conversation.conversationId,
                            sessionId: fileSessionId,
                            seq,
                            type: extracted.type,
                            signature: extracted.signature,
                            raw: extracted.raw,
                            location: extracted.location,
                            attemptedFix: extracted.attemptedFix,
                            filePath: extracted.filePath,
                            command: extracted.command,
                            symbol: extracted.symbol,
                            messageId: extracted.messageId,
                            evidenceMessageId: insertedMessage.messageId,
                            weight: 1.0,
                        });
                        failureNodeIds.push(failureNode.nodeId);
                        try {
                            await lifecycleResolver.reopenFailure({
                                conversationId: conversation.conversationId,
                                files: extracted.filePath ? [extracted.filePath] : [],
                                commands: extracted.command ? [extracted.command] : [],
                                symbols: extracted.symbol ? [extracted.symbol] : [],
                                signatures: [extracted.signature],
                                newFailureNodeId: failureNode.nodeId,
                                evidenceMessageId: insertedMessage.messageId,
                                reason: `failure recurred: ${extracted.type} ${extracted.signature.slice(0, 80)}`,
                            });
                        }
                        catch (err) {
                            logger.warn(`reopenFailure failed: ${err}`);
                        }
                    }
                }
                const nowMs = Date.now();
                if (nowMs - lastStaleMaintenanceAt >= STALE_MAINTENANCE_INTERVAL_MS) {
                    lastStaleMaintenanceAt = nowMs;
                    try {
                        const result = await memoryStore.runStaleMaintenance({ limit: 100 });
                        if (result.staleNodeIds.length > 0) {
                            logger.debug(`marked ${result.staleNodeIds.length} memory node(s) stale`);
                        }
                    }
                    catch (err) {
                        logger.warn(`memory stale maintenance failed: ${err}`);
                    }
                }
                try {
                    await fixAttemptTracker.observeToolResults(message, {
                        conversationId: conversation.conversationId,
                        sessionId: fileSessionId,
                        seq,
                        messageId: insertedMessage.messageId,
                        failureNodeIds,
                    });
                }
                catch (err) {
                    logger.warn(`fixAttemptTracker.observeToolResults failed: ${err}`);
                }
            }
            catch (error) {
                logger.error(`Failed to ingest message: ${error}`);
            }
        };
        /**
         * Remove everything a conversation owns, so a re-import rebuilds from a
         * clean slate rather than layering a second copy on top.
         *
         * Deliberately total, including memory nodes. Partial deletion would leave
         * summary nodes pointing at summaryIds that no longer exist and would let
         * the failure/fix_attempt extractors re-derive rows that are already
         * present. The nodes that cannot be rebuilt from a transcript — decisions,
         * tasks, constraints — are recovered by the extraction pass instead.
         */
        const purgeConversation = async (conversationId) => {
            const nodeIds = `SELECT nodeId FROM memory_nodes WHERE conversationId = ${conversationId}`;
            const summaryIds = `SELECT summaryId FROM summaries WHERE conversationId = ${conversationId}`;
            const messageIds = `SELECT messageId FROM conversation_messages WHERE conversationId = ${conversationId}`;
            const counts = {};
            const removed = async (table, where) => {
                const before = await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
                await db.run(`DELETE FROM ${table} WHERE ${where}`);
                if (before?.n)
                    counts[table] = before.n;
            };
            await db.exec("BEGIN");
            try {
                await removed("memory_tags", `nodeId IN (${nodeIds})`);
                await removed("memory_relations", `fromNodeId IN (${nodeIds}) OR toNodeId IN (${nodeIds})`);
                await removed("memory_lifecycle_events", `nodeId IN (${nodeIds})`);
                await removed("memory_pending_updates", `targetNodeId IN (${nodeIds})`);
                await removed("memory_nodes", `conversationId = ${conversationId}`);
                await removed("summary_messages", `summaryId IN (${summaryIds})`);
                await removed("summary_parents", `summaryId IN (${summaryIds}) OR parentSummaryId IN (${summaryIds})`);
                await removed("summaries", `conversationId = ${conversationId}`);
                await removed("message_parts", `messageId IN (${messageIds})`);
                await removed("conversation_messages", `conversationId = ${conversationId}`);
                await removed("conversation_context", `conversationId = ${conversationId}`);
                await removed("attempt_spans", `conversationId = ${conversationId}`);
                await removed("explored_targets", `conversationId = ${conversationId}`);
                await removed("conversation_bootstrap_state", `conversationId = ${conversationId}`);
                await removed("conversations", `conversationId = ${conversationId}`);
                await db.exec("COMMIT");
            }
            catch (err) {
                await db.exec("ROLLBACK");
                throw err;
            }
            return counts;
        };
        /**
         * Recover the memory kinds no deterministic rule produces. Failures here
         * are logged, not thrown: a session rebuilt without its decisions is worth
         * more than a re-import that aborts halfway.
         */
        const rebuildKeyMemories = async (conversationId, targetSessionId, rawFileContent) => {
            const counts = { decision: 0, task: 0, constraint: 0, superseded: 0, skipped: false };
            // Prose only — user asks, assistant replies, assistant reasoning. Tool
            // calls and results are the bulk of a transcript and hold none of the
            // memory kinds this pass looks for.
            const transcript = buildExtractionTranscript(rawFileContent);
            if (!transcript.trim())
                return counts;
            logger.info(`[reimport] extraction input is ${transcript.length} chars of prose, from a ${rawFileContent.length}-char transcript`);
            let extracted;
            try {
                extracted = await extractKeyMemories(transcript, {
                    model: config.compactionModel,
                    log: logger,
                });
            }
            catch (err) {
                logger.warn(`[reimport] key-memory extraction failed: ${err}`);
                counts.skipped = true;
                return counts;
            }
            // Items arrive in the order they occurred, so a revision always follows
            // the node it replaces and can resolve to a nodeId that already exists.
            const nodeIdByStatement = new Map();
            const statementKey = (kind, statement) => `${kind}:${statement.toLowerCase().replace(/\s+/g, " ")}`;
            let supersedes = 0;
            for (const item of extracted) {
                try {
                    // A session revises itself. Recording only the final position would
                    // discard how it got there, which is exactly what makes the earlier
                    // decisions worth keeping — so the replaced node is superseded, not
                    // deleted, matching what the live mark path does.
                    let supersedesNodeId;
                    if (item.revises) {
                        supersedesNodeId = nodeIdByStatement.get(statementKey(item.kind, item.revises));
                        if (!supersedesNodeId) {
                            logger.debug(`[reimport] "${item.statement}" claims to revise an item that was not extracted; storing it standalone`);
                        }
                    }
                    let created;
                    if (item.kind === "decision") {
                        created = await memoryStore.createDecisionNode({
                            conversationId,
                            sessionId: targetSessionId,
                            decision: item.statement,
                            rationale: item.rationale,
                            alternativesRejected: item.alternativesRejected,
                            content: item.rationale
                                ? `${item.statement}\n\n${item.rationale}`
                                : item.statement,
                            supersedesNodeId,
                        });
                    }
                    else if (item.kind === "task") {
                        created = await memoryStore.createTaskNode({
                            conversationId,
                            sessionId: targetSessionId,
                            task: item.statement,
                            details: item.rationale,
                            supersedesNodeId,
                        });
                    }
                    else {
                        created = await memoryStore.createConstraintNode({
                            conversationId,
                            sessionId: targetSessionId,
                            constraint: item.statement,
                            details: item.rationale,
                            supersedesNodeId,
                        });
                    }
                    nodeIdByStatement.set(statementKey(item.kind, item.statement), created.nodeId);
                    counts[item.kind]++;
                    if (supersedesNodeId)
                        supersedes++;
                }
                catch (err) {
                    logger.warn(`[reimport] could not store ${item.kind}: ${err}`);
                }
            }
            counts.superseded = supersedes;
            logger.info(`[reimport] recovered ${counts.decision} decision(s), ${counts.task} task(s), ${counts.constraint} constraint(s); ${counts.superseded} of them supersede an earlier version`);
            return counts;
        };
        /**
         * Rebuild one session from its transcript: drop what is stored, replay
         * every line through the same ingest path the watcher uses, then recover
         * the memory kinds that deterministic rules cannot produce.
         */
        const reimportSession = async (targetSessionId) => {
            if (!watcher)
                throw new Error("watcher is not running");
            const filePath = path.join(watcher.watchDirectory, `${targetSessionId}.jsonl`);
            if (!fs.existsSync(filePath)) {
                throw new Error(`no transcript at ${filePath}`);
            }
            const existing = await conversationStore.getConversationForSession({
                sessionId: targetSessionId,
            });
            const deleted = existing
                ? await purgeConversation(existing.conversationId)
                : {};
            // Per-session in-memory state describes rows that no longer exist.
            extractors.delete(targetSessionId);
            scorerStates.delete(targetSessionId);
            const messages = await watcher.readAllMessages(filePath);
            for (const message of messages) {
                await ingestOne(message, filePath);
            }
            // The replayed file is now fully consumed; keep the live watcher from
            // treating it as a backlog on the next poll.
            await watcher.markFileConsumed(filePath);
            const rebuilt = await conversationStore.getConversationForSession({
                sessionId: targetSessionId,
            });
            // Deterministic rules have now recovered failures, fix attempts and
            // summaries. Decisions, tasks and constraints are stated in prose and
            // have no rule that produces them, so read them back with the model.
            let keyMemories = { decision: 0, task: 0, constraint: 0, superseded: 0, skipped: false };
            if (rebuilt && !config.compactionDisableLlm) {
                keyMemories = await rebuildKeyMemories(rebuilt.conversationId, targetSessionId, await fs.promises.readFile(filePath, "utf-8"));
            }
            else if (rebuilt) {
                keyMemories.skipped = true;
                logger.info("[reimport] key-memory extraction skipped (LLM disabled by configuration)");
            }
            const stored = rebuilt
                ? await db.get("SELECT COUNT(*) AS n FROM conversation_messages WHERE conversationId = ?", rebuilt.conversationId)
                : { n: 0 };
            return {
                sessionId: targetSessionId,
                transcript: filePath,
                deleted,
                linesParsed: messages.length,
                messagesStored: stored?.n ?? 0,
                conversationId: rebuilt?.conversationId ?? null,
                keyMemories,
            };
        };
        watcher = await startProjectWatcher(logger, {
            sessionId,
            projectPath,
            pollInterval: 2000,
            // Live ingestion only: transcripts already on disk when the daemon
            // starts are treated as handled, so a restart cannot re-emit their
            // prefixes as duplicate rows. Gaps are closed with /reimport.
            seedExistingFilesToEnd: true,
            onMessage: ingestOne,
        });
        logger.info("Daemon running, watching project directory");
        // Handle shutdown
        process.on("SIGINT", async () => {
            logger.info("Received SIGINT, shutting down...");
            await cleanup();
        });
        process.on("SIGTERM", async () => {
            logger.info("Received SIGTERM, shutting down...");
            await cleanup();
        });
        async function cleanup() {
            if (watcher) {
                await watcher.stop();
            }
            try {
                lookupServer.close();
            }
            catch {
                /* ignore */
            }
            if (fs.existsSync(socketPath)) {
                try {
                    fs.unlinkSync(socketPath);
                }
                catch {
                    /* ignore */
                }
            }
            if (fs.existsSync(pidFile)) {
                fs.unlinkSync(pidFile);
            }
            await db.close();
            logger.info("Daemon stopped");
            process.exit(0);
        }
        // Keep process running
        setInterval(() => { }, 1000);
    }
    catch (error) {
        logger.error(`Daemon failed: ${error}`);
        if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
        }
        process.exit(1);
    }
}
async function stopDaemon(args) {
    const sessionId = args[0];
    if (!sessionId) {
        console.error("Usage: stop <sessionId>");
        process.exit(1);
    }
    const pidFile = getPidFilePath(sessionId);
    if (!fs.existsSync(pidFile)) {
        logger.info(`No daemon running for session ${sessionId}`);
        process.exit(0);
    }
    try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        logger.info(`Stopping daemon for session ${sessionId} (PID ${pid})`);
        process.kill(pid, "SIGTERM");
        // Wait for process to stop
        let attempts = 0;
        while (fs.existsSync(pidFile) && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }
        if (fs.existsSync(pidFile)) {
            logger.warn("PID file still exists, forcing kill");
            try {
                process.kill(pid, "SIGKILL");
            }
            catch {
                // Ignore
            }
            fs.unlinkSync(pidFile);
        }
        logger.info("Daemon stopped");
    }
    catch (error) {
        logger.error(`Failed to stop daemon: ${error}`);
        process.exit(1);
    }
}
async function checkStatus(args) {
    const sessionId = args[0];
    if (!sessionId) {
        console.error("Usage: status <sessionId>");
        process.exit(1);
    }
    const pidFile = getPidFilePath(sessionId);
    if (!fs.existsSync(pidFile)) {
        console.log(`NOT_RUNNING: No daemon for session ${sessionId}`);
        process.exit(0);
    }
    try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        process.kill(pid, 0);
        console.log(`RUNNING: Daemon for session ${sessionId} (PID ${pid})`);
    }
    catch {
        console.log(`STALE: PID file exists but process not running for session ${sessionId}`);
        fs.unlinkSync(pidFile);
    }
}
main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=daemon.js.map