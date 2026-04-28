/**
 * Lossless Claw for Claude Code - Claude Code Bridge
 *
 * Adaptation layer for Claude Code API with session identification and mapping.
 *
 * Exactly matches Lossless Claw's Claude Code bridge implementation.
 */
import { createHookSystem } from "./hook-system.js";
export class LcmClaudeCodeBridge {
    deps;
    conversationStore;
    hookSystem;
    sessionMappings = new Map();
    bridgeActive = false;
    constructor(deps, conversationStore) {
        this.deps = deps;
        this.conversationStore = conversationStore;
        this.hookSystem = createHookSystem(deps);
    }
    /**
     * Start the bridge
     */
    async start() {
        this.bridgeActive = true;
        this.setupEventListeners();
        this.deps.log.debug("Claude Code bridge started");
    }
    /**
     * Stop the bridge
     */
    async stop() {
        this.bridgeActive = false;
        this.removeEventListeners();
        this.deps.log.debug("Claude Code bridge stopped");
    }
    /**
     * Setup event listeners for Claude Code events
     */
    setupEventListeners() {
        // TODO: Implement actual event listeners
        // This depends on Claude Code API capabilities
        // Example placeholder - listen for gateway events
        this.listenForGatewayEvents();
    }
    /**
     * Listen for gateway events
     */
    listenForGatewayEvents() {
        // TODO: Implement gateway event listener
    }
    /**
     * Remove all event listeners
     */
    removeEventListeners() {
        // TODO: Implement event listener removal
    }
    /**
     * Handle a raw Claude Code event
     */
    async handleClaudeCodeEvent(event) {
        if (!this.bridgeActive) {
            return;
        }
        try {
            switch (event.type) {
                case "session:start":
                    await this.handleSessionStart(event);
                    break;
                case "session:end":
                    await this.handleSessionEnd(event);
                    break;
                case "message:create":
                    await this.handleMessageCreate(event);
                    break;
                case "message:update":
                    await this.handleMessageUpdate(event);
                    break;
                case "tool:call":
                    await this.handleToolCall(event);
                    break;
                default:
                    this.deps.log.debug(`Unhandled event type: ${event.type}`);
            }
        }
        catch (error) {
            this.deps.log.error(`Error handling Claude Code event: ${error}`);
        }
    }
    /**
     * Handle session start event
     */
    async handleSessionStart(event) {
        const { sessionId, sessionKey } = event.context;
        if (sessionId) {
            this.deps.log.debug(`Session started: ${sessionId}`);
        }
    }
    /**
     * Handle session end event
     */
    async handleSessionEnd(event) {
        const { sessionId } = event.context;
        if (sessionId) {
            this.deps.log.debug(`Session ended: ${sessionId}`);
        }
    }
    /**
     * Handle message creation
     */
    async handleMessageCreate(event) {
        // TODO: Implement message creation handling
    }
    /**
     * Handle message update
     */
    async handleMessageUpdate(event) {
        // TODO: Implement message update handling
    }
    /**
     * Handle tool call event
     */
    async handleToolCall(event) {
        // TODO: Implement tool call handling
    }
    /**
     * Get or create conversation mapping
     */
    async getConversationMapping(sessionId, sessionKey) {
        // Try to find existing mapping
        if (sessionId && this.sessionMappings.has(sessionId)) {
            return this.sessionMappings.get(sessionId);
        }
        if (sessionKey && this.sessionMappings.has(sessionKey)) {
            return this.sessionMappings.get(sessionKey);
        }
        // No existing mapping - try to find or create conversation through conversation store
        try {
            const conversation = await this.findOrCreateConversation(sessionId, sessionKey);
            if (conversation) {
                const mapping = await this.createSessionMapping({
                    sessionId,
                    sessionKey,
                    conversationId: conversation.conversationId,
                });
                return mapping;
            }
        }
        catch (error) {
            this.deps.log.error(`Failed to get conversation mapping: ${error}`);
        }
        return null;
    }
    /**
     * Create a new session mapping
     */
    async createSessionMapping(params) {
        const mapping = {
            sessionId: params.sessionId || this.generateSessionId(),
            sessionKey: params.sessionKey,
            conversationId: params.conversationId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.sessionMappings.set(mapping.sessionId, mapping);
        if (mapping.sessionKey) {
            this.sessionMappings.set(mapping.sessionKey, mapping);
        }
        return mapping;
    }
    /**
     * Find or create conversation using conversation store
     */
    async findOrCreateConversation(sessionId, sessionKey) {
        if (!this.conversationStore) {
            this.deps.log.warn("Conversation store not available - cannot create conversation mapping");
            return null;
        }
        try {
            // Try to find existing conversation
            if (sessionId || sessionKey) {
                const conversation = await this.conversationStore.getConversationForSession({
                    sessionId,
                    sessionKey,
                });
                if (conversation) {
                    return conversation;
                }
                // No existing conversation - create new one if we have at least one identifier
                if (sessionId || sessionKey) {
                    return await this.conversationStore.getOrCreateConversation({
                        sessionId,
                        sessionKey,
                    });
                }
            }
        }
        catch (error) {
            this.deps.log.error(`Failed to find or create conversation: ${error}`);
        }
        return null;
    }
    generateSessionId() {
        return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    }
    /**
     * Get hook system for external integration
     */
    getHookSystem() {
        return this.hookSystem;
    }
    /**
     * Is bridge active
     */
    isActive() {
        return this.bridgeActive;
    }
    /**
     * Get active session count
     */
    getActiveSessionCount() {
        // Count unique conversationIds
        const uniqueConversations = new Set();
        for (const mapping of this.sessionMappings.values()) {
            uniqueConversations.add(mapping.conversationId.toString());
        }
        return uniqueConversations.size;
    }
    /**
     * For testing purposes only - reset all mappings
     */
    resetForTests() {
        this.sessionMappings.clear();
    }
}
export function createClaudeCodeBridge(deps, conversationStore) {
    return new LcmClaudeCodeBridge(deps, conversationStore);
}
//# sourceMappingURL=claude-code-bridge.js.map