/**
 * Lossless Claw for Claude Code - Hook System
 *
 * Event dispatcher for Claude Code actions with bootstrap/ingest/afterTurn hook points.
 *
 * Exactly matches Lossless Claw's hook system implementation.
 */
export class LcmHookSystem {
    deps;
    hooks = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Register a hook
     */
    on(type, callback) {
        if (!this.hooks.has(type)) {
            this.hooks.set(type, []);
        }
        this.hooks.get(type).push(callback);
        this.deps.log.debug(`Hook registered: ${type}`);
        return () => this.off(type, callback);
    }
    /**
     * Unregister a hook
     */
    off(type, callback) {
        const callbacks = this.hooks.get(type);
        if (callbacks) {
            const index = callbacks.indexOf(callback);
            if (index !== -1) {
                callbacks.splice(index, 1);
                this.deps.log.debug(`Hook unregistered: ${type}`);
            }
        }
    }
    /**
     * Dispatch an event
     */
    async dispatch(type, data) {
        const callbacks = this.hooks.get(type);
        if (!callbacks || callbacks.length === 0) {
            return;
        }
        const event = {
            type,
            timestamp: Date.now(),
            data,
        };
        this.deps.log.debug(`Dispatching hook event: ${type}`);
        // Run all callbacks in parallel with error handling
        const promises = callbacks.map(async (callback) => {
            try {
                await callback(event);
            }
            catch (error) {
                this.deps.log.error(`Hook callback error (${type}): ${error}`);
            }
        });
        await Promise.allSettled(promises);
    }
    /**
     * Dispatch bootstrap event
     */
    async dispatchBootstrap(data) {
        await this.dispatch("bootstrap", data);
    }
    /**
     * Dispatch ingest event
     */
    async dispatchIngest(data) {
        await this.dispatch("ingest", data);
    }
    /**
     * Dispatch ingest batch event
     */
    async dispatchIngestBatch(data) {
        await this.dispatch("ingestBatch", data);
    }
    /**
     * Dispatch after turn event
     */
    async dispatchAfterTurn(data) {
        await this.dispatch("afterTurn", data);
    }
    /**
     * Dispatch compact event
     */
    async dispatchCompact(data) {
        await this.dispatch("compact", data);
    }
    /**
     * Get active hook count for debugging
     */
    getHookCount(type) {
        if (!type) {
            return Array.from(this.hooks.values()).reduce((sum, callbacks) => sum + callbacks.length, 0);
        }
        const callbacks = this.hooks.get(type);
        return callbacks ? callbacks.length : 0;
    }
    /**
     * Reset all hooks (for testing)
     */
    reset() {
        this.hooks.clear();
    }
}
export function createHookSystem(deps) {
    return new LcmHookSystem(deps);
}
//# sourceMappingURL=hook-system.js.map