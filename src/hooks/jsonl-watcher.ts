/**
 * CodeMemory for Claude Code - JSONL File Watcher
 *
 * File monitoring for `~/.claude/projects/*.jsonl` with incremental message parsing.
 *
 * Exactly matches CodeMemory's JSONL watcher implementation.
 */

import type { CodeMemoryDependencies } from "../types.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";

export interface FileWatchEvent {
  type: "create" | "update" | "delete" | "rename";
  filePath: string;
  oldPath?: string;
}

/** Structured part preserved from the raw JSONL message for downstream scoring. */
export type RawMessagePart =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: any; id?: string }
  | {
      type: "tool_result";
      content: any;
      is_error?: boolean;
      tool_use_id?: string;
    };

export interface JsonlMessage {
  id: string;
  type: string;
  content: string;
  role: string;
  timestamp: number;
  metadata?: {
    sessionId?: string;
    parentUuid?: string;
    cwd?: string;
    /** Subagent / sidechain marker — set on raw JSONL by Claude Code. */
    isSidechain?: boolean;
    /** Original structured parts; needed by the Filter/Score layer. */
    parts?: RawMessagePart[];
  };
}

export interface JsonlWatchOptions {
  watchPath?: string;
  pollInterval?: number;
  includePattern?: RegExp;
  excludePattern?: RegExp;
}

