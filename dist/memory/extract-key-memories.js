/**
 * CodeMemory for Claude Code - Key memory extraction for re-import
 *
 * A re-import rebuilds a session from its transcript. The deterministic
 * extractors recover failures, fix attempts and summaries, because those are
 * derivable from tool results and errors. Decisions, tasks and constraints are
 * not: they are stated in prose, and until now the only way they entered the
 * store was a mark skill the model had to choose to invoke.
 *
 * A full-delete re-import would therefore lose them permanently, so this pass
 * reads them back out of the transcript with an LLM.
 */
import { spawn } from "node:child_process";
import { buildClaudeCliArgs, claudeCliSpawnEnv, describeClaudeCliFailure, } from "../llm/claude-cli.js";
const DEFAULT_CHUNK_CHARS = 24_000;
const DEFAULT_MAX_CHUNKS = 20;
const DEFAULT_TIMEOUT_MS = 60_000;
const PROMPT = `You are reading an excerpt of a software engineering session transcript, in chronological order.

Extract durable engineering memory of three kinds:
- "decision": a technical choice that was committed to (schema shape, library, refactor direction, boundary). Include why, and any alternative explicitly rejected.
- "task": a non-trivial objective the work is pursuing.
- "constraint": a hard rule the work must respect (compatibility boundary, performance budget, security or compliance requirement, an explicit must-not).

A session changes its mind. When a later statement replaces an earlier one — a decision reversed, a task retargeted, a constraint relaxed or tightened — report BOTH, in the order they occurred, and set "revises" on the later one to the exact "statement" text of the item it replaces. Do not silently drop the earlier version: how the work arrived at its position is part of the record.

Rules:
- Extract only what the transcript states or clearly commits to. Never infer, generalize, or invent.
- List items in the order they appear.
- Skip trivia and exploratory musing that was never committed to.
- Prefer few high-value items over many weak ones. An excerpt with nothing durable yields an empty list.

Reply with JSON only, no prose and no code fence:
{"items":[{"kind":"decision|task|constraint","statement":"...","rationale":"...","alternativesRejected":["..."],"revises":"..."}]}`;
/**
 * Build the text an extraction pass should read, straight from the raw
 * transcript.
 *
 * Only prose carries decisions, tasks and constraints: what the user asked
 * for, what the assistant said, and what it reasoned about. Tool calls and
 * tool results are the bulk of a transcript — 682 of 1096 content parts in a
 * real session here — and contain none of it, so feeding them to the model
 * costs tokens and dilutes the signal.
 *
 * This reads the file directly rather than reusing the ingest parser, for two
 * reasons: that parser drops `thinking` blocks entirely (221 of them in the
 * same session), and it renders tool calls into the flattened content string,
 * which would be the opposite of what is wanted here.
 */
