#!/usr/bin/env node
/**
 * NegExp CLI for the PreToolUse Bash hook (Phase 3) — cold-start fallback.
 *
 * Usage: retrieve-cli.ts <sessionId> <toolName> <toolInputJson>
 *
 * The hook prefers the daemon socket (much faster, see daemon.ts).
 * This CLI exists only as a fallback for when no daemon is running.
 */
import { resolveLcmConfig } from "../db/config.js";
import { createLcmDatabaseConnection } from "../db/connection.js";
import { createNegativeExperienceStore } from "./store.js";
import { createNegExpRetriever } from "./retriever.js";
import { lookupForPreToolUse } from "./lookup.js";
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
        console.error("Usage: retrieve-cli.ts <sessionId> <toolName> <toolInput>");
        process.exit(1);
    }
    try {
        const config = resolveLcmConfig();
        const db = await createLcmDatabaseConnection(config.databasePath);
        const store = createNegativeExperienceStore(db);
        const retriever = createNegExpRetriever(store);
        const toolInput = parseInputArg(rawToolInput);
        const response = await lookupForPreToolUse(retriever, toolName, toolInput);
        console.log(JSON.stringify(response));
    }
    catch (err) {
        console.error(`Error retrieving Negative Experiences: ${err}`);
        console.log(JSON.stringify({
            shouldInject: false,
            reason: "Internal error",
            experiences: [],
        }));
        process.exit(1);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=retrieve-cli.js.map