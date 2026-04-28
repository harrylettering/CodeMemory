#!/usr/bin/env node
/**
 * PreCompact hook entry point.
 *
 * Delegates to the unified compaction pipeline (same one used by
 * SessionEnd and the `lcm_compact` tool) and emits a single JSON line
 * describing the outcome. `pre-compact.sh` reads the output; anything
 * other than valid JSON → the hook's ERR trap emits a noop.
 */
import { runCompactionForSession } from "../../compaction/run-for-session.js";
async function main() {
    const sessionId = process.argv[2] || "unknown";
    const result = await runCompactionForSession(sessionId);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
}
main().catch((err) => {
    process.stderr.write(`[lcm] run-compaction fatal: ${err}\n`);
    process.stdout.write(JSON.stringify({
        ok: false,
        actionTaken: false,
        tokensBefore: 0,
        tokensAfter: 0,
        condensed: false,
        reason: "fatal",
    }) + "\n");
    process.exit(0);
});
//# sourceMappingURL=run-compaction.js.map