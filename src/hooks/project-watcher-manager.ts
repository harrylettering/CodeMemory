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
import { readdir } from "node:fs/promises";

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

  /**
   * Treat transcripts already on disk when the watcher starts as handled,
   * ingesting only what arrives afterwards.
   *
   * The offset map is process-local, so without this a restart rewinds every
   * file in the project directory to 0 and re-emits its whole prefix. Nothing
   * dedupes on the way in, so those lines become duplicate rows. Files created
   * after start are unaffected — they are genuinely new and read from 0.
   */
  seedExistingFilesToEnd?: boolean;

  /**
   * Durable read positions, supplied by the daemon.
   *
   * The watcher stays a stateless transformer: it accepts an initial offset
   * and reports progress back, and never touches the database itself. When
   * this is absent the watcher behaves exactly as before.
   */
  offsetStore?: WatcherOffsetStore;
}

export interface WatcherOffsetStore {
  /** Every known read position, keyed by absolute file path. */
  load(): Promise<Map<string, number>>;
  save(filePath: string, charOffset: number): Promise<void>;
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
      // The watch path is the project's, shared by every session in it, while
      // this process serves one. Without the scope each daemon read every
      // transcript in the directory, so N sessions in a project parsed, scored
      // and ingested each line N times.
      sessionScope: options.sessionId,
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

    // Restore first, then seed. Seeding only covers what has no stored
    // position, so a known file continues where it stopped instead of being
    // written off as already handled.
    const restored = await this.restoreOffsets();

    if (this.options.seedExistingFilesToEnd) {
      await this.seedExistingFiles(restored);
    }

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

  /**
   * Mark every transcript present right now as fully read. Done before the
   * underlying watcher starts, so the initial scan reports no backlog.
   */
  /** Directory this watcher observes, so callers can locate a transcript. */
  get watchDirectory(): string {
    return this.projectWatchPath;
  }

  /**
   * Move the read position to the end of a file. Used after a re-import has
   * replayed it in full, so the next poll does not re-emit the same lines.
   */
  async markFileConsumed(filePath: string): Promise<void> {
    const length = await this.watcher.currentLength(filePath);
    this.watcher.seedOffset(filePath, length);
    // Persist it too, or a restart after a re-import would replay the whole
    // transcript the re-import just finished replaying.
    await this.persistOffset(filePath);
  }

  /** Full parse of one transcript, used by the re-import path. */
  async readAllMessages(filePath: string): Promise<JsonlMessage[]> {
    return this.watcher.readAllLines(filePath);
  }

  /**
   * Reload stored read positions.
   *
   * A file shorter than its stored offset was truncated or rewritten, so the
   * offset no longer points at a line boundary and reading from it would slice
   * a record in half. Those reset to 0 and are read in full.
   */
  private async restoreOffsets(): Promise<Set<string>> {
    const restored = new Set<string>();
    if (!this.options.offsetStore) return restored;

    let stored: Map<string, number>;
    try {
      stored = await this.options.offsetStore.load();
    } catch (error) {
      this.deps.warn(`[ProjectWatcher] Could not load stored offsets: ${error}`);
      return restored;
    }

    let rewound = 0;
    for (const [filePath, charOffset] of stored) {
      if (!filePath.startsWith(this.projectWatchPath)) continue;
      const length = await this.watcher.currentLength(filePath);
      if (length <= 0) continue;
      if (charOffset > length) {
        this.watcher.seedOffset(filePath, 0);
        rewound++;
      } else {
        this.watcher.seedOffset(filePath, charOffset);
      }
      restored.add(filePath);
    }

    if (restored.size > 0) {
      this.deps.info(
        `[ProjectWatcher] Resumed ${restored.size} transcript(s) from stored offsets` +
          (rewound > 0 ? `; ${rewound} rewound after truncation` : "")
      );
    }
    return restored;
  }

  private async seedExistingFiles(restored: Set<string> = new Set()): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.projectWatchPath);
    } catch (error) {
      this.deps.warn(`[ProjectWatcher] Could not list ${this.projectWatchPath}: ${error}`);
      return;
    }

    let seeded = 0;
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(this.projectWatchPath, name);
      if (restored.has(filePath)) continue;
      const length = await this.watcher.currentLength(filePath);
      if (length > 0) {
        this.watcher.seedOffset(filePath, length);
        seeded++;
      }
    }

    if (seeded > 0) {
      this.deps.info(
        `[ProjectWatcher] Treating ${seeded} existing transcript(s) as already ingested; use the re-import command to backfill`
      );
    }
  }

  /**
   * Record the read position after a batch has been dispatched, not before.
   *
   * A crash between the two therefore re-reads that batch on the next start,
   * which costs at most one poll interval of duplicate rows. Saving first
   * would drop the batch instead. Re-reading is the recoverable direction;
   * losing the messages is not, and losing them is exactly the failure this
   * table exists to prevent.
   */
  private async persistOffset(filePath: string): Promise<void> {
    if (!this.options.offsetStore) return;
    try {
      await this.options.offsetStore.save(
        filePath,
        this.watcher.getOffset(filePath)
      );
    } catch (error) {
      this.deps.warn(`[ProjectWatcher] Could not persist offset: ${error}`);
    }
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
      await this.persistOffset(filePath);
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
        await this.persistOffset(filePath);
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