export function buildExtractionTranscript(rawFileContent) {
    const out = [];
    for (const line of rawFileContent.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const role = entry?.message?.role ?? entry?.type;
        if (role !== "user" && role !== "assistant")
            continue;
        // Subagent chatter is not this session's engineering record.
        if (entry?.isSidechain)
            continue;
        const content = entry?.message?.content;
        const segments = [];
        if (typeof content === "string") {
            segments.push(content);
        }
        else if (Array.isArray(content)) {
            for (const part of content) {
                if (part?.type === "text" && typeof part.text === "string") {
                    segments.push(part.text);
                }
                else if (part?.type === "thinking" && typeof part.thinking === "string") {
                    segments.push(`(reasoning) ${part.thinking}`);
                }
                // tool_use and tool_result are intentionally skipped.
            }
        }
        const text = segments.join("\n").trim();
        if (text)
            out.push(`[${role.toUpperCase()}] ${text}`);
    }
    return out.join("\n\n");
}
export async function extractKeyMemories(transcript, options = {}) {
    const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
    const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    const chunks = chunkTranscript(transcript, chunkChars).slice(0, maxChunks);
    if (chunks.length === 0)
        return [];
    options.log?.info(`[reimport] extracting key memories from ${chunks.length} chunk(s)`);
    const collected = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            // Carry what earlier chunks produced into this one. Without it a
            // revision can only ever be spotted inside a single excerpt, and a
            // decision reversed two chunks later reads as an unrelated second
            // decision.
            const priorContext = collected.length > 0
                ? `\n\n--- already extracted from earlier excerpts (set "revises" to one of these statements if this excerpt replaces it) ---\n` +
                    collected.map((m) => `- [${m.kind}] ${m.statement}`).join("\n")
                : "";
            const raw = await runClaude(`${PROMPT}${priorContext}\n\n--- transcript excerpt ${i + 1}/${chunks.length} ---\n${chunks[i]}`, options);
            collected.push(...parseItems(raw));
        }
        catch (error) {
            // One bad chunk must not discard the rest: a partial rebuild of these
            // nodes is better than none, and the failure is visible in the log.
            options.log?.warn(`[reimport] key-memory extraction failed on chunk ${i + 1}/${chunks.length}: ${error}`);
        }
    }
    return dedupe(collected);
}
/** Split on line boundaries so a record is never cut mid-way. */
function chunkTranscript(transcript, chunkChars) {
    const lines = transcript.split("\n").filter((l) => l.trim());
    const chunks = [];
    let current = [];
    let size = 0;
    for (const line of lines) {
        if (size + line.length > chunkChars && current.length > 0) {
            chunks.push(current.join("\n"));
            current = [];
            size = 0;
        }
        current.push(line);
        size += line.length + 1;
    }
    if (current.length > 0)
        chunks.push(current.join("\n"));
    return chunks;
}
function parseItems(raw) {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return [];
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
        .map((item) => {
        const kind = item?.kind;
        const statement = typeof item?.statement === "string" ? item.statement.trim() : "";
        if (kind !== "decision" && kind !== "task" && kind !== "constraint")
            return null;
        if (!statement)
            return null;
        return {
            kind,
            statement,
            rationale: typeof item?.rationale === "string" ? item.rationale.trim() : "",
            alternativesRejected: Array.isArray(item?.alternativesRejected)
                ? item.alternativesRejected.filter((a) => typeof a === "string")
                : undefined,
            revises: typeof item?.revises === "string" && item.revises.trim()
                ? item.revises.trim()
                : undefined,
        };
    })
        .filter((x) => x !== null);
}
/**
 * Collapse only exact restatements — the same item reported twice because
 * chunks overlap in subject matter.
 *
 * An item carrying `revises` is never folded away even if its statement
 * matches something seen before: it is a distinct point in the session's
 * history, and dropping it would flatten the revision chain this pass exists
 * to preserve. Order is preserved throughout, because the rebuild creates
 * nodes in sequence and each supersede has to land on a node that already
 * exists.
 */
function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (item.revises) {
            out.push(item);
            continue;
        }
        const key = `${item.kind}:${item.statement.toLowerCase().replace(/\s+/g, " ")}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
function runClaude(prompt, options) {
    return new Promise((resolve, reject) => {
        const child = spawn("claude", buildClaudeCliArgs(options.model), {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeCliSpawnEnv(),
        });
        const stdout = [];
        const stderr = [];
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.stdout.on("data", (c) => stdout.push(c));
        child.stderr.on("data", (c) => stderr.push(c));
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
                reject(new Error(`claude --print exited with code ${code}: ${describeClaudeCliFailure(Buffer.concat(stdout).toString("utf-8"), Buffer.concat(stderr).toString("utf-8"))}`));
                return;
            }
            resolve(Buffer.concat(stdout).toString("utf-8").trim());
        });
        child.stdin.write(prompt);
        child.stdin.end();
    });
}
//# sourceMappingURL=extract-key-memories.js.map