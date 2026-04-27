/**
 * CodeMemory for Claude Code - Expansion Recursion Guard
 *
 * Recursion protection for expansion operations.
 */

export interface RecursionGuardState {
  /** Stack of expansion operations */
  stack: Array<{
    summaryId: string;
    timestamp: number;
    depth: number;
  }>;

  /** Visited summary IDs in current traversal */
  visited: Set<string>;

  /** Max depth allowed */
  maxDepth: number;

  /** Max recursion count for same summary */
  maxRecursions: number;
}

const RECURSION_GUARD_STATE = Symbol.for(
  "@martian-engineering/codememory/recursion-guard-state",
);

function getRecursionGuardState(): RecursionGuardState {
  const globalState = globalThis as typeof globalThis & {
    [RECURSION_GUARD_STATE]?: RecursionGuardState;
  };

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

export class CodeMemoryExpansionRecursionGuard {
  private state: RecursionGuardState;

  constructor() {
    this.state = getRecursionGuardState();
  }

  enter(summaryId: string, depth: number): { allowed: boolean; reason?: string } {
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

  leave(summaryId: string): void {
    const index = this.state.stack.findIndex((s) => s.summaryId === summaryId);
    if (index !== -1) {
      this.state.stack.splice(index, 1);
    }
    // Note: Don't clear from visited until full traversal completes
  }

  beginTraversal(): void {
    this.state.visited.clear();
  }

  endTraversal(): void {
    this.state.visited.clear();
    this.state.stack = [];
  }

  getCurrentDepth(): number {
    if (this.state.stack.length === 0) {
      return 0;
    }
    return this.state.stack[this.state.stack.length - 1].depth;
  }

  getStack(): Array<{ summaryId: string; depth: number }> {
    return this.state.stack.map((s) => ({
      summaryId: s.summaryId,
      depth: s.depth,
    }));
  }

  /**
   * Wrap an expansion operation with recursion guard
   */
  async withGuard<T>(
    summaryId: string,
    depth: number,
    operation: () => Promise<T>
  ): Promise<{ result?: T; allowed: boolean; reason?: string }> {
    const check = this.enter(summaryId, depth);
    if (!check.allowed) {
      return { allowed: false, reason: check.reason };
    }

    try {
      const result = await operation();
      return { result, allowed: true };
    } finally {
      this.leave(summaryId);
    }
  }

  /**
   * Reset guard state for testing
   */
  resetForTests(): void {
    this.state.stack = [];
    this.state.visited.clear();
  }
}

/**
 * Factory function for creating CodeMemoryExpansionRecursionGuard instances
 */
export function createExpansionRecursionGuard(): CodeMemoryExpansionRecursionGuard {
  return new CodeMemoryExpansionRecursionGuard();
}
