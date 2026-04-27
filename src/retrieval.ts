/**
 * CodeMemory for Claude Code - Retrieval Engine
 *
 * Search and retrieval engine for compacted conversation history.
 * Exactly matching CodeMemory's implementation.
 */

import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord } from "./store/summary-store.js";
import type { MemoryNodeStore, MemorySearchCandidate } from "./store/memory-store.js";
import {
  shapeFailure,
  renderFailureMarkdown,
  type FailureSurface,
} from "./failure-lookup.js";
import {
  MemoryRetrievalEngine,
  type MemoryRetrievalStats,
} from "./memory-retrieval.js";
import {
  createFastRetrievalPlan,
  extractPromptPivots,
  type PromptPivots,
  type RetrievalPlan,
} from "./retrieval-plan.js";
import {
  decideSmartPlanning,
  type QueryPlanner,
  type QueryPlannerMetadata,
} from "./query-planner.js";

export { createFastRetrievalPlan, extractPromptPivots } from "./retrieval-plan.js";

export interface MessageSearchResult {
  messageId: number;
  conversationId: number;
  role: string;
  content: string;
  tokenCount: number;
  tags?: string[];
  createdAt: Date;
}

export interface SummarySearchResult {
  summaryId: string;
  conversationId: number;
  kind: "leaf" | "condensed";
  content: string;
  tokenCount: number;
  createdAt: Date;
  depth: number;
  descendantCount: number;
  sourceMessageTokenCount: number;
}

export interface DescribeResult {
  id: string;
  type: "summary" | "file";
  /** Summary-specific fields */
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
    createdAt: Date;
  };
  /** File-specific fields */
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
  };
}

export interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface GrepResult {
  messages: MessageSearchResult[];
  summaries: SummarySearchResult[];
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  /** Max traversal depth (default 1) */
  depth?: number;
  /** Include raw source messages at leaf level */
  includeMessages?: boolean;
  /** Max tokens to return before truncating */
  tokenCap?: number;
}

export interface ExpandResult {
  /** Whether the requested root summary exists */
  found?: boolean;
  /** Machine-readable reason when found=false */
  reason?: string;

