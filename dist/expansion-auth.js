/**
 * CodeMemory for Claude Code - Expansion Authorization
 *
 * Delegation grant system for subagent expansion with token caps and TTL management.
 *
 * Exactly matches CodeMemory's expansion authorization system.
 */
/**
 * Simple in-memory implementation of ExpansionAuth
 */
export class MemoryExpansionAuth {
    deps;
    grants = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async createGrant(input) {
        const grantId = input.grantId || this.generateGrantId();
        this.grants.set(grantId, {
            remainingTokens: input.tokenCap,
            remainingDepth: input.maxDepth,
            expiresAt: Date.now() + input.ttl,
            root: true,
        });
        return {
            grantId,
            remainingTokens: input.tokenCap,
            remainingDepth: input.maxDepth,
            expiresAt: Date.now() + input.ttl,
            root: true,
        };
    }
    async isValid(grantId) {
        const grant = this.grants.get(grantId);
        if (!grant) {
            return false;
        }
        if (Date.now() > grant.expiresAt) {
            this.grants.delete(grantId);
            return false;
        }
        return true;
    }
    async consumeTokens(grantId, amount) {
        if (!await this.isValid(grantId)) {
            return { success: false, remaining: 0, expired: true };
        }
        const grant = this.grants.get(grantId);
        if (amount <= grant.remainingTokens) {
            grant.remainingTokens -= amount;
            return {
                success: true,
                remaining: grant.remainingTokens,
                expired: false,
            };
        }
        return {
            success: false,
            remaining: grant.remainingTokens,
            expired: false,
        };
    }
    async incrementDepth(grantId) {
        if (!await this.isValid(grantId)) {
            return { success: false, remaining: 0, expired: true };
        }
        const grant = this.grants.get(grantId);
        if (grant.remainingDepth > 0) {
            grant.remainingDepth -= 1;
            return {
                success: true,
                remaining: grant.remainingDepth,
                expired: false,
            };
        }
        return {
            success: false,
            remaining: 0,
            expired: false,
        };
    }
    async getGrant(grantId) {
        if (!await this.isValid(grantId)) {
            return null;
        }
        const grant = this.grants.get(grantId);
        return {
            grantId,
            remainingTokens: grant.remainingTokens,
            remainingDepth: grant.remainingDepth,
            expiresAt: grant.expiresAt,
            root: grant.root,
        };
    }
    generateGrantId() {
        return `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    /**
     * Cleanup expired grants
     */
    async cleanupExpiredGrants() {
        let count = 0;
        const now = Date.now();
        for (const [grantId, grant] of this.grants.entries()) {
            if (now > grant.expiresAt) {
                this.grants.delete(grantId);
                count++;
            }
        }
        return count;
    }
}
/**
 * Factory function for creating expansion auth instances
 */
export function createExpansionAuth(deps) {
    return new MemoryExpansionAuth(deps);
}
/**
 * Default expansion policy for Claude Code
 */
export const DEFAULT_EXPANSION_POLICY = {
    /** Default max depth for unauthenticated expansion */
    DEFAULT_MAX_DEPTH: 2,
    /** Default token cap for unauthenticated expansion */
    DEFAULT_TOKEN_CAP: 3000,
    /** TTL for expansion grants in milliseconds */
    GRANT_TTL: 5 * 60 * 1000, // 5 minutes
    /** Max tokens per single expansion */
    MAX_EXPANSION_TOKENS: 10000,
};
//# sourceMappingURL=expansion-auth.js.map