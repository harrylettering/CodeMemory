/**
 * CodeMemory for Claude Code - JSONL File Watcher
 *
 * File monitoring for `~/.claude/projects/*.jsonl` with incremental message parsing.
 *
 * Exactly matches CodeMemory's JSONL watcher implementation.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
export class CodeMemoryJsonlWatcher {
    deps;
    options;
    watcher = null;
    watchedFiles = new Map(); // filePath -> lastProcessedOffset
    watchedFileStats = new Map(); // filePath -> { mtime, size }
    callbacks = new Map();
    pollTimer = null;
    isRunning = false;
    constructor(deps, options = {}) {
        this.deps = deps;
        this.options = options;
        this.options = {
            watchPath: this.options.watchPath || this.getDefaultWatchPath(),
            pollInterval: this.options.pollInterval || 5000,
            includePattern: this.options.includePattern || /\.jsonl$/,
            excludePattern: this.options.excludePattern,
        };
    }
    getDefaultWatchPath() {
        const home = process.env.HOME || process.env.USERPROFILE;
        if (!home) {
            throw new Error("HOME or USERPROFILE environment variable not set");
        }
        return join(home, ".claude", "projects");
    }
    /**
     * Start watching for JSONL files
     */
    async start() {
        if (this.isRunning) {
            this.deps.log.warn("JSONL watcher already running");
            return;
        }
        this.isRunning = true;
        this.deps.log.debug(`Starting JSONL watcher on ${this.options.watchPath}`);
        try {
            // Initial scan
            await this.scanDirectory();
        }
        catch (error) {
            this.deps.log.warn(`Initial scan failed: ${error}`);
        }
        // Start polling
        this.startPolling();
    }
    startPolling() {
        this.pollTimer = setInterval(() => this.poll(), this.options.pollInterval);
    }
    async poll() {
        if (!this.isRunning) {
            return;
        }
        try {
            await this.scanDirectory();
        }
        catch (error) {
            this.deps.log.debug(`Poll failed: ${error}`);
        }
    }
    /**
     * Scan the watch directory for changes
     */
    async scanDirectory() {
        const watchPath = this.options.watchPath;
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
        }
        catch (error) {
            if (error.code === "ENOENT") {
                this.deps.log.debug(`Watch directory not found: ${watchPath}`);
            }
            else {
                throw error;
            }
        }
    }
    /**
     * Check if a file should be watched
     */
    shouldWatchFile(filePath) {
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
    async checkFile(filePath) {
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
    notifyCallbacks(event) {
        const callbacks = this.callbacks.get(event.type) || [];
        for (const callback of callbacks) {
            try {
                callback(event);
            }
            catch (error) {
                this.deps.log.error(`Callback error: ${error}`);
            }
        }
        const allCallbacks = this.callbacks.get("*") || [];
        for (const callback of allCallbacks) {
            try {
                callback(event);
            }
            catch (error) {
                this.deps.log.error(`Callback error: ${error}`);
            }
        }
    }
    /**
     * Stop watching
     */
    stop() {
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
    on(eventType, callback) {
        const callbacks = this.callbacks.get(eventType) || [];
        callbacks.push(callback);
        this.callbacks.set(eventType, callbacks);
    }
    /**
     * Unregister a callback
     */
    off(eventType, callback) {
        const callbacks = this.callbacks.get(eventType);
        if (callbacks) {
            this.callbacks.set(eventType, callbacks.filter((cb) => cb !== callback));
        }
    }
    /**
     * Read new lines from a JSONL file
     */
    async readNewLines(filePath) {
        const lastOffset = this.watchedFiles.get(filePath) || 0;
        const lines = await this.readFileLines(filePath, lastOffset);
        if (lines.length > 0) {
            const newOffset = lastOffset + lines.join("\n").length;
            this.watchedFiles.set(filePath, newOffset);
        }
        return lines
            .filter((line) => line.trim())
            .map((line) => this.parseRawLine(line))
            .filter((msg) => msg !== null);
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
    parseRawLine(line) {
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch (err) {
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
        const structuredParts = [];
        if (typeof msg.content === "string") {
            content = msg.content;
            structuredParts.push({ type: "text", text: msg.content });
        }
        else if (Array.isArray(msg.content)) {
            const segments = [];
            for (const part of msg.content) {
                if (!part || typeof part !== "object")
                    continue;
                if (part.type === "text" && typeof part.text === "string") {
                    segments.push(part.text);
                    structuredParts.push({ type: "text", text: part.text });
                }
                else if (part.type === "tool_use") {
                    const inputStr = typeof part.input === "string"
                        ? part.input
                        : JSON.stringify(part.input ?? {});
                    segments.push(`[tool_use:${part.name ?? "?"}] ${inputStr}`);
                    structuredParts.push({
                        type: "tool_use",
                        name: part.name ?? "",
                        input: part.input,
                        id: part.id,
                    });
                }
                else if (part.type === "tool_result") {
                    const resultStr = typeof part.content === "string"
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
    async readFileLines(filePath, offset) {
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
        }
        catch (error) {
            this.deps.log.warn(`Failed to read file ${filePath}: ${error}`);
            return [];
        }
    }
    /**
     * Parse JSONL file from the beginning
     */
    async readAllLines(filePath) {
        try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n").filter((line) => line.trim());
            return lines
                .map((line) => this.parseRawLine(line))
                .filter((msg) => msg !== null);
        }
        catch (error) {
            this.deps.log.warn(`Failed to read file ${filePath}: ${error}`);
            return [];
        }
    }
}
export function createJsonlWatcher(deps, options = {}) {
    return new CodeMemoryJsonlWatcher(deps, options);
}
//# sourceMappingURL=jsonl-watcher.js.map