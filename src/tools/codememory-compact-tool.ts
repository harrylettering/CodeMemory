/**
 * codememory_compact - Manual compaction trigger.
 *
 * Allows users to explicitly trigger conversation compaction on demand,
 * in addition to the automatic PreCompact and SessionEnd triggers.
 * Compacts the conversation history to reduce token count while
 * maintaining full expandability via the summary DAG.
 */
import type { CodeMemoryContextEngine } from "../engine.js";
export interface CodeMemoryCompactParams {
  /** Optional sessionId to compact (defaults to current session). */
  sessionId?: string;
  /** Optional target token budget for compaction. */
  tokenBudget?: number;
}
export interface CodeMemoryCompactResult {
  ok: boolean;
  actionTaken: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  tokensSaved?: number;
  createdSummaryId?: string;
  level?: "leaf" | "condensed";
  reason?: string;
}
export class CodeMemoryCompactTool {
  constructor(
    private engine: CodeMemoryContextEngine,
    private getCurrentSessionId: () => string | undefined
  ) {}
  async compact(params: CodeMemoryCompactParams): Promise<CodeMemoryCompactResult> {
    const sessionId = params.sessionId || this.getCurrentSessionId();
    if (!sessionId) {
      return {
        ok: false,
        actionTaken: false,
        reason: "No active sessionId — specify a sessionId to compact.",
      };
    }
    try {
      const compactResult = await this.engine.compact({
        sessionId,
        tokenBudget: params.tokenBudget,
      });
      if (!compactResult.actionTaken) {
        return {
          ok: true,
          actionTaken: false,
          reason: "No compaction needed — conversation is already under threshold.",
        };
      }
      const tokensSaved = compactResult.tokensBefore - compactResult.tokensAfter;
      return {
        ok: true,
        actionTaken: true,
        tokensBefore: compactResult.tokensBefore,
        tokensAfter: compactResult.tokensAfter,
        tokensSaved,
        createdSummaryId: compactResult.createdSummaryId,
        level: compactResult.level as "leaf" | "condensed",
        reason: `Successfully compacted conversation: saved ${tokensSaved} tokens (${Math.round((tokensSaved / compactResult.tokensBefore) * 100)}% reduction).`,
      };
    } catch (error) {
      return {
        ok: false,
        actionTaken: false,
        reason: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
export async function createCodeMemoryCompactTool(
  engine: CodeMemoryContextEngine,
  getCurrentSessionId: () => string | undefined
): Promise<{
  name: string;
  description: string;
  params: { type: string; properties: Record<string, any>; required: string[] };
  call: (params: any) => Promise<any>;
}> {
  const tool = new CodeMemoryCompactTool(engine, getCurrentSessionId);
  return {
    name: "codememory_compact",
    description:
      "Manually compact the current conversation history to reduce token usage. Compaction preserves all content in a summary DAG that can be expanded back to full text when needed. Use when you want to free up context space for new work.",
    params: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Optional session ID to compact (defaults to current session).",
        },
        tokenBudget: {
          type: "number",
          description: "Optional target token budget for the compacted context.",
        },
      },
      required: [],
    },
    async call(params: CodeMemoryCompactParams) {
      return tool.compact(params);
    },
  };
}
