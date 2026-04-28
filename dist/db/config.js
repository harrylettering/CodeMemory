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
export const DEFAULT_CODEMEMORY_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_DB_PATH = join(homedir(), ".claude", "codememory.db");
/**
 * Resolve CodeMemory configuration from environment variables and defaults.
 */
export function resolveCodeMemoryConfig(env = process.env) {
    return {
        condensedMinFanout: parseInt(env.CODEMEMORY_CONDENSED_MIN_FANOUT || "4"),
        incrementalMaxDepth: parseInt(env.CODEMEMORY_INCREMENTAL_MAX_DEPTH || "1"),
        leafChunkTokens: env.CODEMEMORY_LEAF_CHUNK_TOKENS ? parseInt(env.CODEMEMORY_LEAF_CHUNK_TOKENS) : undefined,
        leafTargetTokens: parseInt(env.CODEMEMORY_LEAF_TARGET_TOKENS || "1200"),
        condensedTargetTokens: parseInt(env.CODEMEMORY_CONDENSED_TARGET_TOKENS || "2000"),
        summaryMaxOverageFactor: parseFloat(env.CODEMEMORY_SUMMARY_MAX_OVERAGE_FACTOR || "3"),
        databasePath: env.CODEMEMORY_DATABASE_PATH || DEFAULT_DB_PATH,
        expansionModel: env.CODEMEMORY_EXPANSION_MODEL || DEFAULT_CODEMEMORY_MODEL,
        expansionProvider: env.CODEMEMORY_EXPANSION_PROVIDER,
        maxExpandTokens: parseInt(env.CODEMEMORY_MAX_EXPAND_TOKENS || "4000"),
        delegationTimeoutMs: parseInt(env.CODEMEMORY_DELEGATION_TIMEOUT_MS || "120000"),
        maxAssemblyTokenBudget: parseInt(env.CODEMEMORY_MAX_ASSEMBLY_TOKEN_BUDGET || "0"),
        enabled: env.CODEMEMORY_ENABLED !== "false",
        debugToolsEnabled: env.CODEMEMORY_DEBUG_TOOLS_ENABLED === "true",
        queryPlannerEnabled: env.CODEMEMORY_QUERY_PLANNER_ENABLED === "true",
        queryPlannerModel: env.CODEMEMORY_QUERY_PLANNER_MODEL || DEFAULT_CODEMEMORY_MODEL,
        queryPlannerTimeoutMs: parseInt(env.CODEMEMORY_QUERY_PLANNER_TIMEOUT_MS || "1200"),
        queryPlannerMaxTokens: parseInt(env.CODEMEMORY_QUERY_PLANNER_MAX_TOKENS || "800"),
        compactionEnabled: env.CODEMEMORY_COMPACTION_ENABLED !== "false",
        compactionTokenThreshold: parseInt(env.CODEMEMORY_COMPACTION_TOKEN_THRESHOLD || "30000"),
        compactionFreshTailCount: parseInt(env.CODEMEMORY_COMPACTION_FRESH_TAIL_COUNT || "20"),
        compactionModel: env.CODEMEMORY_COMPACTION_MODEL || DEFAULT_CODEMEMORY_MODEL,
        compactionMaxInputChars: parseInt(env.CODEMEMORY_COMPACTION_MAX_INPUT_CHARS || "24000"),
        compactionDisableLlm: env.CODEMEMORY_COMPACTION_DISABLE_LLM === "true",
        exploredTargetWindowMs: parseInt(env.CODEMEMORY_EXPLORED_TARGET_WINDOW_MS || String(30 * 60 * 1000)),
        workspaceRoot: env.CODEMEMORY_WORKSPACE_ROOT || process.cwd(),
        autoSupersedeViaLlm: env.CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM === "true",
        autoSupersedeModel: env.CODEMEMORY_AUTO_SUPERSEDE_MODEL || DEFAULT_CODEMEMORY_MODEL,
        autoSupersedeMaxCandidates: parseInt(env.CODEMEMORY_AUTO_SUPERSEDE_MAX_CANDIDATES || "20"),
        autoSupersedeTimeoutMs: parseInt(env.CODEMEMORY_AUTO_SUPERSEDE_TIMEOUT_MS || "8000"),
    };
}
//# sourceMappingURL=config.js.map