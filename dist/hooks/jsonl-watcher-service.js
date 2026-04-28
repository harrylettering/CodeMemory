/**
 * Lossless Claw - JSONL Watcher Service
 *
 * Standalone service that watches ~/.claude/projects/ for JSONL files.
 * This runs alongside the Claude Code hooks for backfill and recovery.
 */
import { createJsonlWatcher } from "./jsonl-watcher.js";
import { resolveLcmConfig } from "../db/config.js";
import { createLcmDatabaseConnection } from "../db/connection.js";
import { ConversationStore } from "../store/conversation-store.js";
// Create a simple logger
const logger = {
    debug: (...args) => console.error("[lcm-watcher]", ...args),
    info: (...args) => console.error("[lcm-watcher]", ...args),
    warn: (...args) => console.error("[lcm-watcher]", ...args),
    error: (...args) => console.error("[lcm-watcher]", ...args),
};
let watcherInstance = null;
export async function startJsonlWatcher() {
    if (watcherInstance) {
        logger.warn("Watcher already running");
        return;
    }
    const config = resolveLcmConfig();
    const db = await createLcmDatabaseConnection(config.databasePath);
    const conversationStore = new ConversationStore(db);
    watcherInstance = createJsonlWatcher(logger, {
        pollInterval: 5000,
    });
    // Set up event handlers
    watcherInstance.on("create", async (event) => {
        logger.info(`New session file: ${event.filePath}`);
        try {
            const messages = await watcherInstance.readAllLines(event.filePath);
            logger.info(`Read ${messages.length} messages from ${event.filePath}`);
            // TODO: Ingest these messages
            // This would require getting/creating a conversation and inserting messages
        }
        catch (error) {
            logger.error(`Failed to ingest new file: ${error}`);
        }
    });
    watcherInstance.on("update", async (event) => {
        logger.debug(`Session file updated: ${event.filePath}`);
        try {
            const newMessages = await watcherInstance.readNewLines(event.filePath);
            if (newMessages.length > 0) {
                logger.info(`Read ${newMessages.length} new messages from ${event.filePath}`);
                // TODO: Ingest these new messages
            }
        }
        catch (error) {
            logger.error(`Failed to ingest updates: ${error}`);
        }
    });
    await watcherInstance.start();
    logger.info("JSONL watcher started");
}
export async function stopJsonlWatcher() {
    if (!watcherInstance) {
        logger.warn("Watcher not running");
        return;
    }
    watcherInstance.stop();
    watcherInstance = null;
    logger.info("JSONL watcher stopped");
}
export function isWatcherRunning() {
    return watcherInstance !== null;
}
// If run directly, start the watcher
if (import.meta.url === `file://${process.argv[1]}`) {
    startJsonlWatcher().catch((error) => {
        logger.error(`Failed to start watcher: ${error}`);
        process.exit(1);
    });
    // Handle shutdown
    process.on("SIGINT", async () => {
        logger.info("Shutting down...");
        await stopJsonlWatcher();
        process.exit(0);
    });
}
//# sourceMappingURL=jsonl-watcher-service.js.map