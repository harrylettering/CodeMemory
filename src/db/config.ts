/**
 * CodeMemory for Claude Code - Configuration Management
 *
 * Configuration priority:
 * 1. Environment variables (CODEMEMORY_* format)
 * 2. Default values
 *
 * Only fields actually consumed by the runtime are declared here. Knobs that
 * existed historically but have no current consumer were removed in 0.2.0;
 * see docs/CONFIGURATION.md for the live surface.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The four CODEMEMORY_*_MODEL knobs are unset by default, and unset means no
 * `--model` argument: the spawned `claude --print` uses whatever model the
 * host is configured for. Pinning a default here silently overrode that
 * choice, and a pinned id also rots -- it names one specific release that
 * will eventually stop being the right answer.
 *
 * Set an individual knob to pin that one call site.
 */

export interface CodeMemoryConfig {
  /** Minimum number of depth>=1 summaries needed for condensation. */
  condensedMinFanout: number;
  /** Incremental depth passes to run after each leaf compaction (default 1). */
  incrementalMaxDepth: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Target tokens for leaf summaries (default 1200) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 2000) */
  condensedTargetTokens: number;
  /** Maximum allowed overage factor for summaries relative to target tokens (default 3). */
  summaryMaxOverageFactor: number;
  /** Path to SQLite database (default: ~/.claude/codememory.db) */
  databasePath: string;
  /** Model for the codememory_expand_query sub-agent. Unset = host default. */
  expansionModel?: string;
  /** Provider override for codememory_expand_query sub-agent */
  expansionProvider?: string;
  /** Token cap for codememory_expand operations */
  maxExpandTokens: number;
  /** Timeout for delegated expansion queries (ms) */
  delegationTimeoutMs: number;
  /** Maximum token budget for context assembly */
  maxAssemblyTokenBudget: number;
  /** Whether the CodeMemory plugin is enabled */
  enabled: boolean;
  /** Whether low-level grep/describe/expand debug tools are exposed to the model. */
  debugToolsEnabled: boolean;
  /** Whether the optional LLM query planner can run after a weak fast-path retrieval. */
  queryPlannerEnabled: boolean;
  /** Model for query planner calls. Unset = host default. */
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
  /** Model for LLM-based summarization. Unset = host default. */
  compactionModel?: string;
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
  /**
   * Milliseconds of inactivity after which a daemon exits on its own. 0
   * disables it. SessionEnd is not a reliable teardown signal, so without
   * this a daemon outlives its session until the machine is rebooted.
   */
  daemonIdleTimeoutMs: number;
  /**
   * Days after which an untouched active task stops being treated as current.
   * A task has no terminal state of its own, so without this it is recalled
   * as the current goal forever.
   */
  activeTaskStaleDays: number;
  autoSupersedeViaLlm: boolean;
  /** Model for the auto-supersede judge. Unset = host default. */
  autoSupersedeModel?: string;
  /** Max active decisions in the conversation considered by the judge per call (default 20). */
  autoSupersedeMaxCandidates: number;
  /** Timeout for the judge LLM call in milliseconds (default 8000). */
  autoSupersedeTimeoutMs: number;
}

const DEFAULT_DB_PATH = join(homedir(), ".claude", "codememory.db");

/**
 * Resolve CodeMemory configuration from environment variables and defaults.
 */
export function resolveCodeMemoryConfig(env: NodeJS.ProcessEnv = process.env): CodeMemoryConfig {
  return {
    condensedMinFanout: parseInt(env.CODEMEMORY_CONDENSED_MIN_FANOUT || "4"),
    incrementalMaxDepth: parseInt(env.CODEMEMORY_INCREMENTAL_MAX_DEPTH || "1"),
    leafChunkTokens: env.CODEMEMORY_LEAF_CHUNK_TOKENS ? parseInt(env.CODEMEMORY_LEAF_CHUNK_TOKENS) : undefined,
    leafTargetTokens: parseInt(env.CODEMEMORY_LEAF_TARGET_TOKENS || "1200"),
    condensedTargetTokens: parseInt(env.CODEMEMORY_CONDENSED_TARGET_TOKENS || "2000"),
    summaryMaxOverageFactor: parseFloat(env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR || "3"),
    databasePath: env.CODEMEMORY_DATABASE_PATH || DEFAULT_DB_PATH,
    expansionModel: env.CODEMEMORY_EXPANSION_MODEL || undefined,
    expansionProvider: env.CODEMEMORY_EXPANSION_PROVIDER,
    maxExpandTokens: parseInt(env.CODEMEMORY_MAX_EXPAND_TOKENS || "4000"),
    delegationTimeoutMs: parseInt(env.CODEMEMORY_DELEGATION_TIMEOUT_MS || "120000"),
    maxAssemblyTokenBudget: parseInt(env.CODEMEMORY_MAX_ASSEMBLY_TOKEN_BUDGET || "0"),
    enabled: env.CODEMEMORY_ENABLED !== "false",
    debugToolsEnabled: env.CODEMEMORY_DEBUG_TOOLS_ENABLED === "true",
    queryPlannerEnabled: env.CODEMEMORY_QUERY_PLANNER_ENABLED === "true",
    queryPlannerModel: env.CODEMEMORY_QUERY_PLANNER_MODEL || undefined,
    queryPlannerTimeoutMs: parseInt(env.CODEMEMORY_QUERY_PLANNER_TIMEOUT_MS || "1200"),
    queryPlannerMaxTokens: parseInt(env.CODEMEMORY_QUERY_PLANNER_MAX_TOKENS || "800"),
    compactionEnabled: env.CODEMEMORY_COMPACTION_ENABLED !== "false",
    compactionTokenThreshold: parseInt(env.CODEMEMORY_COMPACTION_TOKEN_THRESHOLD || "30000"),
    compactionFreshTailCount: parseInt(env.CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT || "20"),
    compactionModel: env.CODEMEMORY_COMPACTION_MODEL || undefined,
    compactionMaxInputChars: parseInt(env.CODEMEMORY_COMPACTION_MAX_INPUT_CHARS || "24000"),
    compactionDisableLlm: env.CODEMEMORY_COMPACTION_DISABLE_LLM === "true",
    exploredTargetWindowMs: parseInt(
      env.CODEMEMORY_EXPLORED_TARGET_WINDOW_MS || String(30 * 60 * 1000)
    ),
    workspaceRoot: env.CODEMEMORY_WORKSPACE_ROOT || process.cwd(),
    daemonIdleTimeoutMs: parseInt(
      env.CODEMEMORY_DAEMON_IDLE_TIMEOUT_MS || String(30 * 60 * 1000)
    ),
    activeTaskStaleDays: parseInt(
      env.CODEMEMORY_ACTIVE_TASK_STALE_DAYS || "14"
    ),
    autoSupersedeViaLlm: env.CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM === "true",
    autoSupersedeModel: env.CODEMEMORY_AUTO_SUPERSEDE_MODEL || undefined,
    autoSupersedeMaxCandidates: parseInt(
      env.CODEMEMORY_AUTO_SUPERSEDE_MAX_CANDIDATES || "20"
    ),
    autoSupersedeTimeoutMs: parseInt(
      env.CODEMEMORY_AUTO_SUPERSEDE_TIMEOUT_MS || "8000"
    ),
  };
}
