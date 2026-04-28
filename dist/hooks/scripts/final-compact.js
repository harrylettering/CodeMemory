#!/usr/bin/env node
/**
 * SessionEnd hook entry point. Identical pipeline to PreCompact and
 * `lcm_compact` — see `run-for-session.ts`.
 */
import { runCompactionForSession } from "../../compaction/run-for-session.js";
async function main() {
    const sessionId = process.argv[2] || "unknown";
    const result = await runCompactionForSession(sessionId);
    if (result.ok && result.actionTaken) {
        console.error(`[lcm] Final compaction: saved ${result.tokensBefore - result.tokensAfter} tokens (sessionId=${sessionId})`);
    }
    else if (result.ok) {
        console.error(`[lcm] Final compaction: no-op (sessionId=${sessionId}, tokensBefore=${result.tokensBefore})`);
    }
    else {
        console.error(`[lcm] Final compaction: error (${result.reason ?? "unknown"})`);
    }
    process.exit(0);
}
main().catch((err) => {
    process.stderr.write(`[lcm] final-compact fatal: ${err}\n`);
    process.exit(0);
});
//# sourceMappingURL=final-compact.js.map