/**
 * Unified compaction entry point for all three triggers:
 *   - PreCompact hook       → src/hooks/scripts/run-compaction.ts
 *   - SessionEnd hook       → src/hooks/scripts/final-compact.ts
 *   - Explicit (lcm_compact) → src/tools/lcm-compact-tool.ts (via engine.compact directly)
 *
 * All three used to diverge: PreCompact called the stub `engine.afterTurn`
 * plus an empty assembler, SessionEnd called the same stub, and only the
 * MCP tool reached `engine.compact`. That meant two of the three hooks were
 * effectively no-ops. This function collapses them onto one code path by
 * bootstrapping a throwaway engine and delegating to `engine.compact`.
 */
import { resolveLcmConfig } from "../db/config.js";
import { createLcmDatabaseConnection } from "../db/connection.js";
import { LcmContextEngine } from "../engine.js";
const defaultLogger = {
    debug: (...args) => console.error("[lcm]", ...args),
    info: (...args) => console.error("[lcm]", ...args),
    warn: (...args) => console.error("[lcm]", ...args),
    error: (...args) => console.error("[lcm]", ...args),
};
/**
 * Bootstrap an engine, run compaction for a session, tear down.
 * Never throws — failures return `{ok: false, reason}` so callers (hooks)
 * can emit a safe noop.
 */
export async function runCompactionForSession(sessionId, logger = defaultLogger) {
    if (!sessionId || sessionId === "unknown") {
        return {
            ok: false,
            actionTaken: false,
            tokensBefore: 0,
            tokensAfter: 0,
            condensed: false,
            reason: "No sessionId provided",
        };
    }
    let db;
    try {
        const config = resolveLcmConfig();
        db = await createLcmDatabaseConnection(config.databasePath);
        const deps = {
            log: logger,
            config,
            complete: async () => ({
                text: "",
                reasoning: "",
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
            callGateway: async () => ({}),
            agentLaneSubagent: "default",
            buildSubagentSystemPrompt: () => "",
            readLatestAssistantReply: () => "",
        };
        const engine = new LcmContextEngine({ db, config, deps: deps });
        const result = await engine.compact({ sessionId });
        return { ok: true, ...result };
    }
    catch (err) {
        logger.error(`[lcm] runCompactionForSession failed: ${err}`);
        return {
            ok: false,
            actionTaken: false,
            tokensBefore: 0,
            tokensAfter: 0,
            condensed: false,
            reason: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        if (db) {
            try {
                await db.close();
            }
            catch {
                /* ignore */
            }
        }
    }
}
//# sourceMappingURL=run-for-session.js.map