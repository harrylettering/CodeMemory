/**
 * The existing memories a compaction call is shown, so extraction can say
 * "this replaces that" instead of adding a near-duplicate every window.
 *
 * Assembled without an LLM, from three sources, in this order of trust:
 *
 *   A  what prompt-time retrieval already surfaced inside this window.
 *      Measured on a live database: median 5 nodes per turn, 86% of them
 *      (658/762) decisions, tasks or constraints. A node the model never saw
 *      is one this window is unlikely to be revising -- and the work of
 *      choosing it was already done and logged.
 *   B  what was written since the last extraction: the previous window's own
 *      output, and anything a mark skill stored. Too new to have surfaced.
 *   C  a tag scan over the window's anchors, used only when A and B are both
 *      empty: the daemon was down, the rows came from a re-import, or the
 *      turns were a subagent's (no UserPromptSubmit, so no retrieval event).
 *      85% of recent windows have a retrieval event, so this is the minority
 *      path -- but the minority includes every re-imported session.
 *
 * Only titles are sent. Carrying 200 characters of content per candidate cost
 * roughly 1,000 tokens on every compaction, re-sent each time.
 */

import { normalizeTagValue } from "../retrieval-plan.js";

export type CandidateSource = "surfaced" | "recent-write" | "tag-scan";

export interface CandidateMemory {
  nodeId: string;
  kind: string;
  status: string;
  updatedAt: string;
  title: string;
  source: CandidateSource;
  /** How many times this window's retrieval surfaced it. */
  surfacedCount: number;
}

export interface CandidateAnchors {
  files: string[];
  commands: string[];
  symbols: string[];
  topics: string[];
}

export interface CollectCandidatesInput {
  conversationId: number;
  /** Timestamps bounding the window, used to find its retrieval events. */
  windowFrom: string;
  windowTo: string;
  /** Nodes updated after this are "recent writes" (source B). */
  writtenSince: string;
  anchors: CandidateAnchors;
  budgetChars: number;
}

export interface CandidateResult {
  items: CandidateMemory[];
  /** One line per candidate, ready to drop into the prompt. */
  rendered: string;
  counts: {
    fromSurfaced: number;
    fromRecentWrites: number;
    fromTagScan: number;
    dropped: number;
  };
}

/** Kinds that are stated in prose and therefore extracted rather than derived. */
const EXTRACTED_KINDS = ["decision", "task", "constraint"] as const;

const TITLE_MAX = 120;
const DETAILS_MARKER = /\s(Details|Rationale|Alternatives rejected|理由|详情)[:：]/;

/**
 * The line that identifies a memory to the model: its claim, without the
 * reasoning that follows. Node content runs to a median of 375 characters,
 * most of which is the rationale.
 */