  /** Child summaries found */
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;
  /** Source messages (only if includeMessages=true and hitting leaf summaries) */
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;
  /** Total estimated tokens in result */
  estimatedTokens: number;
  /** Whether result was truncated due to tokenCap */
  truncated: boolean;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Render the fused result as a single markdown block. Sections only
 * appear when they have content, and the whole thing returns "" when
 * nothing is relevant — caller should treat empty markdown as "skip
 * injection". Order is intentional: failures first (highest signal),
 * decisions next (durable choices), generic context last.
 */
function renderPromptRetrieval(parts: {
  decisions: MessageSearchResult[];
  messages: MessageSearchResult[];
  failures: FailureSurface[];
}): string {
  const blocks: string[] = [];

  if (parts.failures.length > 0) {
    blocks.push(
      `### ⚠️ Prior Failures Relevant to This Prompt\n\n${renderFailureMarkdown(parts.failures)}`
    );
  }

  if (parts.decisions.length > 0) {
    const lines = parts.decisions
      .map((m) => `- ${m.content.replace(/\s+/g, " ").slice(0, 320)}`)
      .join("\n");
    blocks.push(`### 📌 Past Decisions\n\n${lines}`);
  }

  if (parts.messages.length > 0) {
    const lines = parts.messages
      .map((m) => {
        const snippet = m.content.replace(/\s+/g, " ").slice(0, 240);
        return `- (${m.role}) ${snippet}`;
      })
      .join("\n");
    blocks.push(`### 🧵 Related Context\n\n${lines}`);
  }

  return blocks.join("\n\n");
}

export interface PromptRetrievalInput {
  prompt: string;
  conversationId?: number;
  /** Max conversation messages to surface (default 3). */
  messageLimit?: number;
  /** Max failure records to surface (default 2). */
  failureLimit?: number;
}

export interface PromptRetrievalMetrics {
  memory: MemoryRetrievalStats;
  legacy: {
    queryCount: number;
    failureLookupCount: number;
    failureHits: number;
    decisionHits: number;
    messageHits: number;
  };
}

export interface PromptRetrievalResult {
  /** Tokens, file paths, and bash commands extracted from the prompt — these are what we actually queried with. */
  pivots: PromptPivots;
  /** Lightweight deterministic query plan used by Memory Node retrieval. */
  plan?: RetrievalPlan;
  /** Query planner observability: fast-only, smart success, or fallback. */
  planner?: QueryPlannerMetadata;
  /** Primary recall objects matched by memory tags. */
  memoryNodes?: MemorySearchCandidate[];
  /** One-hop stitched memory relations expanded from primary memory hits. */
  stitchedRelations?: Array<{
    relationType: string;
    score: number;
    fromNodeId: string;
    toNodeId: string;
  }>;
  /** Short stitched chains built from primary hits plus one additional hop. */
  stitchedChains?: Array<{
    score: number;
    nodeIds: string[];
    relationTypes: string[];
  }>;
  decisions: MessageSearchResult[];
  messages: MessageSearchResult[];
  failures: FailureSurface[];
  /** Structured retrieval stats for debugging and production observability. */
  metrics: PromptRetrievalMetrics;
  /** Pre-rendered markdown ready to inject via additionalContext. Empty string if nothing relevant. */
  markdown: string;
}

export class RetrievalEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private memoryStore?: MemoryNodeStore,
    private queryPlanner?: QueryPlanner,
    private queryPlannerEnabled: boolean = false
  ) {}

  async describe(id: string): Promise<DescribeResult | null> {
    if (id.startsWith("sum_") || id.startsWith("leaf-") || id.startsWith("cond-")) {
      return this.describeSummary(id);
    }
    if (id.startsWith("file_")) {
      return this.describeFile(id);
    }
    return null;
  }

  private async describeSummary(id: string): Promise<DescribeResult | null> {
    const summary = await this.summaryStore.getSummary(id);
    if (!summary) {
      return null;
    }

    const [parents, children, messageIds, subtree] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
      this.summaryStore.getSummarySubtree(id),
    ]);

    return {
      id,
      type: "summary",
      summary: {
        conversationId: summary.conversationId,
        kind: summary.kind,
        content: summary.content,
        depth: summary.depth,
        tokenCount: summary.tokenCount,
        descendantCount: summary.descendantCount,
        descendantTokenCount: 0,
        sourceMessageTokenCount: 0,
        fileIds: [],
        parentIds: parents.map((p) => p.summaryId),
        childIds: children.map((c) => c.summaryId),
        messageIds,
        earliestAt: null,
        latestAt: null,
        subtree: subtree.map((node) => ({
          summaryId: node.summaryId,
          parentSummaryId: node.parentSummaryId,
          depthFromRoot: node.depthFromRoot,
          kind: node.kind,
          depth: node.depth,
          tokenCount: node.tokenCount,
          descendantCount: node.descendantCount,
          descendantTokenCount: 0,
          sourceMessageTokenCount: 0,
          earliestAt: null,
          latestAt: null,
          childCount: node.childCount,
          path: node.path,
        })),
        createdAt: new Date(summary.createdAt),
      },
    };
  }

  private async describeFile(id: string): Promise<DescribeResult | null> {
    return null;
  }

  /**
   * Two-path retrieval driven by a UserPromptSubmit prompt:
   *   - Path A: prior failure records (memory_nodes kind='failure') keyed
   *     on filePaths/commands/symbols pulled from the prompt. These are
   *     the high-signal "don't step on this pit again" warnings.
   *   - Path B: prior conversation messages matching the keywords. We
   *     bias toward `tag='decision'` rows so previously-marked
   *     `codememory_mark_decision` punctuation surfaces first.
   *
   * Returns a unified result + pre-rendered markdown ready to inject.
   */
  async retrieveForPrompt(input: PromptRetrievalInput): Promise<PromptRetrievalResult> {
    const messageLimit = input.messageLimit ?? 3;
    const failureLimit = input.failureLimit ?? 2;
    let plan = createFastRetrievalPlan(input.prompt);
    const pivots = extractPromptPivots(input.prompt);

    const memoryEngine = this.memoryStore
      ? new MemoryRetrievalEngine(this.memoryStore, this.summaryStore)
      : undefined;
    let memoryResult = memoryEngine
      ? await memoryEngine.retrieve({
          plan,
          conversationId: input.conversationId,
        })
      : {
          nodes: [],
          stitchedRelations: [],
          stitchedChains: [],
          markdown: "",
          estimatedTokens: 0,
          summaryEvidence: new Map(),
          stats: emptyMemoryRetrievalStats(),
        };
    let plannerMeta: QueryPlannerMetadata = {
      source: "fast",
      attempted: false,
      reason: "fast_plan_sufficient",
    };

    const plannerDecision = decideSmartPlanning({
      enabled: this.queryPlannerEnabled && !!this.queryPlanner && !!memoryEngine,
      prompt: input.prompt,
      fastPlan: plan,
      memoryNodes: memoryResult.nodes,
    });
    plannerMeta = {
      source: "fast",
      attempted: false,
      reason: plannerDecision.reason,
    };

    if (plannerDecision.shouldPlan && this.queryPlanner && memoryEngine) {
      try {
        const smartPlan = await this.queryPlanner.plan({
          prompt: input.prompt,
          fastPlan: plan,
          reason: plannerDecision.reason,
        });
        const smartMemoryResult = await memoryEngine.retrieve({
          plan: smartPlan,
          conversationId: input.conversationId,
        });
        plan = smartPlan;
        memoryResult = smartMemoryResult;
        plannerMeta = {
          source: "smart",
          attempted: true,
          reason: plannerDecision.reason,
        };
      } catch (err) {
        plannerMeta = {
          source: "fallback",
          attempted: true,
          reason: plannerDecision.reason,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const finalPivots = {
      keywords: pivots.keywords,
      filePaths: Array.from(new Set([...pivots.filePaths, ...plan.entities.files])),
      commands: Array.from(new Set([...pivots.commands, ...plan.entities.commands])),
      symbols: Array.from(new Set([...pivots.symbols, ...plan.entities.symbols])),
    };

    // ---- Path A: prior failures (memory_nodes kind='failure') ----------
    const failuresSeen = new Map<string, FailureSurface>();
    if (this.memoryStore) {
      const candidates = await this.memoryStore.findFailuresByAnchors({
        files: finalPivots.filePaths,
        commands: finalPivots.commands,
        symbols: finalPivots.symbols,
        statuses: ["active"],
        limit: failureLimit * 4,
      });
      for (const candidate of candidates) {
        if (failuresSeen.has(candidate.node.nodeId)) continue;
        failuresSeen.set(
          candidate.node.nodeId,
          shapeFailure(candidate.node, candidate.node.confidence ?? 1.0)
        );
        if (failuresSeen.size >= failureLimit) break;
      }
    }
    const failures = Array.from(failuresSeen.values()).slice(0, failureLimit);

    // ---- Path B: conversation messages ---------------------------------
    // Search for each keyword/symbol/path; dedup by messageId.
    const queries = Array.from(
      new Set([
        ...finalPivots.filePaths,
        ...finalPivots.symbols,
        ...finalPivots.keywords,
      ])
    ).slice(0, 6);

    const messageSeen = new Map<number, MessageSearchResult>();
    const decisionSeen = new Map<number, MessageSearchResult>();

    for (const q of queries) {
      if (!q) continue;
      const rows = await this.conversationStore.searchMessages({
        query: q,
        mode: "full_text",
        conversationId: input.conversationId,
        limit: messageLimit + 2,
      });
      for (const m of rows) {
        const isDecision =
          typeof (m as any).content === "string" &&
          (/^\[DECISION\]/.test((m as any).content) ||
            ((m as any).tags || []).includes("decision"));
        const target = isDecision ? decisionSeen : messageSeen;
        if (!target.has(m.messageId)) target.set(m.messageId, m);
      }
    }

    const decisions = Array.from(decisionSeen.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, messageLimit);
    const messages = Array.from(messageSeen.values())
      .filter((m) => !decisionSeen.has(m.messageId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, messageLimit);

    const legacyMarkdown = renderPromptRetrieval({ decisions, messages, failures });
    const markdown = memoryResult.markdown || legacyMarkdown;
    const metrics: PromptRetrievalMetrics = {
      memory: memoryResult.stats,
      legacy: {
        queryCount: queries.length,
        failureLookupCount:
          finalPivots.filePaths.length +
          finalPivots.commands.length +
          finalPivots.symbols.length,
        failureHits: failures.length,
        decisionHits: decisions.length,
        messageHits: messages.length,
      },
    };

    return {
      pivots: finalPivots,
      plan,
      planner: plannerMeta,
      memoryNodes: memoryResult.nodes,
      stitchedRelations: memoryResult.stitchedRelations.map((relation) => ({
        relationType: relation.relationType,
        score: relation.score,
        fromNodeId: relation.fromNode.nodeId,
        toNodeId: relation.toNode.nodeId,
      })),
      stitchedChains: memoryResult.stitchedChains.map((chain) => ({
        score: chain.score,
        nodeIds: chain.nodes.map((node) => node.nodeId),
        relationTypes: chain.edges.map((edge) => edge.relationType),
      })),
      decisions,
      messages,
      failures,
      metrics,
      markdown,
    };
  }

  async grep(input: GrepInput): Promise<GrepResult> {
    const { query, mode, scope, conversationId, since, before, limit } = input;

    const searchInput = { query, mode, conversationId, since, before, limit };

    let messages: MessageSearchResult[] = [];
    let summaries: SummarySearchResult[] = [];

    if (scope === "messages") {
      messages = await this.conversationStore.searchMessages(searchInput);
    } else if (scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(searchInput);
    } else {
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(searchInput),
        this.summaryStore.searchSummaries(searchInput),
      ]);
    }

    messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      messages,
      summaries,
      totalMatches: messages.length + summaries.length,
    };
  }

  async expand(input: ExpandInput): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Infinity;
    const root = await this.summaryStore.getSummary(input.summaryId);

    const result: ExpandResult = {
      found: !!root,
      reason: root ? undefined : "summary_not_found",
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    if (!root) {
      return result;
    }

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);

    return result;
  }

  private async expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: ExpandResult,
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }
    if (result.truncated) {
      return;
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return;
    }

    if (summary.kind === "condensed") {
      const children = await this.summaryStore.getSummaryChildren(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }

        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result.estimatedTokens += child.tokenCount;

        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);

      for (const msgId of messageIds) {
        if (result.truncated) {
          break;
        }

        const msg = await this.conversationStore.getMessageById(msgId);
        if (!msg) {
          continue;
        }

        const tokenCount = msg.tokenCount || estimateTokens(msg.content);

        if (result.estimatedTokens + tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          tokenCount,
        });
        result.estimatedTokens += tokenCount;
      }
    }
  }
}

function emptyMemoryRetrievalStats(): MemoryRetrievalStats {
  return {
    candidateCount: 0,
    selectedNodeCount: 0,
    stitchedRelationCount: 0,
    stitchedChainCount: 0,
    summaryEvidenceCount: 0,
    relationQueryBatches: 0,
    firstHopNodeCount: 0,
    firstHopRelationCount: 0,
    secondHopNodeCount: 0,
    secondHopRelationCount: 0,
    estimatedTokens: 0,
  };
}
