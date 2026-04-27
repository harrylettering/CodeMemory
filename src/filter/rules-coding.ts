/**
 * Coding-specific Filter/Score rules.
 *
 * Operates on a single normalized JsonlMessage and returns its tier + tags
 * + final content. Designed to be readable and easy to extend rule-by-rule;
 * any unmatched case falls through to a safe default of M (no data loss).
 */

import type { JsonlMessage, RawMessagePart } from "../hooks/jsonl-watcher.js";
import type {
  ScoreResult,
  ScorerSessionState,
  MessageTier,
  ScoreContext,
} from "./scorer.js";
import { recordToolUseTier, touchExploredTarget } from "./scorer.js";

// ──────────────────────────────────────────────────────────────────────────
// Pattern dictionaries
// ──────────────────────────────────────────────────────────────────────────

/** Words that signal the user is correcting / pushing back on the assistant. */
const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\b(no|nope|don['']?t|stop|wait|wrong|incorrect|undo|revert|rollback)\b/i,
  /不对|错了|不要|别|回退|撤销|停|不是这样|重来/,
];

/**
 * Words that signal substantive analysis, decision, fix, or summary.
 *
 * Deliberately tighter than the obvious "decision vocabulary":
 *   - bare `because`, `instead of`, `因为`, `原因`, `应该` are removed —
 *     they appear constantly in prose ("I read it because you asked",
 *     "this is because of X") and over-promoted every other response to S.
 *   - phrases now require a verb + direction (`decided`, `switched from`)
 *     or a clear causation frame (`root cause`, `问题在于`), not a lone
 *     connective word.
 *
 * Matching is also gated by `DECISION_MIN_CHARS` in the caller — a real
 * decision always explains something, so "修复：是的" (7 chars) won't pass.
 */
const DECISION_PATTERNS: RegExp[] = [
  // English — explicit choice / pivot verbs.
  /\b(decided|chose|choosing|going with|switched (?:from|to)|switching (?:from|to)|rolled back|rejected|ruled out)\b/i,
  // English — strong causation / diagnosis frames.
  /\b(root cause|caused by|the (?:issue|problem|bug) (?:is|was|turned out)|the fix (?:is|was))\b/i,
  // English — fix verbs in result position (past / passive) + line-start "fix:"
  /\b(fixed by|resolved by)\b/i,
  /^[\s>*\-]*fix:\s/im,
  // Chinese — choice / pivot (bare `因为`/`应该` dropped)
  /我决定|最终(?:采用|选择|决定)|所以(?:选择|采用|改用)|改用[^，。]+代替|(?:放弃|回退到)[^，。]+改用/,
  // Chinese — causation (bare `原因`/`因为` dropped; require fuller phrases)
  /根本原因|失败原因|问题(?:在于|出在)|之所以[^。]*是因为/,
  // Chinese — fix / summary statements
  /已修复|通过[^，。]+修复|修复[:：]|解决了[^。]*问题|总结[:：]|说明[:：]|优化(?:点|项)|改进(?:点|项)/,
];

/**
 * Minimum character length for a decision-keyword match to promote an
 * assistant text part to S. Shorter hits (e.g. "说明：是的", "fix: ok")
 * stay at M since real decisions explain *something*, not just label a
 * sentence. Chinese compresses denser than English — an informative
 * decision like "通过X修复Y" can be ~28 chars — so keep the threshold low.
 */
const DECISION_MIN_CHARS = 20;

/**
 * Length above which an assistant text part is auto-promoted to S — but
 * only together with a structural signal (see `hasStructureSignal`).
 *
 * The old 200-char threshold caught everyday scaffolding like
 * "I'll check the file and then run the tests to see what happens…" and
 * promoted it to S. In coding sessions that kind of narration is common
 * and low-signal; real substantive output (analysis, review, plan) almost
 * always carries structure — code fences, bullet lists, multi-paragraph
 * reasoning, tables, or headings.
 */
const ASSISTANT_TEXT_S_THRESHOLD = 500;

/**
 * Detect structural signals that suggest the text is substantive rather
 * than prose narration. Used as a joint gate alongside length to promote
 * to S via the long-form path.
 */
