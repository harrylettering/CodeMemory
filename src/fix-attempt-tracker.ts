import type { JsonlMessage, RawMessagePart } from "./hooks/jsonl-watcher.js";
import { LifecycleResolver } from "./lifecycle-resolver.js";
import type { MemoryNodeStore } from "./store/memory-store.js";

export type AttemptOutcome = "unknown" | "succeeded" | "failed" | "partial";

export interface AttemptSpanRecord {
  attemptId: string;
  conversationId: number;
  sessionId: string | null;
  status: "active" | "closed";
  outcome: AttemptOutcome;
  startedAtSeq: number;
  endedAtSeq: number | null;
  touchedFiles: string[];
  commandsRun: string[];
  relatedFailureNodeIds: string[];
  fixAttemptNodeId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptObservationContext {
  conversationId: number;
  sessionId?: string;
  seq: number;
  messageId: number;
  failureNodeIds?: string[];
}

interface ToolUseRecord {
  toolName: string;
  files: string[];
  command?: string;
}

interface ValidationRecord {
  command: string;
  ok: boolean;
  seq: number;
  messageId: number;
  contentPreview?: string;
}

const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const VALIDATION_GRACE_SEQ_WINDOW = 8;

export class FixAttemptTracker {
  private toolUses = new Map<string, ToolUseRecord>();

  constructor(
    private db: any,
    private memoryStore: MemoryNodeStore,
    private lifecycleResolver: LifecycleResolver
  ) {}

  async observeToolUses(
    message: JsonlMessage,
    context: AttemptObservationContext
  ): Promise<void> {
    for (const part of message.metadata?.parts ?? []) {
      if (part.type !== "tool_use") continue;

      const record = toolUseRecord(part);
      if (part.id && record) this.toolUses.set(part.id, record);

      if (record && MUTATION_TOOLS.has(record.toolName) && record.files.length > 0) {
        await this.openOrUpdateAttempt({
          ...context,
          files: record.files,
          toolName: record.toolName,
          toolUseId: part.id,
        });
      }
    }
  }

  async observeToolResults(
    message: JsonlMessage,
    context: AttemptObservationContext
  ): Promise<void> {
    for (const part of message.metadata?.parts ?? []) {
      if (part.type !== "tool_result" || !part.tool_use_id) continue;
      const toolUse = this.toolUses.get(part.tool_use_id);
      if (!toolUse || toolUse.toolName !== "Bash" || !toolUse.command) continue;
      if (!isValidationCommand(toolUse.command)) continue;

      const attempt =
        (await this.getLatestActiveAttempt(
          context.conversationId,
          context.sessionId
        )) ??
        (await this.getLatestRecentClosedAttempt(
          context.conversationId,
          context.sessionId,
          context.seq
        ));
      if (!attempt) continue;

      await this.recordValidationResult({
        attempt,
        command: toolUse.command,
        ok: part.is_error !== true,
        contentPreview: previewToolResult(part.content),
        context,
      });
    }
  }

  async getAttempt(attemptId: string): Promise<AttemptSpanRecord | null> {
    const row = await this.db.get(
      "SELECT * FROM attempt_spans WHERE attemptId = ?",
      attemptId
    );
    return row ? mapAttempt(row) : null;
  }

  private async openOrUpdateAttempt(input: {
    conversationId: number;
    sessionId?: string;
    seq: number;
    messageId: number;
    files: string[];
    toolName: string;
    toolUseId?: string;
  }): Promise<AttemptSpanRecord> {
    const existing = await this.getLatestActiveAttempt(
      input.conversationId,
      input.sessionId
    );
    if (existing) {
      const touchedFiles = unique([...existing.touchedFiles, ...input.files]);
      await this.updateAttempt(existing.attemptId, {
        touchedFiles,
        metadata: {
          ...existing.metadata,
          lastMutationTool: input.toolName,
          lastMutationMessageId: input.messageId,
        },
      });
      await this.memoryStore.createFixAttemptNode({
        attemptId: existing.attemptId,
        conversationId: existing.conversationId,
        sessionId: existing.sessionId,
        outcome: existing.outcome,
        touchedFiles,
        commandsRun: existing.commandsRun,
        relatedFailureNodeIds: existing.relatedFailureNodeIds,
        startedAtSeq: existing.startedAtSeq,
        endedAtSeq: existing.endedAtSeq,
        evidenceMessageId: input.messageId,
      });
      return (await this.getAttempt(existing.attemptId)) ?? existing;
    }

    const attemptId = await this.nextAttemptId(
      input.conversationId,
      input.seq,
      input.toolUseId
    );
    const relatedFailures = await this.findInitialRelatedFailures(
      input.conversationId,
      input.files
    );
    const fixAttemptNodeId = `fix-attempt-${attemptId}`;
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO attempt_spans (
         attemptId, conversationId, sessionId, status, outcome, startedAtSeq,
         touchedFiles, commandsRun, relatedFailureNodeIds, fixAttemptNodeId,
         metadata, createdAt, updatedAt
       ) VALUES (?, ?, ?, 'active', 'unknown', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attemptId,
        input.conversationId,
        input.sessionId ?? null,
        input.seq,
        JSON.stringify(unique(input.files)),
        JSON.stringify([]),
        JSON.stringify(relatedFailures),
        fixAttemptNodeId,
        JSON.stringify({
          firstMutationTool: input.toolName,
          firstMutationMessageId: input.messageId,
        }),
        now,
        now,
      ]
    );