export class CodeMemoryJsonlWatcher {
  private watcher: any | null = null;
  private watchedFiles = new Map<string, number>(); // filePath -> lastProcessedOffset
  private watchedFileStats = new Map<string, { mtime: number; size: number }>(); // filePath -> { mtime, size }
  private callbacks = new Map<string, Array<(event: FileWatchEvent) => void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private deps: CodeMemoryDependencies, private options: JsonlWatchOptions = {}) {
    this.options = {
      watchPath: this.options.watchPath || this.getDefaultWatchPath(),
      pollInterval: this.options.pollInterval || 5000,
      includePattern: this.options.includePattern || /\.jsonl$/,
      excludePattern: this.options.excludePattern,
    };
  }

  private getDefaultWatchPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) {
      throw new Error("HOME or USERPROFILE environment variable not set");
    }
    return join(home, ".claude", "projects");
  }

  /**
   * Start watching for JSONL files
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.deps.log.warn("JSONL watcher already running");
      return;
    }

    this.isRunning = true;
    this.deps.log.debug(`Starting JSONL watcher on ${this.options.watchPath}`);

    try {
      // Initial scan
      await this.scanDirectory();
    } catch (error) {
      this.deps.log.warn(`Initial scan failed: ${error}`);
    }

    // Start polling
    this.startPolling();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.poll(), this.options.pollInterval);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.scanDirectory();
    } catch (error) {
      this.deps.log.debug(`Poll failed: ${error}`);
    }
  }

  /**
   * Scan the watch directory for changes
   */
  private async scanDirectory(): Promise<void> {
    const watchPath = this.options.watchPath!;

    try {
      const files = await readdir(watchPath, { withFileTypes: true });

      for (const file of files) {
        if (!file.isFile()) {
          continue;
        }

        const filePath = join(watchPath, file.name);

        if (!this.shouldWatchFile(filePath)) {
          continue;
        }

        await this.checkFile(filePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.deps.log.debug(`Watch directory not found: ${watchPath}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Check if a file should be watched
   */
  private shouldWatchFile(filePath: string): boolean {
    const fileName = basename(filePath);

    if (this.options.excludePattern && this.options.excludePattern.test(fileName)) {
      return false;
    }

    if (this.options.includePattern && !this.options.includePattern.test(fileName)) {
      return false;
    }

    return true;
  }

  /**
   * Check a file for changes
   */
  private async checkFile(filePath: string): Promise<void> {
    const stats = await stat(filePath);
    const currentMtime = stats.mtimeMs;
    const currentSize = stats.size;
    const oldStats = this.watchedFileStats.get(filePath);

    if (!oldStats) {
      this.watchedFileStats.set(filePath, { mtime: currentMtime, size: currentSize });
      this.notifyCallbacks({ type: "create", filePath });
      return;
    }

    if (oldStats.mtime !== currentMtime || oldStats.size !== currentSize) {
      this.watchedFileStats.set(filePath, { mtime: currentMtime, size: currentSize });
      this.notifyCallbacks({ type: "update", filePath });
    }
  }

  /**
   * Notify callbacks of a file event
   */
  private notifyCallbacks(event: FileWatchEvent): void {
    const callbacks = this.callbacks.get(event.type) || [];
    for (const callback of callbacks) {
      try {
        callback(event);
      } catch (error) {
        this.deps.log.error(`Callback error: ${error}`);
      }
    }

    const allCallbacks = this.callbacks.get("*") || [];
    for (const callback of allCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.deps.log.error(`Callback error: ${error}`);
      }
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.deps.log.debug("JSONL watcher stopped");
  }

  /**
   * Register a callback for file events
   */
  on(eventType: string, callback: (event: FileWatchEvent) => void): void {
    const callbacks = this.callbacks.get(eventType) || [];
    callbacks.push(callback);
    this.callbacks.set(eventType, callbacks);
  }

  /**
   * Unregister a callback
   */
  off(eventType: string, callback: (event: FileWatchEvent) => void): void {
    const callbacks = this.callbacks.get(eventType);
    if (callbacks) {
      this.callbacks.set(eventType, callbacks.filter((cb) => cb !== callback));
    }
  }

  /**
   * Read new lines from a JSONL file
   */
  async readNewLines(filePath: string): Promise<JsonlMessage[]> {
    const lastOffset = this.watchedFiles.get(filePath) || 0;
    const lines = await this.readFileLines(filePath, lastOffset);

    if (lines.length > 0) {
      const newOffset = lastOffset + lines.join("\n").length;
      this.watchedFiles.set(filePath, newOffset);
    }

    return lines
      .filter((line) => line.trim())
      .map((line) => this.parseRawLine(line))
      .filter((msg): msg is JsonlMessage => msg !== null);
  }

  /**
   * Parse one raw JSONL line into a normalized JsonlMessage.
   *
   * Claude Code's JSONL schema (per-line):
   *   {
   *     type: "user" | "assistant" | "permission-mode" | "summary" | ...,
   *     uuid, timestamp, sessionId,
   *     message: { role, content: string | Array<{type, text?, ...}> }
   *   }
   *
   * Returns null for non-conversation entries (permission-mode, summary, etc.)
   * so they don't pollute the message store.
   */
  private parseRawLine(line: string): JsonlMessage | null {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      this.deps.log.warn(`Failed to parse JSONL line: ${err}`);
      return null;
    }

    // Filter to conversational entries only.
    if (raw?.type !== "user" && raw?.type !== "assistant") {
      return null;
    }

    // isMeta marks system-injected turns (local-command-caveat, system-reminder, etc.)
    // that are not real user inputs — drop them to avoid noise in the store.
    if (raw?.isMeta === true) {
      return null;
    }

    const msg = raw.message;
    if (!msg) {
      return null;
    }

    // Flatten content. It is either a string (typical user) or an array of
    // parts (typical assistant: text / tool_use / tool_result). We also keep
    // a structured copy of the parts in metadata for the Filter/Score layer.
    let content = "";
    const structuredParts: RawMessagePart[] = [];

    if (typeof msg.content === "string") {
      content = msg.content;
      structuredParts.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      const segments: string[] = [];
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") {
          segments.push(part.text);
          structuredParts.push({ type: "text", text: part.text });
        } else if (part.type === "tool_use") {
          const inputStr =
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input ?? {});
          segments.push(`[tool_use:${part.name ?? "?"}] ${inputStr}`);
          structuredParts.push({
            type: "tool_use",
            name: part.name ?? "",
            input: part.input,
            id: part.id,
          });
        } else if (part.type === "tool_result") {
          const resultStr =
            typeof part.content === "string"
              ? part.content
              : JSON.stringify(part.content ?? "");
          segments.push(`[tool_result] ${resultStr}`);
          structuredParts.push({
            type: "tool_result",
            content: part.content,
            is_error: part.is_error,
            tool_use_id: part.tool_use_id,
          });
        }
      }
      content = segments.join("\n");
    }

    if (!content) {
      // Nothing to store (e.g. assistant message that's purely a stop signal).
      return null;
    }

    const ts = raw.timestamp
      ? Date.parse(raw.timestamp) || Date.now()
      : Date.now();

    return {
      id: raw.uuid ?? `${raw.sessionId ?? "unknown"}-${ts}`,
      type: raw.type,
      role: msg.role ?? raw.type,
      content,
      timestamp: ts,
      metadata: {
        sessionId: raw.sessionId,
        parentUuid: raw.parentUuid,
        cwd: raw.cwd,
        isSidechain: raw.isSidechain === true,
        parts: structuredParts,
      },
    };
  }

  private async readFileLines(filePath: string, offset: number): Promise<string[]> {
    try {
      const content = await readFile(filePath, "utf-8");

      if (offset >= content.length) {
        return [];
      }

      const newContent = content.slice(offset);

      if (!newContent) {
        return [];
      }

      return newContent.split("\n").filter((line) => line.trim());
    } catch (error) {
      this.deps.log.warn(`Failed to read file ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Parse JSONL file from the beginning
   */
  async readAllLines(filePath: string): Promise<JsonlMessage[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());

      return lines
        .map((line) => this.parseRawLine(line))
        .filter((msg): msg is JsonlMessage => msg !== null);
    } catch (error) {
      this.deps.log.warn(`Failed to read file ${filePath}: ${error}`);
      return [];
    }
  }
}

export function createJsonlWatcher(
  deps: CodeMemoryDependencies,
  options: JsonlWatchOptions = {}
): CodeMemoryJsonlWatcher {
  return new CodeMemoryJsonlWatcher(deps, options);
}
