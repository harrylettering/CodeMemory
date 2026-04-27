/**
 * CodeMemory for Claude Code - Configuration Management
 *
 * Reimplemented from CodeMemory's config.ts
 *
 * Configuration priority:
 * 1. Environment variables (CODEMEMORY_* format)
 * 2. Plugin configuration in claude.ai/code
 * 3. Default values
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface CodeMemoryConfig {
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 64) */
  freshTailCount: number;
  /** Minimum number of depth-0 summaries needed for condensation. */
  leafMinFanout: number;
  /** Minimum number of depth>=1 summaries needed for condensation. */
  condensedMinFanout: number;
  /** Relaxed minimum fanout for hard-trigger sweeps. */
  condensedMinFanoutHard: number;
  /** Incremental depth passes to run after each leaf compaction (default 1). */
  incrementalMaxDepth: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Target tokens for leaf summaries (default 1200) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 2000) */
  condensedTargetTokens: number;
  /** Maximum compaction rounds (default 10) */
  maxRounds: number;
  /** IANA timezone for timestamps in summaries (default: UTC) */
  timezone?: string;
  /** Maximum allowed overage factor for summaries relative to target tokens (default 3). */
  summaryMaxOverageFactor: number;
  /** Path to SQLite database (default: ~/.claude/codememory.db) */
  databasePath: string;
  /** File storage path for large files (default: ~/.claude/codememory-files) */
  filesPath: string;
  /** Glob patterns for session keys to exclude from CodeMemory storage */
  ignoreSessionPatterns: string[];
  /** Glob patterns for session keys that can read but not write to CodeMemory */
  statelessSessionPatterns: string[];
  /** Whether to skip stateless sessions for writes */
  skipStatelessSessions: boolean;
  /** Model override for CodeMemory summarization */
  summaryModel?: string;
  /** Provider override for CodeMemory summarization */
  summaryProvider?: string;
  /** Model override for codememory_expand_query sub-agent */
  expansionModel?: string;
  /** Provider override for codememory_expand_query sub-agent */
  expansionProvider?: string;
  /** Max tokens for expansion query answer */
  maxExpandQueryTokens: number;
  /** Token cap for codememory_expand operations */
  maxExpandTokens: number;
  /** Timeout for delegated expansion queries (ms) */
  delegationTimeoutMs: number;
  /** Circuit breaker cooldown time in milliseconds */
  circuitBreakerCooldownMs: number;
  /** Number of consecutive failures to trigger circuit breaker */
  circuitBreakerThreshold: number;
  /** Whether to prune HEARTBEAT_OK messages */
  pruneHeartbeatOk: boolean;
  /** Maximum token budget for context assembly */
  maxAssemblyTokenBudget: number;
  /** Whether the CodeMemory plugin is enabled */
  enabled: boolean;
  /** Whether low-level grep/describe/expand debug tools are exposed to the model. */
  debugToolsEnabled: boolean;
  /** Whether the optional LLM query planner can run after a weak fast-path retrieval. */
  queryPlannerEnabled: boolean;
  /** Model override for query planner calls. */
  queryPlannerModel?: string;
  /** Timeout for query planner calls (ms). */
  queryPlannerTimeoutMs: number;
  /** Max tokens requested from the query planner. */
  queryPlannerMaxTokens: number;
  /** Whether automatic token-threshold compaction is enabled (default true) */
  compactionEnabled: boolean;
  /** Uncompacted M/L-tier token sum that triggers async compaction (default 30000) */
  compactionTokenThreshold: number;
  /** Number of most-recent uncompacted messages to preserve as "fresh tail" (default 20) */
  compactionFreshTailCount: number;
  /** Model used for LLM-based summarization (default: claude-haiku-4-5-20251001) */
  compactionModel: string;
  /** Max characters of message content fed to `claude --print` per batch (default 24000 ≈ 6k tokens) */
  compactionMaxInputChars: number;
  /** If true, skip the LLM call and use the truncation fallback. Useful in
   * offline or test environments where spawning `claude --print` would hang. */
  compactionDisableLlm: boolean;
  /**
   * Window during which a repeat exploration (Read/Grep/Glob of the same
   * target) is deduped to N. Default 30 min — past this the file may have
   * changed, so re-reads are legitimate signal again.
   */
  exploredTargetWindowMs: number;
  /** Workspace root path used to qualify file tag values across repos. Defaults to process.cwd(). */
  workspaceRoot: string;
  /**
   * If true, when a new decision is marked without an explicit
   * `supersedesNodeId`, run a single haiku call against the active
   * decisions in the *same conversation* to detect any that the new
   * decision overrides, then auto-supersede them. Default false —
   * relies on the model passing `supersedesNodeId` itself.
   * Same-conversation only; cross-session is never auto-handled.
   */
  autoSupersedeViaLlm: boolean;
  /** Model used by the auto-supersede judge (default: claude-haiku-4-5-20251001). */
  autoSupersedeModel: string;
  /** Max active decisions in the conversation considered by the judge per call (default 20). */
  autoSupersedeMaxCandidates: number;
  /** Timeout for the judge LLM call in milliseconds (default 8000). */
  autoSupersedeTimeoutMs: number;
}

const DEFAULT_DB_PATH = join(homedir(), ".claude", "codememory.db");
const DEFAULT_FILES_PATH = join(homedir(), ".claude", "codememory-files");

/**
 * Resolve CodeMemory configuration from environment variables and defaults.
 */
