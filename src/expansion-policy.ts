/**
 * CodeMemory for Claude Code - Expansion Policy Engine
 *
 * Manages expansion depth and token policies with budget management.
 *
 * Exactly matches CodeMemory's expansion policy algorithm.
 */

import type { ExpandParams } from "./expansion.js";
import type { ExpansionAuthResult } from "./expansion-auth.js";
import { DEFAULT_EXPANSION_POLICY } from "./expansion-auth.js";

export interface ExpansionPolicy {
  /**
   * Determine allowed expansion parameters based on current state and budget
   */
  determineExpansionPolicy(params: {
    grant: ExpansionAuthResult | null;
    currentDepth: number;
    currentTokens: number;
    runtimeContext?: Record<string, unknown>;
  }): {
    allowedDepth: number;
    allowedTokens: number;
    shouldContinue: boolean;
  };

  /**
   * Check if expansion should be truncated
   */
  shouldTruncate(params: {
    estimatedTokens: number;
    availableTokens: number;
    currentDepth: number;
    maxDepth: number;
  }): boolean;

  /**
   * Calculate remaining budget
   */
  calculateRemainingBudget(params: {
    grant: ExpansionAuthResult | null;
    usedTokens: number;
    usedDepth: number;
  }): {
    remainingTokens: number;
    remainingDepth: number;
    hasTokens: boolean;
    hasDepth: boolean;
  };
}

/**
 * Token thresholds for different expansion levels
 */
const EXPANSION_LEVELS = {
  LEVEL_1: { maxDepth: 1, maxTokens: 1000 },
  LEVEL_2: { maxDepth: 2, maxTokens: 2000 },
  LEVEL_3: { maxDepth: 3, maxTokens: 4000 },
  LEVEL_4: { maxDepth: 4, maxTokens: 8000 },
};

export class CodeMemoryExpansionPolicy implements ExpansionPolicy {
  /**
   * Determine allowed expansion parameters based on current state and budget
   */
  determineExpansionPolicy(params: {
    grant: ExpansionAuthResult | null;
    currentDepth: number;
    currentTokens: number;
    runtimeContext?: Record<string, unknown>;
  }): {
    allowedDepth: number;
    allowedTokens: number;
    shouldContinue: boolean;
  } {
    const { grant, currentDepth, currentTokens, runtimeContext } = params;

    if (grant) {
      // Use grant limits
      const remainingDepth = grant.remainingDepth;
      const remainingTokens = grant.remainingTokens;

      if (remainingDepth <= 0 || remainingTokens <= 0) {
        return {
          allowedDepth: 0,
          allowedTokens: 0,
          shouldContinue: false,
        };
      }

      return {
        allowedDepth: remainingDepth,
        allowedTokens: remainingTokens,
        shouldContinue: true,
      };
    }

    // No grant - use default policy
    const levelKey = `LEVEL_${Math.min(currentDepth + 1, 4)}` as keyof typeof EXPANSION_LEVELS;
    const level = EXPANSION_LEVELS[levelKey];

    return {
      allowedDepth: level.maxDepth - currentDepth,
      allowedTokens: level.maxTokens - currentTokens,
      shouldContinue: true,
    };
  }

  /**
   * Check if expansion should be truncated
   */
  shouldTruncate(params: {
    estimatedTokens: number;
    availableTokens: number;
    currentDepth: number;
    maxDepth: number;
  }): boolean {
    const { estimatedTokens, availableTokens, currentDepth, maxDepth } = params;

    if (estimatedTokens > availableTokens) {
      return true;
    }

    if (currentDepth >= maxDepth) {
      return true;
    }

    return false;
  }

  /**
   * Calculate remaining budget
   */
  calculateRemainingBudget(params: {
    grant: ExpansionAuthResult | null;
    usedTokens: number;
    usedDepth: number;
  }): {
    remainingTokens: number;
    remainingDepth: number;
    hasTokens: boolean;
    hasDepth: boolean;
  } {
    const { grant, usedTokens, usedDepth } = params;

    if (grant) {
      const remainingTokens = Math.max(0, grant.remainingTokens - usedTokens);
      const remainingDepth = Math.max(0, grant.remainingDepth - usedDepth);

      return {
        remainingTokens,
        remainingDepth,
        hasTokens: remainingTokens > 0,
        hasDepth: remainingDepth > 0,
      };
    }

    // No grant - calculate based on default policy
    const usedLevel = Math.max(Math.floor(usedTokens / 1000), usedDepth);
    const nextLevelKey = `LEVEL_${Math.min(usedLevel + 1, 4)}` as keyof typeof EXPANSION_LEVELS;
    const nextLevel = EXPANSION_LEVELS[nextLevelKey];

    const remainingTokens = Math.max(0, nextLevel.maxTokens - usedTokens);
    const remainingDepth = Math.max(0, nextLevel.maxDepth - usedDepth);

    return {
      remainingTokens,
      remainingDepth,
      hasTokens: remainingTokens > 0,
      hasDepth: remainingDepth > 0,
    };
  }

  /**
   * Estimate token usage for different expansion strategies
   */
  estimateExpansionCost(input: {
    strategy: "shallow" | "deep" | "balanced";
    summaryCount: number;
    messageCount: number;
  }): number {
    const { strategy, summaryCount, messageCount } = input;

    const baseCost = summaryCount * 50;
    const messageCost = messageCount * 10;

    switch (strategy) {
      case "shallow":
        return baseCost * 0.8 + messageCost * 0.5;
      case "deep":
        return baseCost * 1.5 + messageCost * 1.2;
      case "balanced":
      default:
        return baseCost + messageCost;
    }
  }

  /**
   * Determine optimal expansion strategy based on budget
   */
  determineStrategy(budget: { tokens: number; depth: number }): "shallow" | "deep" | "balanced" {
    const { tokens, depth } = budget;

    if (tokens < 1000 || depth < 1) {
      return "shallow";
    }

    if (tokens > 5000 && depth > 3) {
      return "deep";
    }

    return "balanced";
  }
}

/**
 * Factory function for creating expansion policy instances
 */
export function createExpansionPolicy(): ExpansionPolicy {
  return new CodeMemoryExpansionPolicy();
}

/**
 * Calculate default expansion parameters
 */
export function calculateDefaultExpansionParams(summaryId: string): ExpandParams {
  return {
    summaryId,
    depth: DEFAULT_EXPANSION_POLICY.DEFAULT_MAX_DEPTH,
    includeMessages: true,
    tokenCap: DEFAULT_EXPANSION_POLICY.DEFAULT_TOKEN_CAP,
  };
}

/**
 * Check if an expansion exceeds safe limits
 */
export function exceedsSafeLimits(params: {
  estimatedTokens: number;
  maxDepth: number;
}): boolean {
  return (
    params.estimatedTokens > DEFAULT_EXPANSION_POLICY.MAX_EXPANSION_TOKENS ||
    params.maxDepth > 10
  );
}
