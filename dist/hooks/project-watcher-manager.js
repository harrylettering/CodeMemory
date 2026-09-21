/**
 * CodeMemory - Project Watcher Manager
 *
 * Manages per-project JSONL watchers:
 * - Converts project path to dashed directory name
 * - Starts/stops watchers on SessionStart/SessionEnd
 * - Only watches the current project's directory
 */
import { createJsonlWatcher } from "./jsonl-watcher.js";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
// Store watchers by session ID
const watchersBySession = new Map();
export class ProjectWatcher {
    deps;
    options;
    watcher;
    isRunning = false;
    projectWatchPath;
    constructor(deps, options) {
        this.deps = deps;
        this.options = options;
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
        this.watcher = createJsonlWatcher({ log: deps }, {
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
    pathToDashedDir(projectPath) {
        let dashed = projectPath.replace(/^\//, "").replace(/[\/_]/g, "-");
        if (!dashed.startsWith("-")) {
            dashed = "-" + dashed;
        }
        return dashed;
    }
    async start() {
        if (this.isRunning) {
            this.deps.warn("Project watcher already running");
            return;
        }
        // Set up event handlers
        this.watcher.on("create", async (event) => {
            this.deps.info(`[ProjectWatcher] New file: ${event.filePath}`);
            await this.handleNewFile(event.filePath);
        });
        this.watcher.on("update", async (event) => {
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
    async stop() {
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
    get watchDirectory() {
        return this.projectWatchPath;
    }
    /**
     * Move the read position to the end of a file. Used after a re-import has
     * replayed it in full, so the next poll does not re-emit the same lines.
     */
    async markFileConsumed(filePath) {
        const length = await this.watcher.currentLength(filePath);
        this.watcher.seedOffset(filePath, length);
        // Persist it too, or a restart after a re-import would replay the whole
        // transcript the re-import just finished replaying.
        await this.persistOffset(filePath);
    }
    /** Full parse of one transcript, used by the re-import path. */
    async readAllMessages(filePath) {
        return this.watcher.readAllLines(filePath);
    }
    /**
     * Reload stored read positions.
     *
     * A file shorter than its stored offset was truncated or rewritten, so the
     * offset no longer points at a line boundary and reading from it would slice
     * a record in half. Those reset to 0 and are read in full.
     */
    async restoreOffsets() {
        const restored = new Set();
        if (!this.options.offsetStore)
            return restored;
        let stored;
        try {
            stored = await this.options.offsetStore.load();
        }
        catch (error) {
            this.deps.warn(`[ProjectWatcher] Could not load stored offsets: ${error}`);
            return restored;
        }
        let rewound = 0;
        for (const [filePath, charOffset] of stored) {
            if (!filePath.startsWith(this.projectWatchPath))
                continue;
            const length = await this.watcher.currentLength(filePath);
            if (length <= 0)
                continue;
            if (charOffset > length) {
                this.watcher.seedOffset(filePath, 0);
                rewound++;
            }
            else {
                this.watcher.seedOffset(filePath, charOffset);
            }
            restored.add(filePath);
        }
        if (restored.size > 0) {
            this.deps.info(`[ProjectWatcher] Resumed ${restored.size} transcript(s) from stored offsets` +
                (rewound > 0 ? `; ${rewound} rewound after truncation` : ""));
        }
        return restored;
    }
    async seedExistingFiles(restored = new Set()) {
        let entries = [];
        try {
            entries = await readdir(this.projectWatchPath);
        }
        catch (error) {
            this.deps.warn(`[ProjectWatcher] Could not list ${this.projectWatchPath}: ${error}`);
            return;
        }
        const candidates = entries
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(this.projectWatchPath, name));
        // The watcher also reads `<sessionId>/subagents/agent-*.jsonl`, so those
        // have to be written off too. Listing only the top level meant the first
        // daemon on a session with existing subagents read every one of them from
        // byte 0 -- 46 rows on the first 0.6.0 start, all already stored. Only
        // this session's directory: no other is read, so none needs seeding.
        const subagentDir = join(this.projectWatchPath, this.options.sessionId, "subagents");
        try {
            for (const name of await readdir(subagentDir)) {
                if (name.endsWith(".jsonl"))
                    candidates.push(join(subagentDir, name));
            }
        }
        catch {
            // No subagents in this session yet.
        }
        let seeded = 0;
        for (const filePath of candidates) {
            if (restored.has(filePath))
                continue;
            const length = await this.watcher.currentLength(filePath);
            if (length > 0) {
                this.watcher.seedOffset(filePath, length);
                seeded++;
            }
        }
        if (seeded > 0) {
            this.deps.info(`[ProjectWatcher] Treating ${seeded} existing transcript(s) as already ingested; use the re-import command to backfill`);
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
    async persistOffset(filePath) {
        if (!this.options.offsetStore)
            return;
        try {
            await this.options.offsetStore.save(filePath, this.watcher.getOffset(filePath));
        }
        catch (error) {
            this.deps.warn(`[ProjectWatcher] Could not persist offset: ${error}`);
        }
    }
    async handleNewFile(filePath) {
        // IMPORTANT: use readNewLines (not readAllLines) here so the offset map
        // gets advanced. Otherwise the next poll will re-emit every line via
        // readNewLines starting from offset 0, causing the entire prefix of the
        // file to be ingested twice.
        try {
            const messages = await this.watcher.readNewLines(filePath);
            this.deps.debug(`[ProjectWatcher] Read ${messages.length} messages from ${filePath}`);
            await this.dispatchMessages(messages, filePath);
            await this.persistOffset(filePath);
        }
        catch (error) {
            this.deps.error(`[ProjectWatcher] Failed to handle new file: ${error}`);
        }
    }
    async handleFileUpdate(filePath) {
        try {
            const newMessages = await this.watcher.readNewLines(filePath);
            if (newMessages.length > 0) {
                this.deps.debug(`[ProjectWatcher] Read ${newMessages.length} new messages from ${filePath}`);
                await this.dispatchMessages(newMessages, filePath);
                await this.persistOffset(filePath);
            }
        }
        catch (error) {
            this.deps.error(`[ProjectWatcher] Failed to handle file update: ${error}`);
        }
    }
    /**
     * Dispatch messages to the onMessage callback **sequentially**. Awaiting
     * each call is essential: ConversationStore.insertMessage computes the
     * next seq via SELECT MAX(seq), and concurrent inserts would race and
     * collide on the same seq value.
     */
    async dispatchMessages(messages, filePath) {
        if (!this.options.onMessage)
            return;
        for (const msg of messages) {
            try {
                await this.options.onMessage(msg, filePath);
            }
            catch (err) {
                this.deps.error(`[ProjectWatcher] onMessage callback failed: ${err}`);
            }
        }
    }
    getWatchPath() {
        return this.projectWatchPath;
    }
    isActive() {
        return this.isRunning;
    }
}
/**
 * Start a project watcher for a session
 */
export async function startProjectWatcher(deps, options) {
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
export async function stopProjectWatcher(sessionId) {
    const watcher = watchersBySession.get(sessionId);
    if (watcher) {
        await watcher.stop();
        watchersBySession.delete(sessionId);
    }
}
/**
 * Get a project watcher for a session
 */
export function getProjectWatcher(sessionId) {
    return watchersBySession.get(sessionId);
}
//# sourceMappingURL=project-watcher-manager.js.map