export function resolveCodeMemoryConfig(env: NodeJS.ProcessEnv = process.env): CodeMemoryConfig {
  return {
    contextThreshold: parseFloat(env.CODEMEMORY_CONTEXT_THRESHOLD || "0.75"),
    freshTailCount: parseInt(env.CODEMEMORY_FRESH_TAIL_COUNT || "64"),
    leafMinFanout: parseInt(env.CODEMEMORY_LEAF_MIN_FANOUT || "8"),
    condensedMinFanout: parseInt(env.CODEMEMORY_CONDENSED_MIN_FANOUT || "4"),
    condensedMinFanoutHard: parseInt(env.CODEMEMORY_CONDENSED_MIN_FANOUT_HARD || "2"),
    incrementalMaxDepth: parseInt(env.CODEMEMORY_INCREMENTAL_MAX_DEPTH || "1"),
    leafChunkTokens: env.CODEMEMORY_LEAF_CHUNK_TOKENS ? parseInt(env.CODEMEMORY_LEAF_CHUNK_TOKENS) : undefined,
    leafTargetTokens: parseInt(env.CODEMEMORY_LEAF_TARGET_TOKENS || "1200"),
    condensedTargetTokens: parseInt(env.CODEMEMORY_CONDENSED_TARGET_TOKENS || "2000"),
    maxRounds: parseInt(env.CODEMEMORY_MAX_ROUNDS || "10"),
    timezone: env.CODEMEMORY_TIMEZONE || "UTC",
    summaryMaxOverageFactor: parseFloat(env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR || "3"),
    databasePath: env.CODEMEMORY_DATABASE_PATH || DEFAULT_DB_PATH,
    filesPath: env.CODEMEMORY_FILES_PATH || DEFAULT_FILES_PATH,
    ignoreSessionPatterns: parsePatternList(env.CODEMEMORY_IGNORE_SESSION_PATTERNS),
    statelessSessionPatterns: parsePatternList(env.CODEMEMORY_STATELESS_SESSION_PATTERNS),
    skipStatelessSessions: env.CODEMEMORY_SKIP_STATELESS_SESSIONS !== "false",
    summaryModel: env.CODEMEMORY_SUMMARY_MODEL,
    summaryProvider: env.CODEMEMORY_SUMMARY_PROVIDER,
    expansionModel: env.CODEMEMORY_EXPANSION_MODEL,
    expansionProvider: env.CODEMEMORY_EXPANSION_PROVIDER,
    maxExpandQueryTokens: parseInt(env.CODEMEMORY_MAX_EXPAND_QUERY_TOKENS || "2000"),
    maxExpandTokens: parseInt(env.CODEMEMORY_MAX_EXPAND_TOKENS || "4000"),
    delegationTimeoutMs: parseInt(env.CODEMEMORY_DELEGATION_TIMEOUT_MS || "120000"),
    circuitBreakerCooldownMs: parseInt(env.CODEMEMORY_CIRCUIT_BREAKER_COOLDOWN_MS || "300000"),
    circuitBreakerThreshold: parseInt(env.CODEMEMORY_CIRCUIT_BREAKER_THRESHOLD || "5"),
    pruneHeartbeatOk: env.CODEMEMORY_PRUNE_HEARTBEAT_OK === "true",
    maxAssemblyTokenBudget: parseInt(env.CODEMEMORY_MAX_ASSEMBLY_TOKEN_BUDGET || "0"),
    enabled: env.CODEMEMORY_ENABLED !== "false",
    debugToolsEnabled: env.CODEMEMORY_DEBUG_TOOLS_ENABLED === "true",
    queryPlannerEnabled: env.CODEMEMORY_QUERY_PLANNER_ENABLED === "true",
    queryPlannerModel: env.CODEMEMORY_QUERY_PLANNER_MODEL || env.CODEMEMORY_EXPANSION_MODEL,
    queryPlannerTimeoutMs: parseInt(env.CODEMEMORY_QUERY_PLANNER_TIMEOUT_MS || "1200"),
    queryPlannerMaxTokens: parseInt(env.CODEMEMORY_QUERY_PLANNER_MAX_TOKENS || "800"),
    compactionEnabled: env.CODEMEMORY_COMPACTION_ENABLED !== "false",
    compactionTokenThreshold: parseInt(env.CODEMEMORY_COMPACTION_TOKEN_THRESHOLD || "30000"),
    compactionFreshTailCount: parseInt(env.CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT || "20"),
    compactionModel: env.CODEMEMORY_COMPACTION_MODEL || "claude-haiku-4-5-20251001",
    compactionMaxInputChars: parseInt(env.CODEMEMORY_COMPACTION_MAX_INPUT_CHARS || "24000"),
    compactionDisableLlm: env.CODEMEMORY_COMPACTION_DISABLE_LLM === "true",
    exploredTargetWindowMs: parseInt(
      env.CODEMEMORY_EXPLORED_TARGET_WINDOW_MS || String(30 * 60 * 1000)
    ),
    workspaceRoot: env.CODEMEMORY_WORKSPACE_ROOT || process.cwd(),
    autoSupersedeViaLlm: env.CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM === "true",
    autoSupersedeModel:
      env.CODEMEMORY_AUTO_SUPERSEDE_MODEL || "claude-haiku-4-5-20251001",
    autoSupersedeMaxCandidates: parseInt(
      env.CODEMEMORY_AUTO_SUPERSEDE_MAX_CANDIDATES || "20"
    ),
    autoSupersedeTimeoutMs: parseInt(
      env.CODEMEMORY_AUTO_SUPERSEDE_TIMEOUT_MS || "8000"
    ),
  };
}

function parsePatternList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0);
}
