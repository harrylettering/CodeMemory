/**
 * CodeMemory - Project Watcher Manager
 *
 * Manages per-project JSONL watchers:
 * - Converts project path to dashed directory name
 * - Starts/stops watchers on SessionStart/SessionEnd
 * - Only watches the current project's directory
 */

import { CodeMemoryJsonlWatcher, createJsonlWatcher, FileWatchEvent, JsonlMessage } from "./jsonl-watcher.js";
import { join } from "node:path";

// Logger interface
interface SimpleLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// Store watchers by session ID
const watchersBySession = new Map<string, ProjectWatcher>();

export interface ProjectWatcherOptions {
  projectPath: string;
  sessionId: string;
  pollInterval?: number;
  onMessage?: (message: JsonlMessage, filePath: string) => void;
}

export class ProjectWatcher {
  private watcher: CodeMemoryJsonlWatcher;
  private isRunning = false;
  private projectWatchPath: string;

  constructor(
    private deps: SimpleLogger,
    private options: ProjectWatcherOptions
  ) {
    // Convert project path to dashed directory name
    const dashedDirName = this.pathToDashedDir(options.projectPath);
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) {
      throw new Error("HOME or USERPROFILE environment variable not set");
    }

    this.projectWatchPath = join(home, ".claude", "projects", dashedDirName);
    this.deps.info(`Project watch path: ${this.projectWatchPath}`);

    // CodeMemoryJsonlWatcher expects deps.log.* (nested); our SimpleLogger is flat.
    // Wrap it so deps.log.debug(...) resolves correctly.
    this.watcher = createJsonlWatcher({ log: deps } as any, {
      watchPath: this.projectWatchPath,
      pollInterval: options.pollInterval || 2000,
    });
  }

  /**
   * Convert absolute path to Claude Code's dashed project directory name.
   *
   * Claude Code normalizes BOTH "/" and "_" into "-". Example:
   *   "/Users/harlihao/claude_project/claude-log-visualization"
   *   → "-Users-harlihao-claude-project-claude-log-visualization"
   *
   * The previous implementation only replaced "/", which caused watch paths
   * under directories containing underscores (e.g. "claude_project") to miss
   * the real directory under ~/.claude/projects.
   */
  private pathToDashedDir(projectPath: string): string {
    let dashed = projectPath.replace(/^\//, "").replace(/[\/_]/g, "-");
    if (!dashed.startsWith("-")) {
      dashed = "-" + dashed;
    }
    return dashed;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.deps.warn("Project watcher already running");
      return;
    }

    // Set up event handlers
    this.watcher.on("create", async (event: FileWatchEvent) => {
      this.deps.info(`[ProjectWatcher] New file: ${event.filePath}`);
      await this.handleNewFile(event.filePath);
    });

    this.watcher.on("update", async (event: FileWatchEvent) => {
      this.deps.debug(`[ProjectWatcher] File updated: ${event.filePath}`);
      await this.handleFileUpdate(event.filePath);
    });

    await this.watcher.start();
    this.isRunning = true;
    this.deps.info(`[ProjectWatcher] Started for ${this.options.projectPath}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.watcher.stop();
    this.isRunning = false;
    this.deps.info(`[ProjectWatcher] Stopped for ${this.options.projectPath}`);
  }

  private async handleNewFile(filePath: string): Promise<void> {
    // IMPORTANT: use readNewLines (not readAllLines) here so the offset map
    // gets advanced. Otherwise the next poll will re-emit every line via
    // readNewLines starting from offset 0, causing the entire prefix of the
    // file to be ingested twice.
    try {
      const messages = await this.watcher.readNewLines(filePath);
      this.deps.debug(`[ProjectWatcher] Read ${messages.length} messages from ${filePath}`);
      await this.dispatchMessages(messages, filePath);
    } catch (error) {
      this.deps.error(`[ProjectWatcher] Failed to handle new file: ${error}`);
    }
  }

  private async handleFileUpdate(filePath: string): Promise<void> {
    try {
      const newMessages = await this.watcher.readNewLines(filePath);
      if (newMessages.length > 0) {
        this.deps.debug(`[ProjectWatcher] Read ${newMessages.length} new messages from ${filePath}`);
        await this.dispatchMessages(newMessages, filePath);
      }
    } catch (error) {
      this.deps.error(`[ProjectWatcher] Failed to handle file update: ${error}`);
    }
  }

  /**
   * Dispatch messages to the onMessage callback **sequentially**. Awaiting
   * each call is essential: ConversationStore.insertMessage computes the
   * next seq via SELECT MAX(seq), and concurrent inserts would race and
   * collide on the same seq value.
   */
  private async dispatchMessages(
    messages: JsonlMessage[],
    filePath: string
  ): Promise<void> {
    if (!this.options.onMessage) return;
    for (const msg of messages) {
      try {
        await this.options.onMessage(msg, filePath);
      } catch (err) {
        this.deps.error(`[ProjectWatcher] onMessage callback failed: ${err}`);
      }
    }
  }

  getWatchPath(): string {
    return this.projectWatchPath;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

/**
 * Start a project watcher for a session
 */
export async function startProjectWatcher(
  deps: SimpleLogger,
  options: ProjectWatcherOptions
): Promise<ProjectWatcher> {
  // Stop existing watcher for this session if any
  const existing = watchersBySession.get(options.sessionId);
  if (existing) {
    await existing.stop();
  }

  const watcher = new ProjectWatcher(deps, options);
  await watcher.start();
  watchersBySession.set(options.sessionId, watcher);
  return watcher;
}

/**
 * Stop a project watcher for a session
 */
export async function stopProjectWatcher(sessionId: string): Promise<void> {
  const watcher = watchersBySession.get(sessionId);
  if (watcher) {
    await watcher.stop();
    watchersBySession.delete(sessionId);
  }
}

/**
 * Get a project watcher for a session
 */
export function getProjectWatcher(sessionId: string): ProjectWatcher | undefined {
  return watchersBySession.get(sessionId);
}
