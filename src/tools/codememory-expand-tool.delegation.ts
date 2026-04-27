/**
 * CodeMemory for Claude Code - Expansion Delegation
 *
 * Spawns a fresh Claude Code session via `claude --print` to answer an
 * expansion query in isolation from the parent conversation. Reuses the
 * existing Claude Code authentication — no separate API key needed.
 */

import { spawn } from "node:child_process";
import type { CodeMemoryDependencies } from "../types.js";

export interface DelegationParams {
  taskSummary: string;
  tokenBudget: number;
  queryLanguage?: string;
  timeoutMs?: number;
}

export interface DelegationResult {
  success: boolean;
  response?: string;
  tokensUsed: number;
  error?: string;
}

const SUBAGENT_SYSTEM_PROMPT =
  "You are a memory-expansion subagent for the CodeMemory plugin. " +
  "Answer the user's question using only the provided conversation history excerpts. " +
  "Be concise and factual. If the excerpts don't contain enough information, say so explicitly.";

export class CodeMemoryExpansionDelegation {
  constructor(private deps: CodeMemoryDependencies) {}

  async delegate(params: DelegationParams): Promise<DelegationResult> {
    try {
      this.deps.log.debug(`Spawning claude --print subagent for task: ${params.taskSummary.slice(0, 120)}…`);

      const prompt = params.queryLanguage
        ? `<query_language>${params.queryLanguage}</query_language>\n${params.taskSummary}`
        : params.taskSummary;

      const response = await spawnClaudePrint(
        prompt,
        SUBAGENT_SYSTEM_PROMPT,
        params.timeoutMs ?? this.deps.config.delegationTimeoutMs ?? 120_000
      );

      if (!response) {
        return { success: false, tokensUsed: 0, error: "empty response from claude --print" };
      }

      return { success: true, response, tokensUsed: 0 };
    } catch (error) {
      this.deps.log.error(`Subagent delegation failed: ${error}`);
      return {
        success: false,
        tokensUsed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createExpansionDelegation(deps: CodeMemoryDependencies): CodeMemoryExpansionDelegation {
  return new CodeMemoryExpansionDelegation(deps);
}

/**
 * Spawn `claude --print` with the given prompt on stdin, return trimmed stdout.
 * Rejects on non-zero exit or timeout.
 */
function spawnClaudePrint(
  prompt: string,
  systemPrompt: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--bare` keeps the subagent isolated from the parent session: it
    // skips our own SessionStart/PreToolUse/etc hooks and plugin sync, so
    // the child won't start another CodeMemory daemon against the same sqlite
    // file. Without this, expansion delegation was silently reentrant.
    // TODO(api-migration): same as the compactor — replace this spawn
    // with a direct Anthropic Messages API call once we add an HTTP
    // client path.
    const child = spawn(
      "claude",
      ["--bare", "--print", "--output-format", "text", "--append-system-prompt", systemPrompt],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

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

    child.stdin.write(prompt, "utf-8");
    child.stdin.end();
  });
}
