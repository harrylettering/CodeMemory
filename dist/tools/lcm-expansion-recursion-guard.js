/**
 * CodeMemory for Claude Code - Expansion Recursion Guard
 *
 * Recursion protection for expansion operations.
 */
const RECURSION_GUARD_STATE = Symbol.for("@martian-engineering/codememory/recursion-guard-state");
function getRecursionGuardState() {
    const globalState = globalThis;
    if (!globalState[RECURSION_GUARD_STATE]) {
        globalState[RECURSION_GUARD_STATE] = {
            stack: [],
            visited: new Set(),
            maxDepth: 10,
            maxRecursions: 3,
        };
    }
    return globalState[RECURSION_GUARD_STATE];
}
export class LcmExpansionRecursionGuard {
    state;
    constructor() {
        this.state = getRecursionGuardState();
    }
    enter(summaryId, depth) {
        // Check max depth
        if (depth > this.state.maxDepth) {
            return {
                allowed: false,
                reason: `Max depth ${this.state.maxDepth} exceeded`,
            };
        }
        // Check recursions of same summary
        const recursions = this.state.stack.filter((s) => s.summaryId === summaryId).length;
        if (recursions >= this.state.maxRecursions) {
            return {
                allowed: false,
                reason: `Max recursions ${this.state.maxRecursions} exceeded for summary ${summaryId}`,
            };
        }
        // Check for cycles
        if (this.state.visited.has(summaryId)) {
            return {
                allowed: false,
                reason: `Cycle detected: summary ${summaryId} already visited in this traversal`,
            };
        }
        this.state.stack.push({
            summaryId,
            timestamp: Date.now(),
            depth,
        });
        this.state.visited.add(summaryId);
        return { allowed: true };
    }
    leave(summaryId) {
        const index = this.state.stack.findIndex((s) => s.summaryId === summaryId);
        if (index !== -1) {
            this.state.stack.splice(index, 1);
        }
        // Note: Don't clear from visited until full traversal completes
    }
    beginTraversal() {
        this.state.visited.clear();
    }
    endTraversal() {
        this.state.visited.clear();
        this.state.stack = [];
    }
    getCurrentDepth() {
        if (this.state.stack.length === 0) {
            return 0;
        }
        return this.state.stack[this.state.stack.length - 1].depth;
    }
    getStack() {
        return this.state.stack.map((s) => ({
            summaryId: s.summaryId,
            depth: s.depth,
        }));
    }
    /**
     * Wrap an expansion operation with recursion guard
     */
    async withGuard(summaryId, depth, operation) {
        const check = this.enter(summaryId, depth);
        if (!check.allowed) {
            return { allowed: false, reason: check.reason };
        }
        try {
            const result = await operation();
            return { result, allowed: true };
        }
        finally {
            this.leave(summaryId);
        }
    }
    /**
     * Reset guard state for testing
     */
    resetForTests() {
        this.state.stack = [];
        this.state.visited.clear();
    }
}
/**
 * Factory function for creating LcmExpansionRecursionGuard instances
 */
export function createExpansionRecursionGuard() {
    return new LcmExpansionRecursionGuard();
}
//# sourceMappingURL=lcm-expansion-recursion-guard.js.map