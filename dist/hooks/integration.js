/**
 * Lossless Claw for Claude Code - Hook Integration
 *
 * Integrates all hook components together:
 * 1. JSONL Watcher - monitors ~/.claude/projects/*.jsonl
 * 2. Hook System - dispatches events
 * 3. Claude Code Bridge - manages sessions
 */
import { createJsonlWatcher } from "./jsonl-watcher.js";
import { createHookSystem } from "./hook-system.js";
import { createClaudeCodeBridge } from "./claude-code-bridge.js";
export class LcmHookIntegration {
    deps;
    engine;
    options;
    jsonlWatcher;
    hookSystem;
    claudeCodeBridge;
    isStarted = false;
    constructor(deps, engine, options = {}) {
        this.deps = deps;
        this.engine = engine;
        this.options = options;
        this.jsonlWatcher = createJsonlWatcher(deps, {
            pollInterval: options.pollInterval,
        });
        this.hookSystem = createHookSystem(deps);
        this.claudeCodeBridge = createClaudeCodeBridge(deps, engine.getConversationStore());
    }
    /**
     * Start the integration system
     */
    async start() {
        if (this.isStarted) {
            this.deps.log.warn("Hook integration already started");
            return;
        }
        this.deps.log.debug("Starting LCM hook integration...");
        this.setupHookConnections();
        await this.jsonlWatcher.start();
        await this.claudeCodeBridge.start();
        this.isStarted = true;
        this.deps.log.info("LCM hook integration started successfully");
    }
    /**
     * Setup connections between hook components
     */
    setupHookConnections() {
        // Connect JSONL watcher events to hook system
        this.jsonlWatcher.on("create", async (event) => {
            this.deps.log.debug(`JSONL file created: ${event.filePath}`);
            if (this.options.autoIngest) {
                await this.handleNewSessionFile(event.filePath);
            }
        });
        this.jsonlWatcher.on("update", async (event) => {
            this.deps.log.debug(`JSONL file updated: ${event.filePath}`);
            if (this.options.autoIngest) {
                await this.handleSessionFileUpdate(event.filePath);
            }
        });
        // Connect hook system events to engine
        this.hookSystem.on("bootstrap", async (event) => {
            this.deps.log.debug(`Bootstrap event: ${JSON.stringify(event.data)}`);
        });
        this.hookSystem.on("ingest", async (event) => {
            this.deps.log.debug(`Ingest event: ${JSON.stringify(event.data)}`);
        });
        this.hookSystem.on("afterTurn", async (event) => {
            this.deps.log.debug(`After turn event: ${JSON.stringify(event.data)}`);
            if (this.options.autoCompact) {
                const data = event.data;
                await this.engine.compact({
                    sessionId: data.sessionId,
                    sessionKey: data.sessionKey,
                    sessionFile: data.sessionFile,
                    tokenBudget: data.tokenBudget,
                    currentTokenCount: data.messages?.length * 100,
                });
            }
        });
    }
    /**
     * Handle a new session file being created
     */
    async handleNewSessionFile(filePath) {
        try {
            const messages = await this.jsonlWatcher.readAllLines(filePath);
            if (messages.length === 0) {
                return;
            }
            this.deps.log.info(`Found new session file: ${filePath} (${messages.length} messages)`);
            await this.hookSystem.dispatchBootstrap({
                sessionId: "unknown",
                sessionFile: filePath,
                result: {
                    bootstrapped: true,
                    importedMessages: messages.length,
                },
            });
        }
        catch (error) {
            this.deps.log.error(`Failed to handle new session file: ${error}`);
        }
    }
    /**
     * Handle a session file being updated
     */
    async handleSessionFileUpdate(filePath) {
        try {
            const newMessages = await this.jsonlWatcher.readNewLines(filePath);
            if (newMessages.length === 0) {
                return;
            }
            this.deps.log.debug(`Session file updated: ${filePath} (${newMessages.length} new messages)`);
            for (const msg of newMessages) {
                await this.hookSystem.dispatchIngest({
                    sessionId: "unknown",
                    message: msg,
                    result: { ingested: true },
                });
            }
        }
        catch (error) {
            this.deps.log.error(`Failed to handle session file update: ${error}`);
        }
    }
    /**
     * Stop the integration system
     */
    async stop() {
        if (!this.isStarted) {
            return;
        }
        this.deps.log.debug("Stopping LCM hook integration...");
        this.jsonlWatcher.stop();
        await this.claudeCodeBridge.stop();
        this.isStarted = false;
        this.deps.log.info("LCM hook integration stopped");
    }
    /**
     * Get hook system for external access
     */
    getHookSystem() {
        return this.hookSystem;
    }
    /**
     * Get JSONL watcher for external access
     */
    getJsonlWatcher() {
        return this.jsonlWatcher;
    }
    /**
     * Get Claude Code bridge for external access
     */
    getClaudeCodeBridge() {
        return this.claudeCodeBridge;
    }
    /**
     * Is integration system running?
     */
    isRunning() {
        return this.isStarted;
    }
}
export function createHookIntegration(deps, engine, options = {}) {
    return new LcmHookIntegration(deps, engine, options);
}
//# sourceMappingURL=integration.js.map