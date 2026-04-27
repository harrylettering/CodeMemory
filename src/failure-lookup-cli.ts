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

function parseInputArg(arg: string): any {
  try {
    return JSON.parse(arg);
  } catch {
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
    const response = await lookupForPreToolUse(memoryStore, toolName, toolInput);
    console.log(JSON.stringify(response));
  } catch (err) {
    console.error(`Error retrieving prior failures: ${err}`);
    console.log(
      JSON.stringify({
        shouldInject: false,
        reason: "Internal error",
        failures: [],
      })
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