export function memoryTitle(content: string): string {
  let text = content.replace(/^\[[A-Z_ ]+\]\s*/, "").replace(/\s+/g, " ").trim();
  const details = text.search(DETAILS_MARKER);
  if (details > 0) text = text.slice(0, details);
  const sentence = text.match(/^(.{10,}?)[.。!！?？](?:\s|$)/);
  if (sentence) text = sentence[1];
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

function renderLine(item: CandidateMemory): string {
  return `[${item.nodeId}] ${item.kind}/${item.status} · ${item.updatedAt.slice(0, 10)} · ${item.title}`;
}

function toCandidate(row: any, source: CandidateSource, surfacedCount = 0): CandidateMemory {
  return {
    nodeId: row.nodeId,
    kind: row.kind,
    status: row.status,
    updatedAt: row.updatedAt,
    title: memoryTitle(row.content ?? ""),
    source,
    surfacedCount,
  };
}

export async function collectCandidateMemories(
  db: any,
  input: CollectCandidatesInput
): Promise<CandidateResult> {
  const kindPlaceholders = EXTRACTED_KINDS.map(() => "?").join(",");
  const eligible = async (nodeIds: string[]): Promise<any[]> => {
    if (nodeIds.length === 0) return [];
    return db.all(
      `SELECT nodeId, kind, status, content, updatedAt
         FROM memory_nodes
        WHERE conversationId = ?
          AND status = 'active'
          AND kind IN (${kindPlaceholders})
          AND nodeId IN (${nodeIds.map(() => "?").join(",")})`,
      [input.conversationId, ...EXTRACTED_KINDS, ...nodeIds]
    );
  };

  // ---- A: surfaced inside the window ------------------------------------
  const events: any[] = await db.all(
    `SELECT surfacedNodeIds
       FROM retrieval_events
      WHERE conversationId = ?
        AND createdAt BETWEEN ? AND ?
        AND surfacedNodeIds IS NOT NULL`,
    [input.conversationId, input.windowFrom, input.windowTo]
  );
  const surfacedCounts = new Map<string, number>();
  for (const row of events) {
    let ids: unknown;
    try {
      ids = JSON.parse(row.surfacedNodeIds);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      surfacedCounts.set(id, (surfacedCounts.get(id) ?? 0) + 1);
    }
  }
  const surfaced = (await eligible([...surfacedCounts.keys()])).map((row) =>
    toCandidate(row, "surfaced", surfacedCounts.get(row.nodeId) ?? 0)
  );

  // ---- B: written since the last extraction ------------------------------
  const recentRows: any[] = await db.all(
    `SELECT nodeId, kind, status, content, updatedAt
       FROM memory_nodes
      WHERE conversationId = ?
        AND status = 'active'
        AND kind IN (${kindPlaceholders})
        AND updatedAt > ?
      ORDER BY updatedAt DESC`,
    [input.conversationId, ...EXTRACTED_KINDS, input.writtenSince]
  );
  const recent = recentRows.map((row) => toCandidate(row, "recent-write"));

  const byId = new Map<string, CandidateMemory>();
  for (const item of recent) byId.set(item.nodeId, item);
  for (const item of surfaced) {
    const existing = byId.get(item.nodeId);
    if (existing) existing.surfacedCount = item.surfacedCount;
    else byId.set(item.nodeId, item);
  }

  // ---- C: tag scan, only when the first two found nothing ----------------
  let scanned: CandidateMemory[] = [];
  if (byId.size === 0) {
    // Tag values are stored normalized (trimmed, collapsed, lowercased), so
    // anchors have to be matched the same way or a symbol like
    // `spawnWithStdin` never matches the row it wrote.
    const anchorValues = [
      ...input.anchors.files,
      ...input.anchors.commands,
      ...input.anchors.symbols,
      ...input.anchors.topics,
    ]
      .map((value) => normalizeTagValue(value ?? ""))
      .filter(Boolean);
    if (anchorValues.length > 0) {
      const rows: any[] = await db.all(
        `SELECT DISTINCT n.nodeId, n.kind, n.status, n.content, n.updatedAt
           FROM memory_nodes n
           JOIN memory_tags t ON t.nodeId = n.nodeId
          WHERE n.conversationId = ?
            AND n.status = 'active'
            AND n.kind IN (${kindPlaceholders})
            AND t.tagType != 'kind'
            AND t.tagValue IN (${anchorValues.map(() => "?").join(",")})
          ORDER BY n.updatedAt DESC`,
        [input.conversationId, ...EXTRACTED_KINDS, ...anchorValues]
      );
      scanned = rows.map((row) => toCandidate(row, "tag-scan"));
      for (const item of scanned) byId.set(item.nodeId, item);
    }
  }

  // Recent writes first: a memory written moments ago is the one this window
  // is most likely to be revising. Then by how often the window surfaced it.
  const ranked = [...byId.values()].sort((a, b) => {
    const rank = (c: CandidateMemory) => (c.source === "recent-write" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.surfacedCount !== b.surfacedCount) return b.surfacedCount - a.surfacedCount;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const kept: CandidateMemory[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const item of ranked) {
    const line = renderLine(item);
    if (used + line.length + 1 > input.budgetChars) continue;
    kept.push(item);
    lines.push(line);
    used += line.length + 1;
  }

  return {
    items: kept,
    rendered: lines.join("\n"),
    counts: {
      fromSurfaced: kept.filter((i) => i.source === "surfaced").length,
      fromRecentWrites: kept.filter((i) => i.source === "recent-write").length,
      fromTagScan: kept.filter((i) => i.source === "tag-scan").length,
      dropped: ranked.length - kept.length,
    },
  };
}