function hasStructureSignal(text: string): boolean {
  // Fenced code block
  if (/```/.test(text)) return true;
  // Markdown heading at line start
  if (/^#+\s/m.test(text)) return true;
  // Table row — require two inner separators to avoid matching a lone
  // "|" in prose.
  if (/\n\s*\|[^\n]*\|[^\n]*\|/.test(text)) return true;
  // At least two list items (bullet or numbered)
  const listMatches = text.match(/(?:^|\n)\s*(?:[-*+]|\d+\.)\s+\S/g);
  if (listMatches && listMatches.length >= 2) return true;
  // At least two indented code lines (4-space indent)
  const indentedCode = text.match(/(?:^|\n) {4}\S/g);
  if (indentedCode && indentedCode.length >= 2) return true;
  // Two or more paragraph breaks (blank line) → multi-section reasoning
  const paragraphBreaks = text.match(/\n\s*\n/g);
  if (paragraphBreaks && paragraphBreaks.length >= 2) return true;
  return false;
}

/** Tools that mutate state — always M tier minimum. */
const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools that execute commands — M, with failure escalating to S. */
const EXEC_TOOLS = new Set(["Bash"]);

/** Tools that only read / search — L tier, repeats become N. */
const EXPLORATION_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
]);

/**
 * Skill names that mark a durable memory event. Detection of these in the
 * assistant's tool_use stream is what bridges the daemon-side memory_node
 * write (via the Skill body's curl) and the conversation_messages
 * S-tier row written here. Without this rule the Skill tool_use would
 * fall through to the generic `tool_other` branch and end up at M tier.
 */
const MARK_SKILLS: Record<string, { tags: string[]; prefix: string }> = {
  "codememory-mark-decision": { tags: ["decision", "mark_decision"], prefix: "[DECISION]" },
  "codememory-mark-task": { tags: ["requirement", "task", "mark_requirement"], prefix: "[TASK]" },
  "codememory-mark-constraint": {
    tags: ["requirement", "constraint", "mark_requirement"],
    prefix: "[CONSTRAINT]",
  },
};

/**
 * Scaffolding / UI-meta tools that don't produce durable memory signal.
 *
 *   - `TodoWrite` is the assistant re-writing its own plan; the plan itself
 *     is derivable from surrounding user prompts + decisions and would
 *     otherwise dominate the conversation row count (it's called after
 *     nearly every step).
 *   - `ExitPlanMode` is a pure UI state transition.
 *
 * These were previously falling through to the catch-all `M` branch with a
 * `tool_other` tag, which both polluted M-tier with low-signal rows and
 * kept their `tool_result` replies as M too (storing the full todo JSON).
 */
const SCAFFOLDING_TOOLS = new Set(["TodoWrite", "ExitPlanMode"]);

/**
 * Patterns that strongly suggest a tool result contains a real error.
 *
 * Used only in the orphan fallback path (when the originating tool_use can't
 * be resolved via tool_use_id). In the main flow `is_error === true` is the
 * primary signal. Kept deliberately tight — bare "error" / "failed" / "exception"
 * tokens false-positive on: docs that discuss errors, "no errors found" output,
 * code containing `error` identifiers, "0 failed", etc.
 */
const ERROR_RESULT_PATTERNS: RegExp[] = [
  // Python
  /Traceback \(most recent call last\)/,
  /\b(SyntaxError|TypeError|ReferenceError|NameError|AttributeError|KeyError|ValueError|IndexError|RuntimeError|FileNotFoundError|PermissionError|ModuleNotFoundError|ImportError|ZeroDivisionError)\b/,
  // JS / TS
  /\bTS\d{4}\b/,
  /Cannot find module/i,
  /Cannot read propert/i,
  /is not a function/,
  /Unexpected token/,
  // Node / syscall / network
  /\b(ENOENT|EACCES|EPERM|ENOTFOUND|EISDIR|ENOTDIR|ECONNREFUSED|ETIMEDOUT)\b/,
  /\bnpm ERR!/,
  /\bELIFECYCLE\b/,
  // Go
  /^panic: /m,
  /^FAIL\t/m,
  // Rust
  /\berror\[E\d{4}\]/,
  /thread '.*' panicked/,
  // gcc/clang/ESLint-style diagnostics: "file:line[:col]: error|fatal: …"
  /^[^:\n]+:\d+:(?:\d+:)?\s*(?:error|fatal):\s/m,
  // git / bare "fatal: …" at line start (no file prefix)
  /^fatal:\s/m,
  // bare "error: …" only at true line start (not mid-sentence prose)
  /^error:\s/m,
  // Non-zero exit code — explicit digits only. The old `[^0]` regex
  // matched any non-`0` character, so `exit code ` with a trailing space
  // or newline false-positived.
  /\bexit code (?:[1-9]\d*|-\d+)\b/i,
  // Test runner summary lines
  /\bTests?:\s+\d+ failed/i,
  /^FAIL\s+/m,
];

/** Hard cap on stored content for M-tier results to avoid blowing the row. */
const M_TIER_CONTENT_CAP = 2000;

// ──────────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────────

export function applyCodingRules(
  msg: JsonlMessage,
  state: ScorerSessionState,
  ctx: ScoreContext
): ScoreResult {
  // User messages: always S, but check for correction signal.
  if (msg.role === "user") {
    return scoreUserMessage(msg, state);
  }

  // Assistant messages: drive off the structured parts. The dominant tier
  // wins; tags accumulate across parts.
  if (msg.role === "assistant") {
    return scoreAssistantMessage(msg, state, ctx);
  }

  // Tool role or anything else: treat as M, store as-is (capped).
  return {
    tier: "M",
    tags: ["other"],
    content: capContent(msg.content),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// User
// ──────────────────────────────────────────────────────────────────────────

function scoreUserMessage(
  msg: JsonlMessage,
  state: ScorerSessionState
): ScoreResult {
  // A user message in the JSONL may actually be a tool_result reply
  // (Claude Code wraps tool returns as user-role entries). We detect that
  // by inspecting the structured parts.
  const parts = msg.metadata?.parts ?? [];
  const toolResults = parts.filter(
    (p): p is Extract<RawMessagePart, { type: "tool_result" }> =>
      p.type === "tool_result"
  );

  if (toolResults.length > 0) {
    return scoreToolResults(toolResults, msg.content, state);
  }

  // Real user prompt.
  const text = msg.content;
  const tags = ["user_input"];
  if (USER_CORRECTION_PATTERNS.some((re) => re.test(text))) {
    tags.push("user_correction");
  }
  return { tier: "S", tags, content: text };
}

// ──────────────────────────────────────────────────────────────────────────
// Assistant
// ──────────────────────────────────────────────────────────────────────────

function scoreAssistantMessage(
  msg: JsonlMessage,
  state: ScorerSessionState,
  ctx: ScoreContext
): ScoreResult {
  const parts = msg.metadata?.parts ?? [];
  if (parts.length === 0) {
    return { tier: "M", tags: ["assistant_empty"], content: msg.content };
  }

  let bestTier: MessageTier = "N";
  const tags = new Set<string>();
  const contentSegments: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      const text = part.text ?? "";
      if (!text.trim()) continue;
      const matchesDecision = DECISION_PATTERNS.some((re) => re.test(text));
      // Require a minimum length alongside the keyword — a lone
      // "修复：是的" shouldn't elevate a whole message to S.
      const isDecision = matchesDecision && text.length >= DECISION_MIN_CHARS;
      // Long-form path: length AND structure together. Either alone is
      // too permissive — long prose narration is still scaffolding, and
      // short structured blurbs are handled by the decision path above.
      const isLongForm =
        text.length >= ASSISTANT_TEXT_S_THRESHOLD && hasStructureSignal(text);
      if (isDecision || isLongForm) {
        bestTier = pickHigher(bestTier, "S");
        tags.add(isDecision ? "decision" : "assistant_longform");
        contentSegments.push(text);
      } else {
        bestTier = pickHigher(bestTier, "M");
        tags.add("assistant_text");
        contentSegments.push(text);
      }
      continue;
    }

    if (part.type === "tool_use") {
      const toolName = part.name ?? "";
      const input = part.input ?? {};
      let partTier: MessageTier = "M";

      // Skill invocations of the CodeMemory mark-* skills are durable memory
      // punctuation. The actual memory_node write happens in the daemon
      // (the Skill body curls /mark/decision or /mark/requirement). Here
      // we just elevate the row to S and attach the right tags so retrieval
      // sees a tagged S-tier conversation_message alongside the node.
      if (toolName === "Skill") {
        const skillName =
          typeof input?.skill === "string" ? input.skill.trim() : "";
        const markRule = MARK_SKILLS[skillName];
        if (markRule) {
          partTier = "S";
          for (const tag of markRule.tags) tags.add(tag);
          const skillArgs =
            typeof input?.args === "string" ? input.args.trim() : "";
          contentSegments.push(
            skillArgs ? `${markRule.prefix} ${skillArgs}` : markRule.prefix
          );
          recordToolUseTier(state, part.id, partTier, toolName);
          bestTier = pickHigher(bestTier, partTier);
          continue;
        }
      }

      if (SCAFFOLDING_TOOLS.has(toolName)) {
        // Drop outright. We still call recordToolUseTier below so the
        // matching tool_result also drops (via originTier === "N").
        partTier = "N";
      } else if (MUTATION_TOOLS.has(toolName)) {
        partTier = "M";
        tags.add("mutation");
        contentSegments.push(renderMutation(toolName, input));
      } else if (EXEC_TOOLS.has(toolName)) {
        partTier = "M";
        tags.add("exec");
        contentSegments.push(renderExec(toolName, input));
      } else if (EXPLORATION_TOOLS.has(toolName)) {
        const target = exploreTarget(toolName, input);
        const lastSeen = target ? state.exploredTargets.get(target) : undefined;
        const withinWindow =
          lastSeen !== undefined &&
          ctx.nowMs - lastSeen < ctx.exploredTargetWindowMs;
        if (target && withinWindow) {
          // Repeated exploration within the dedup window — this part
          // degrades to N. Record the tier so the matching tool_result
          // entry also gets dropped. We deliberately do NOT refresh
          // lastSeenAt here, otherwise a busy session could keep a stale
          // target "fresh" forever and block legitimate re-reads.
          partTier = "N";
        } else {
          if (target) touchExploredTarget(state, target, ctx.nowMs);
          partTier = "L";
          tags.add("exploration");
          contentSegments.push(`[${toolName}] ${target ?? ""}`.trim());
        }
      } else {
        partTier = "M";
        tags.add("tool_other");
        contentSegments.push(`[tool:${toolName}]`);
      }

      recordToolUseTier(state, part.id, partTier, toolName);
      bestTier = pickHigher(bestTier, partTier);
      continue;
    }
  }

  if (bestTier === "N" || contentSegments.length === 0) {
    return { tier: "N", tags: ["assistant_noise"], content: "" };
  }

  return {
    tier: bestTier,
    tags: Array.from(tags),
    content: capContent(contentSegments.join("\n")),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tool result handling (delivered as user-role entries by Claude Code)
// ──────────────────────────────────────────────────────────────────────────

function scoreToolResults(
  results: Array<Extract<RawMessagePart, { type: "tool_result" }>>,
  flattened: string,
  state: ScorerSessionState
): ScoreResult {
  let hasExplicitError = false;
  let allEmpty = true;

  for (const r of results) {
    const text =
      typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    if (text && text.trim().length > 0) allEmpty = false;
    if (r.is_error === true) hasExplicitError = true;
  }

  if (allEmpty) {
    return { tier: "N", tags: ["empty_result"], content: "" };
  }

  // Look up the originating tool_use to inherit its tier. First resolvable
  // id wins — tool_result messages almost always carry one result, but we
  // still walk in case a batch got squashed together.
  let originTier: MessageTier | null = null;
  let originToolName: string | null = null;
  for (const r of results) {
    if (r.tool_use_id) {
      const entry = state.toolUseTiers.get(r.tool_use_id);
      if (entry) {
        originTier = entry.tier;
        originToolName = entry.toolName;
        break;
      }
    }
  }

  // Explicit errors always win — a Read that fails is as important as a
  // Bash that fails, regardless of the originating tool's tier.
  if (hasExplicitError) {
    return {
      tier: "S",
      tags: ["tool_result", "error"],
      content: capContent(flattened),
    };
  }

  // Matching tool_use was deduped or classified as noise → drop the result
  // too, otherwise L-tier dedup is defeated by the result side.
  if (originTier === "N") {
    return { tier: "N", tags: ["tool_result_of_dropped"], content: "" };
  }

  // L-tier: store a fact summary only, never the raw payload. This is the
  // whole point of L-tier — we already recorded the tool_use target, all
  // the result adds is "how much came back".
  if (originTier === "L" && originToolName) {
    return {
      tier: "L",
      tags: ["tool_result", "exploration"],
      content: summarizeExplorationResult(originToolName, results),
    };
  }

  if (originTier === "S" || originTier === "M") {
    return {
      tier: originTier,
      tags: ["tool_result"],
      content: capContent(flattened),
    };
  }

  // Orphan: no tool_use_id, or the originating tool_use was evicted from
  // the FIFO cap. Fall back to a pattern-based error check so we at least
  // don't lose obvious failures. Check each result's raw content (not the
  // watcher-prefixed `flattened` string) so line-start anchors like
  // /^panic: /m or /^fatal:/m actually fire.
  const looksLikeError = results.some((r) => {
    const text =
      typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? "");
    return ERROR_RESULT_PATTERNS.some((re) => re.test(text));
  });
  if (looksLikeError) {
    return {
      tier: "S",
      tags: ["tool_result", "error_inferred"],
      content: capContent(flattened),
    };
  }
  return {
    tier: "M",
    tags: ["tool_result", "orphan"],
    content: capContent(flattened),
  };
}

function summarizeExplorationResult(
  toolName: string,
  results: Array<Extract<RawMessagePart, { type: "tool_result" }>>
): string {
  let totalBytes = 0;
  let totalLines = 0;
  for (const r of results) {
    const text =
      typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? "");
    totalBytes += text.length;
    totalLines += text.length > 0 ? text.split("\n").length : 0;
  }
  switch (toolName) {
    case "Read":
      return `[Read result] ${totalLines} lines, ${totalBytes} bytes`;
    case "Grep":
      return `[Grep result] ${totalLines} match lines`;
    case "Glob":
      return `[Glob result] ${totalLines} paths`;
    case "LS":
      return `[LS result] ${totalLines} entries`;
    case "WebFetch":
      return `[WebFetch result] ${totalBytes} bytes`;
    default:
      return `[${toolName} result] ${totalLines} lines, ${totalBytes} bytes`;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function exploreTarget(toolName: string, input: any): string | null {
  if (!input || typeof input !== "object") return null;

  // Grep matters on (pattern, path, glob, type) together — the same
  // pattern searched under different scopes is a different exploration.
  // The old key used just `pattern`, which made a second Grep of the same
  // regex in another directory falsely count as a duplicate.
  if (toolName === "Grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const path = typeof input.path === "string" ? input.path : "";
    const glob = typeof input.glob === "string" ? input.glob : "";
    const type = typeof input.type === "string" ? input.type : "";
    if (!pattern && !path && !glob && !type) return null;
    return `Grep:${pattern}|${path}|${glob}|${type}`;
  }

  if (typeof input.file_path === "string") return `${toolName}:${input.file_path}`;
  if (typeof input.path === "string") return `${toolName}:${input.path}`;
  if (typeof input.pattern === "string") return `${toolName}:${input.pattern}`;
  if (typeof input.url === "string") return `${toolName}:${input.url}`;
  return null;
}

function renderMutation(toolName: string, input: any): string {
  const target = input?.file_path ?? input?.path ?? "?";
  return `[${toolName}] ${target}`;
}

function renderExec(toolName: string, input: any): string {
  const cmd = input?.command ?? "";
  // Cap command rendering — long heredoc'd commands shouldn't fill the row.
  const trimmed = cmd.length > 500 ? cmd.slice(0, 500) + "…" : cmd;
  return `[${toolName}] ${trimmed}`;
}

function capContent(s: string): string {
  if (s.length <= M_TIER_CONTENT_CAP) return s;
  return s.slice(0, M_TIER_CONTENT_CAP) + `\n…[truncated ${s.length - M_TIER_CONTENT_CAP} chars]`;
}

const TIER_RANK: Record<MessageTier, number> = { N: 0, L: 1, M: 2, S: 3 };
function pickHigher(a: MessageTier, b: MessageTier): MessageTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