    await this.memoryStore.createFixAttemptNode({
      attemptId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      outcome: "unknown",
      touchedFiles: input.files,
      commandsRun: [],
      relatedFailureNodeIds: relatedFailures,
      startedAtSeq: input.seq,
      evidenceMessageId: input.messageId,
    });

    return (await this.getAttempt(attemptId))!;
  }

  private async recordValidationResult(input: {
    attempt: AttemptSpanRecord;
    command: string;
    ok: boolean;
    contentPreview?: string;
    context: AttemptObservationContext;
  }): Promise<void> {
    const previousOutcome = input.attempt.outcome;
    const validationResults = [
      ...validationResultsFromMetadata(input.attempt.metadata),
      {
        command: input.command,
        ok: input.ok,
        seq: input.context.seq,
        messageId: input.context.messageId,
        contentPreview: input.contentPreview,
      },
    ];
    const outcome = deriveValidationOutcome(validationResults);
    const commandsRun = unique([...input.attempt.commandsRun, input.command]);
    const relatedFailureNodeIds = unique([
      ...input.attempt.relatedFailureNodeIds,
      ...(input.context.failureNodeIds ?? []),
    ]);

    await this.updateAttempt(input.attempt.attemptId, {
      status: "closed",
      outcome,
      endedAtSeq: input.context.seq,
      commandsRun,
      relatedFailureNodeIds,
      metadata: {
        ...input.attempt.metadata,
        closedByMessageId: input.context.messageId,
        closedByCommand: input.command,
        validationResults,
      },
    });

    const fixNode = await this.memoryStore.createFixAttemptNode({
      attemptId: input.attempt.attemptId,
      conversationId: input.attempt.conversationId,
      sessionId: input.attempt.sessionId,
      outcome,
      touchedFiles: input.attempt.touchedFiles,
      commandsRun,
      relatedFailureNodeIds,
      startedAtSeq: input.attempt.startedAtSeq,
      endedAtSeq: input.context.seq,
      evidenceMessageId: input.context.messageId,
      metadata: {
        closedByMessageId: input.context.messageId,
        validationResults,
      },
    });

    if (outcome === "succeeded") {
      await this.lifecycleResolver.resolveFailuresForSucceededAttempt({
        conversationId: input.context.conversationId,
        fixAttemptNodeId: fixNode.nodeId,
        files: input.attempt.touchedFiles,
        commands: commandsRun,
        evidenceMessageId: input.context.messageId,
      });
      return;
    }

    if (previousOutcome === "succeeded") {
      await this.lifecycleResolver.reopenResolvedFailuresForFixAttempt({
        fixAttemptNodeId: fixNode.nodeId,
        evidenceMessageId: input.context.messageId,
        reason:
          outcome === "partial"
            ? "additional validation made the fix attempt partial"
            : "additional validation made the fix attempt fail",
      });
    }

    for (const failureNodeId of input.context.failureNodeIds ?? []) {
      await this.memoryStore.addRelation({
        fromNodeId: failureNodeId,
        toNodeId: fixNode.nodeId,
        relationType: "causedBy",
        confidence: 0.9,
        evidenceMessageId: input.context.messageId,
        metadata: {
          attemptId: input.attempt.attemptId,
          command: input.command,
        },
      });
    }
  }

  private async getLatestActiveAttempt(
    conversationId: number,
    sessionId?: string
  ): Promise<AttemptSpanRecord | null> {
    const row = await this.db.get(
      `SELECT * FROM attempt_spans
       WHERE conversationId = ?
         AND status = 'active'
         AND (sessionId IS ? OR sessionId = ?)
       ORDER BY startedAtSeq DESC, createdAt DESC
       LIMIT 1`,
      [conversationId, sessionId ?? null, sessionId ?? null]
    );
    return row ? mapAttempt(row) : null;
  }

  private async getLatestRecentClosedAttempt(
    conversationId: number,
    sessionId: string | undefined,
    seq: number
  ): Promise<AttemptSpanRecord | null> {
    const row = await this.db.get(
      `SELECT * FROM attempt_spans
       WHERE conversationId = ?
         AND status = 'closed'
         AND endedAtSeq IS NOT NULL
         AND endedAtSeq >= ?
         AND (sessionId IS ? OR sessionId = ?)
       ORDER BY endedAtSeq DESC, updatedAt DESC
       LIMIT 1`,
      [
        conversationId,
        seq - VALIDATION_GRACE_SEQ_WINDOW,
        sessionId ?? null,
        sessionId ?? null,
      ]
    );
    return row ? mapAttempt(row) : null;
  }

