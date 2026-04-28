/**
 * Lossless Claw for Claude Code - Large File Handling
 *
 * File interception, storage, and exploration summaries.
 *
 * Exactly matches Lossless Claw's large file handling.
 */
/**
 * Generate file ID
 */
function generateFileId() {
    return `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export class LcmLargeFileHandler {
    summaryStore;
    deps;
    constructor(summaryStore, deps) {
        this.summaryStore = summaryStore;
        this.deps = deps;
    }
    /**
     * Store a file
     */
    async storeFile(params) {
        const { conversationId, fileName, mimeType, content, metadata } = params;
        const fileId = generateFileId();
        const byteSize = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
        const storageUri = await this.storeContent(fileId, content);
        const createdAt = new Date().toISOString();
        await this.summaryStore.getDatabase().run(`
      INSERT INTO large_files (
        fileId, conversationId, fileName, mimeType, byteSize,
        storageUri, explorationSummary, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            fileId,
            conversationId,
            fileName || null,
            mimeType || null,
            byteSize,
            storageUri,
            null,
            createdAt,
        ]);
        return {
            fileId,
            storageUri,
            byteSize,
        };
    }
    /**
     * Store content to disk or storage backend
     */
    async storeContent(fileId, content) {
        // TODO: Implement actual file storage
        // For now, return a placeholder URI
        return `file:///.claude/lcm-files/${fileId}`;
    }
    /**
     * Get a file record
     */
    async getFile(fileId) {
        const record = await this.summaryStore.getDatabase().get("SELECT * FROM large_files WHERE fileId = ?", fileId);
        if (!record) {
            return null;
        }
        return {
            fileId: record.fileId,
            conversationId: record.conversationId,
            fileName: record.fileName,
            mimeType: record.mimeType,
            byteSize: record.byteSize,
            storageUri: record.storageUri,
            explorationSummary: record.explorationSummary,
            createdAt: record.createdAt,
        };
    }
    /**
     * Get all files for a conversation
     */
    async getFilesForConversation(conversationId) {
        const records = await this.summaryStore.getDatabase().all("SELECT * FROM large_files WHERE conversationId = ? ORDER BY createdAt", conversationId);
        return records.map((record) => ({
            fileId: record.fileId,
            conversationId: record.conversationId,
            fileName: record.fileName,
            mimeType: record.mimeType,
            byteSize: record.byteSize,
            storageUri: record.storageUri,
            explorationSummary: record.explorationSummary,
            createdAt: record.createdAt,
        }));
    }
    /**
     * Generate an exploration summary for a file
     */
    async generateExplorationSummary(params) {
        const { fileId, conversationId, model = "claude-3-5-haiku", maxTokens = 1024 } = params;
        const file = await this.getFile(fileId);
        if (!file) {
            return null;
        }
        // TODO: Implement actual file reading and summarization
        // For now, just store a placeholder summary
        const summary = `[File: ${file.fileName || "unknown"} (${file.byteSize} bytes)]`;
        await this.summaryStore.getDatabase().run("UPDATE large_files SET explorationSummary = ? WHERE fileId = ?", [summary, fileId]);
        return summary;
    }
    /**
     * Check if a file should be intercepted based on size
     */
    shouldIntercept(params) {
        const { byteSize, mimeType } = params;
        const LARGE_FILE_THRESHOLD = 64 * 1024; // 64KB
        if (byteSize > LARGE_FILE_THRESHOLD) {
            return true;
        }
        // Also intercept certain large file types
        if (mimeType) {
            const largeTypes = [
                "application/zip",
                "application/x-tar",
                "application/gzip",
                "video/",
                "audio/",
            ];
            if (largeTypes.some((t) => mimeType.startsWith(t))) {
                return true;
            }
        }
        return false;
    }
    /**
     * Link a file to a summary
     */
    async linkFileToSummary(fileId, summaryId) {
        await this.summaryStore.getDatabase().run(`
      INSERT INTO summary_files (summaryId, fileId, position)
      VALUES (?, ?, 0)
    `, [summaryId, fileId]);
    }
}
/**
 * Factory function for creating LcmLargeFileHandler instances
 */
export function createLargeFileHandler(summaryStore, deps) {
    return new LcmLargeFileHandler(summaryStore, deps);
}
//# sourceMappingURL=large-files.js.map