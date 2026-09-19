#!/usr/bin/env node
/**
 * Failure-lookup CLI for the PreToolUse Bash hook — cold-start fallback.
 *
 * Usage: failure-lookup-cli.js <sessionId> <toolName> <toolInputJson>
 *
 * The hook prefers the daemon socket (much faster, see daemon.ts).
 * This CLI exists only as a fallback for when no daemon is running.
 */
import { resolveCodeMemoryConfig } from "./db/config.js";
import { createCodeMemoryDatabaseConnection } from "./db/connection.js";
import { createMemoryNodeStore } from "./store/memory-store.js";
import { lookupForPreToolUse } from "./failure-lookup.js";
import { ConversationStore } from "./store/conversation-store.js";
function parseInputArg(arg) {
    try {
        return JSON.parse(arg);
    }
    catch {
        return arg;
    }
}
async function main() {
    const [sessionId, toolName, rawToolInput] = process.argv.slice(2);
    if (!sessionId || !toolName) {
        console.error("Usage: failure-lookup-cli.js <sessionId> <toolName> <toolInput>");
        process.exit(1);
    }
    try {
        const config = resolveCodeMemoryConfig();
        const db = await createCodeMemoryDatabaseConnection(config.databasePath);
        const memoryStore = createMemoryNodeStore(db);
        const toolInput = parseInputArg(rawToolInput);
        // The cold path receives only a session id, so it has to resolve the
        // conversation itself. Unresolved means no lookup rather than an unscoped
        // one -- the degraded path must not be the permissive one.
        const conversationStore = new ConversationStore(db);
        let conversationId;
        try {
            const conv = await conversationStore.getConversationForSession({ sessionId });
            conversationId = conv?.conversationId;
        }
        catch {
            /* no conversation for this session yet */
        }
        const response = await lookupForPreToolUse(memoryStore, toolName, toolInput, {
            conversationId,
        });
        // The cold path runs whenever the daemon is down, so leaving it
        // uninstrumented would make recall look worse than it is exactly when the
        // system is already degraded. Telemetry never blocks the tool call.
        try {
            await memoryStore.recordFailureLookup({
                sessionId,
                toolName,
                targetFile: response.diagnostics.targetFile,
                targetCommand: response.diagnostics.targetCommand,
                targetFileTag: response.diagnostics.targetFileTag,
                unresolvedConversation: response.diagnostics.unresolvedConversation,
                targetCommandTag: response.diagnostics.targetCommandTag,
                outcome: response.diagnostics.outcome,
                candidateCount: response.diagnostics.candidateCount,
                passedCount: response.diagnostics.passedCount,
                topScore: response.diagnostics.topScore,
                surfacedNodeIds: response.diagnostics.surfacedNodeIds,
                source: "cli",
            });
            if (response.shouldInject) {
                await memoryStore.markUsed(response.diagnostics.surfacedNodeIds);
            }
        }
        catch {
            // Measurement gap, not a user-visible failure.
        }
        console.log(JSON.stringify(response));
    }
    catch (err) {
        console.error(`Error retrieving prior failures: ${err}`);
        console.log(JSON.stringify({
            shouldInject: false,
            reason: "Internal error",
            failures: [],
        }));
        process.exit(1);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=failure-lookup-cli.js.map