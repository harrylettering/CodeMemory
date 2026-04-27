/**
 * CodeMemory - Context Assembler
 *
 * Packs a conversation's DAG content (mix of message + summary items in
 * `conversation_context`) into a token-budgeted message array suitable for
 * feeding to an LLM.
 *
 * Today's only consumer is `codememory_expand_query.buildQueryContext`, which used
 * to walk `getContextItems` directly with NO input-side budgeting — long
 * conversations could blow the model's context window. This assembler is
 * that function's proper home.
 *
 * Selection strategy: skip-and-continue. We walk items in `ordinal` order;
 * any single item that doesn't fit in the remaining budget is skipped, but
 * we keep walking — later items might be smaller. `truncated=true` is set
 * if any item was skipped. Order among included items is preserved.
 */

import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord } from "./store/summary-store.js";

export interface AssemblyMessage {
  /** "user" / "assistant" / "system" — system is used for summary wrappers. */
  role: string;
  content: string;
  /** Source kind, useful for downstream rendering. */
  kind: "message" | "summary";
  /** sourceId is messageId for messages, summaryId for summaries. */
  sourceId: number | string;
  /** Tokens this entry contributes (content + role overhead). */
  tokens: number;
}

export interface PackResult {
  messages: AssemblyMessage[];
  estimatedTokens: number;
  /** True if at least one item was skipped because it didn't fit. */
  truncated: boolean;
}

export interface PackParams {
  /** Hard cap on total tokens. Items pushing past this are skipped. */
  tokenBudget: number;
}

/** Per-message wrapping overhead when fed to LLM messages array. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Wrapper text added to summary content; counted into tokens. */
const SUMMARY_PREFIX = "[SUMMARY] ";
const SUMMARY_PREFIX_TOKENS = Math.ceil(SUMMARY_PREFIX.length / 4);

export class CodeMemoryContextAssembler {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore
  ) {}

  /**
   * Pack a conversation's context items into messages within tokenBudget.
   *
   * Token cost per item = stored `tokenCount` + overhead (role wrapper +
   * any prefix we add). Stored `tokenCount` is trusted — both messages and
   * summaries persist it on insert (tier filter for messages, summarize
   * step for summaries).
   *
   * Returns items in `ordinal` order. Skipped items leave gaps but don't
   * stop the walk; `truncated` flips to true when any skip happens.
   */
  async pack(conversationId: number, params: PackParams): Promise<PackResult> {
    const items = await this.summaryStore.getContextItems(conversationId);

    const result: PackResult = {
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    if (items.length === 0) return result;
    if (params.tokenBudget <= 0) {
      result.truncated = true;
      return result;
    }

    for (const item of items) {
      if (item.itemType === "message" && item.messageId != null) {
        const msg = await this.conversationStore.getMessage(item.messageId);
        if (!msg) continue;
        const entry = renderMessage(msg);
        if (result.estimatedTokens + entry.tokens > params.tokenBudget) {
          result.truncated = true;
          continue;
        }
        result.messages.push(entry);
        result.estimatedTokens += entry.tokens;
      } else if (item.itemType === "summary" && item.summaryId != null) {
        const sum = await this.summaryStore.getSummary(item.summaryId);
        if (!sum) continue;
        const entry = renderSummary(sum);
        if (result.estimatedTokens + entry.tokens > params.tokenBudget) {
          result.truncated = true;
          continue;
        }
        result.messages.push(entry);
        result.estimatedTokens += entry.tokens;
      }
    }

    return result;
  }
}

function renderMessage(msg: MessageRecord): AssemblyMessage {
  const tokens = (msg.tokenCount ?? Math.ceil((msg.content?.length ?? 0) / 4)) + MESSAGE_OVERHEAD_TOKENS;
  return {
    role: msg.role,
    content: msg.content,
    kind: "message",
    sourceId: msg.messageId,
    tokens,
  };
}

function renderSummary(sum: SummaryRecord): AssemblyMessage {
  const baseTokens = sum.tokenCount ?? Math.ceil((sum.content?.length ?? 0) / 4);
  const tokens = baseTokens + MESSAGE_OVERHEAD_TOKENS + SUMMARY_PREFIX_TOKENS;
  return {
    role: "system",
    content: `${SUMMARY_PREFIX}${sum.content}`,
    kind: "summary",
    sourceId: sum.summaryId,
    tokens,
  };
}
