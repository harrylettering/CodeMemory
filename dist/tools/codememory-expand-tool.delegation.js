/**
 * CodeMemory for Claude Code - Expansion Delegation
 *
 * Spawns a fresh Claude Code session via `claude --print` to answer an
 * expansion query in isolation from the parent conversation. Reuses the
 * existing Claude Code authentication — no separate API key needed.
 */
import { spawn } from "node:child_process";
const SUBAGENT_SYSTEM_PROMPT = "You are a memory-expansion subagent for the CodeMemory plugin. " +
    "Answer the user's question using only the provided conversation history excerpts. " +
    "Be concise and factual. If the excerpts don't contain enough information, say so explicitly.";
export class CodeMemoryExpansionDelegation {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async delegate(params) {
        try {
            this.deps.log.debug(`Spawning claude --print subagent for task: ${params.taskSummary.slice(0, 120)}…`);
            const prompt = params.queryLanguage
                ? `<query_language>${params.queryLanguage}</query_language>\n${params.taskSummary}`
                : params.taskSummary;
            const model = this.deps.config.expansionModel ?? this.deps.config.compactionModel;
            const response = await spawnClaudePrint(prompt, SUBAGENT_SYSTEM_PROMPT, params.timeoutMs ?? this.deps.config.delegationTimeoutMs ?? 120_000, model);
            if (!response) {
                return { success: false, tokensUsed: 0, error: "empty response from claude --print" };
            }
            return { success: true, response, tokensUsed: 0 };
        }
        catch (error) {
            this.deps.log.error(`Subagent delegation failed: ${error}`);
            return {
                success: false,
                tokensUsed: 0,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
export function createExpansionDelegation(deps) {
    return new CodeMemoryExpansionDelegation(deps);
}
/**
 * Spawn `claude --print` with the given prompt on stdin, return trimmed stdout.
 * Rejects on non-zero exit or timeout.
 */
function spawnClaudePrint(prompt, systemPrompt, timeoutMs, model) {
    return new Promise((resolve, reject) => {
        // `--bare` keeps the subagent isolated from the parent session: it
        // skips our own SessionStart/PreToolUse/etc hooks and plugin sync, so
        // the child won't start another CodeMemory daemon against the same sqlite
        // file. Without this, expansion delegation was silently reentrant.
        const args = [
            "--bare",
            "--print",
            "--output-format",
            "text",
            "--append-system-prompt",
            systemPrompt,
        ];
        if (model) {
            args.push("--model", model);
        }
        const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
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
                const stderr = Buffer.concat(stderrChunks).toString("utf-8").slice(0, 500);
                reject(new Error(`claude --print exited with code ${code}: ${stderr}`));
                return;
            }
            resolve(Buffer.concat(stdoutChunks).toString("utf-8").trim());
        });
        child.stdin.write(prompt, "utf-8");
        child.stdin.end();
    });
}
//# sourceMappingURL=codememory-expand-tool.delegation.js.map