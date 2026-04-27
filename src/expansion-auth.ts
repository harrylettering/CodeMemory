/**
 * CodeMemory for Claude Code - Expansion Authorization
 *
 * Delegation grant system for subagent expansion with token caps and TTL management.
 *
 * Exactly matches CodeMemory's expansion authorization system.
 */

import type { CodeMemoryDependencies } from "./types.js";

export interface ExpansionAuthParams {
  /** Original grant identifier */
  grantId?: string;

  /** Max depth allowed by this grant */
  maxDepth: number;

  /** Max total tokens allowed by this grant */
  tokenCap: number;

  /** TTL in milliseconds */
  ttl: number;

  /** Runtime context metadata */
  runtimeContext?: Record<string, unknown>;
}

export interface ExpansionAuthResult {
  /** Grant identifier */
  grantId: string;

  /** Remaining tokens */
  remainingTokens: number;

  /** Remaining depth */
  remainingDepth: number;

  /** Expiry time */
  expiresAt: number;

  /** Whether this is a root grant */
  root: boolean;
}

export interface ExpansionAuth {
  /** Create a new expansion grant */
  createGrant(input: ExpansionAuthParams): Promise<ExpansionAuthResult>;

  /** Check if a grant is valid */
  isValid(grantId: string): Promise<boolean>;

  /** Consume tokens from a grant */
  consumeTokens(grantId: string, amount: number): Promise<{
    success: boolean;
    remaining: number;
    expired: boolean;
  }>;

  /** Increment depth for a grant */
  incrementDepth(grantId: string): Promise<{
    success: boolean;
    remaining: number;
    expired: boolean;
  }>;

  /** Get current grant state */
  getGrant(grantId: string): Promise<ExpansionAuthResult | null>;
}

/**
 * Simple in-memory implementation of ExpansionAuth
 */
export class MemoryExpansionAuth implements ExpansionAuth {
  private grants = new Map<string, {
    remainingTokens: number;
    remainingDepth: number;
    expiresAt: number;
    root: boolean;
  }>();

  constructor(private deps: CodeMemoryDependencies) {}

  async createGrant(input: ExpansionAuthParams): Promise<ExpansionAuthResult> {
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

  async isValid(grantId: string): Promise<boolean> {
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

  async consumeTokens(grantId: string, amount: number): Promise<{
    success: boolean;
    remaining: number;
    expired: boolean;
  }> {
    if (!await this.isValid(grantId)) {
      return { success: false, remaining: 0, expired: true };
    }

    const grant = this.grants.get(grantId)!;

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

  async incrementDepth(grantId: string): Promise<{
    success: boolean;
    remaining: number;
    expired: boolean;
  }> {
    if (!await this.isValid(grantId)) {
      return { success: false, remaining: 0, expired: true };
    }

    const grant = this.grants.get(grantId)!;

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

  async getGrant(grantId: string): Promise<ExpansionAuthResult | null> {
    if (!await this.isValid(grantId)) {
      return null;
    }

    const grant = this.grants.get(grantId)!;

    return {
      grantId,
      remainingTokens: grant.remainingTokens,
      remainingDepth: grant.remainingDepth,
      expiresAt: grant.expiresAt,
      root: grant.root,
    };
  }

  private generateGrantId(): string {
    return `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Cleanup expired grants
   */
  async cleanupExpiredGrants(): Promise<number> {
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
export function createExpansionAuth(deps: CodeMemoryDependencies): ExpansionAuth {
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
