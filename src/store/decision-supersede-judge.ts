/**
 * LLM-as-judge backstop for decision supersession.
 *
 * Same-conversation only. Given a freshly written decision and the set of
 * currently-active decisions in the same conversation, ask the model whether
 * any of the older decisions are now overridden by the new one. The model
 * returns a verdict per old decision; we trust nothing it didn't explicitly
 * mark `SUPERSEDED_BY_NEW`.
 *
 * This runs only when `CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM=true` and only when the
 * caller did NOT pass an explicit `supersedesNodeId`. Cross-session conflicts
 * are never auto-handled — that is a deliberate design choice.
 */
import { spawn } from "node:child_process";

export interface DecisionJudgeCandidate {
  nodeId: string;
  content: string;
}

export type DecisionJudgeVerdict = "KEEP" | "SUPERSEDED_BY_NEW";

export interface DecisionJudgeOutcome {
  nodeId: string;
  verdict: DecisionJudgeVerdict;
  reason?: string;
}

export interface DecisionJudgeInput {
  newDecision: { nodeId: string; content: string };
  candidates: DecisionJudgeCandidate[];
}

export interface DecisionSupersedeJudge {
  judge(input: DecisionJudgeInput): Promise<DecisionJudgeOutcome[]>;
}

export interface DecisionJudgeConfig {
  model: string;
  timeoutMs: number;
}

export class ClaudeDecisionSupersedeJudge implements DecisionSupersedeJudge {
  constructor(
    private config: DecisionJudgeConfig,
    private runCompletion: (prompt: string) => Promise<string> = (prompt) =>
      runClaudeJudge(prompt, this.config)
  ) {}

  async judge(input: DecisionJudgeInput): Promise<DecisionJudgeOutcome[]> {
    if (input.candidates.length === 0) return [];
    const prompt = buildJudgePrompt(input);
    const output = await this.runCompletion(prompt);
    return parseJudgeOutput(output, input.candidates);
  }
}

export function createDecisionSupersedeJudge(
  config: DecisionJudgeConfig
): DecisionSupersedeJudge {
  return new ClaudeDecisionSupersedeJudge(config);
}

function buildJudgePrompt(input: DecisionJudgeInput): string {
  const candidatesBlock = input.candidates
    .map(
      (c, i) =>
        `--- candidate[${i}] nodeId=${c.nodeId} ---\n${truncate(c.content, 1200)}`
    )
    .join("\n");
  return [
    "You are evaluating engineering DECISIONS recorded in one conversation.",
    "A NEW decision was just made. Decide whether each OLD decision is now",
    "directly overridden (the new one contradicts or replaces it on the same",
    "topic) or remains independently valid.",
    "",
    "Be conservative. Mark SUPERSEDED_BY_NEW only when the new decision",
    "clearly replaces the old one's conclusion. Refinements, additions,",
    "and decisions on different topics MUST be marked KEEP.",
    "",
    "Return ONLY a JSON array, one entry per candidate, no prose:",
    '[{"nodeId":"...","verdict":"KEEP"|"SUPERSEDED_BY_NEW","reason":"<short>"}]',
    "",
    `=== NEW decision (nodeId=${input.newDecision.nodeId}) ===`,
    truncate(input.newDecision.content, 1500),
    "",
    "=== OLD decisions (candidates) ===",
    candidatesBlock,
  ].join("\n");
}

function parseJudgeOutput(
  output: string,
  candidates: DecisionJudgeCandidate[]
): DecisionJudgeOutcome[] {
  const trimmed = (output || "").trim();
  if (!trimmed) return [];
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      raw = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const valid = new Set(candidates.map((c) => c.nodeId));
  const seen = new Set<string>();
  const outcomes: DecisionJudgeOutcome[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId : null;
    if (!nodeId || !valid.has(nodeId) || seen.has(nodeId)) continue;
    const verdict =
      entry.verdict === "SUPERSEDED_BY_NEW" ? "SUPERSEDED_BY_NEW" : "KEEP";
    const reason = typeof entry.reason === "string" ? entry.reason : undefined;
    seen.add(nodeId);
    outcomes.push({ nodeId, verdict, reason });
  }
  return outcomes;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function runClaudeJudge(
  prompt: string,
  config: DecisionJudgeConfig
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--bare", "--print", "--output-format", "text"];
    if (config.model) args.push("--model", config.model);
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`decision judge timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
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
        reject(new Error(`decision judge exited ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8").trim());
    });
    child.stdin.write(prompt, "utf-8");
    child.stdin.end();
  });
}