  private async updateAttempt(
    attemptId: string,
    patch: Partial<
      Pick<
        AttemptSpanRecord,
        | "status"
        | "outcome"
        | "endedAtSeq"
        | "touchedFiles"
        | "commandsRun"
        | "relatedFailureNodeIds"
        | "metadata"
      >
    >
  ): Promise<void> {
    const current = await this.getAttempt(attemptId);
    if (!current) return;
    await this.db.run(
      `UPDATE attempt_spans
          SET status = ?,
              outcome = ?,
              endedAtSeq = ?,
              touchedFiles = ?,
              commandsRun = ?,
              relatedFailureNodeIds = ?,
              metadata = ?,
              updatedAt = ?
        WHERE attemptId = ?`,
      [
        patch.status ?? current.status,
        patch.outcome ?? current.outcome,
        patch.endedAtSeq ?? current.endedAtSeq,
        JSON.stringify(patch.touchedFiles ?? current.touchedFiles),
        JSON.stringify(patch.commandsRun ?? current.commandsRun),
        JSON.stringify(patch.relatedFailureNodeIds ?? current.relatedFailureNodeIds),
        JSON.stringify(patch.metadata ?? current.metadata),
        new Date().toISOString(),
        attemptId,
      ]
    );
  }

  private async findInitialRelatedFailures(
    conversationId: number,
    files: string[]
  ): Promise<string[]> {
    const candidates = await this.memoryStore.findActiveFailuresByAnchors({
      conversationId,
      files,
      limit: 3,
    });
    const [top, second] = candidates;
    if (!top || top.score < 3.5) return [];
    if (second && top.score - second.score < 1.25) return [];
    return [top.node.nodeId];
  }

  private async nextAttemptId(
    conversationId: number,
    seq: number,
    toolUseId?: string
  ): Promise<string> {
    const suffix = sanitizeId(toolUseId) || "mutation";
    const base = `attempt-${conversationId}-${seq}-${suffix}`;
    let candidate = base;
    let n = 1;
    while (await this.getAttempt(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}

function toolUseRecord(
  part: Extract<RawMessagePart, { type: "tool_use" }>
): ToolUseRecord | null {
  const toolName = part.name ?? "";
  const input = part.input && typeof part.input === "object" ? part.input : {};
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    return command ? { toolName, files: filesFromCommand(command), command } : null;
  }
  if (!MUTATION_TOOLS.has(toolName)) return null;
  const files = filesFromMutationInput(toolName, input);
  return files.length > 0 ? { toolName, files } : null;
}

function filesFromMutationInput(toolName: string, input: any): string[] {
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const fp = input.file_path || input.path;
    return typeof fp === "string" ? [fp] : [];
  }
  const fp = input.file_path || input.path;
  return typeof fp === "string" && fp ? [fp] : [];
}

function filesFromCommand(command: string): string[] {
  return Array.from(
    command.matchAll(/\b((?:\.\.?\/|\/|[\w.-]+\/)?[\w.-]+\.[a-zA-Z]{1,8})\b/g),
    (match) => match[1]
  );
}

function isValidationCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|tsc|typecheck|eslint|lint|build|cargo test|go test)\b/i.test(
    command
  );
}

function validationResultsFromMetadata(
  metadata: Record<string, unknown>
): ValidationRecord[] {
  const raw = metadata.validationResults;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.command !== "string") return [];
    return [{
      command: record.command,
      ok: record.ok === true,
      seq: typeof record.seq === "number" ? record.seq : 0,
      messageId: typeof record.messageId === "number" ? record.messageId : 0,
      contentPreview:
        typeof record.contentPreview === "string"
          ? record.contentPreview
          : undefined,
    }];
  });
}

function deriveValidationOutcome(results: ValidationRecord[]): AttemptOutcome {
  if (results.length === 0) return "unknown";
  const hasSuccess = results.some((result) => result.ok);
  const hasFailure = results.some((result) => !result.ok);
  if (hasSuccess && hasFailure) return "partial";
  return hasSuccess ? "succeeded" : "failed";
}

function previewToolResult(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 240);
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text ? text.slice(0, 240) : undefined;
  }
  return undefined;
}

function mapAttempt(row: any): AttemptSpanRecord {
  return {
    attemptId: row.attemptId,
    conversationId: row.conversationId,
    sessionId: row.sessionId ?? null,
    status: row.status,
    outcome: row.outcome,
    startedAtSeq: row.startedAtSeq,
    endedAtSeq: row.endedAtSeq ?? null,
    touchedFiles: parseStringArray(row.touchedFiles),
    commandsRun: parseStringArray(row.commandsRun),
    relatedFailureNodeIds: parseStringArray(row.relatedFailureNodeIds),
    fixAttemptNodeId: row.fixAttemptNodeId ?? null,
    metadata: parseRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function sanitizeId(value?: string): string {
  return (value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
