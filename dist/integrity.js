/**
 * CodeMemory for Claude Code - DAG Integrity Checker
 *
 * DAG integrity checks and repair utilities.
 *
 * Exactly matches CodeMemory's integrity checking system.
 */
export class CodeMemoryIntegrityChecker {
    conversationStore;
    summaryStore;
    deps;
    constructor(conversationStore, summaryStore, deps) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.deps = deps;
    }
    /**
     * Check integrity of an entire conversation's DAG
     */
    async checkConversationIntegrity(conversationId) {
        const result = {
            isValid: true,
            issues: [],
            summariesChecked: 0,
            messagesChecked: 0,
            linksChecked: 0,
        };
        const summaries = await this.getSummariesForConversation(conversationId);
        result.summariesChecked = summaries.length;
        for (const summary of summaries) {
            const summaryIssues = await this.checkSummary(summary);
            result.issues.push(...summaryIssues);
        }
        const messageIssues = await this.checkMessages(conversationId);
        result.issues.push(...messageIssues);
        const linkIssues = await this.checkLinks(conversationId, summaries);
        result.issues.push(...linkIssues);
        result.isValid = result.issues.every((i) => i.severity !== "error");
        return result;
    }
    /**
     * Check a single summary
     */
    async checkSummary(summary) {
        const issues = [];
        // Check content
        if (!summary.content || summary.content.trim().length === 0) {
            issues.push({
                severity: "warning",
                type: "empty_summary_content",
                description: `Summary ${summary.summaryId} has empty content`,
                affectedIds: [summary.summaryId],
                repairable: false,
            });
        }
        // Check token count
        if (summary.tokenCount <= 0) {
            issues.push({
                severity: "warning",
                type: "invalid_token_count",
                description: `Summary ${summary.summaryId} has invalid token count: ${summary.tokenCount}`,
                affectedIds: [summary.summaryId],
                repairable: true,
            });
        }
        // Check depth
        if (summary.depth < 0) {
            issues.push({
                severity: "error",
                type: "invalid_depth",
                description: `Summary ${summary.summaryId} has invalid depth: ${summary.depth}`,
                affectedIds: [summary.summaryId],
                repairable: true,
            });
        }
        // Check leaf summaries have messages
        if (summary.kind === "leaf") {
            const messages = await this.summaryStore.getSummaryMessages(summary.summaryId);
            if (messages.length === 0) {
                issues.push({
                    severity: "warning",
                    type: "leaf_without_messages",
                    description: `Leaf summary ${summary.summaryId} has no linked messages`,
                    affectedIds: [summary.summaryId],
                    repairable: false,
                });
            }
        }
        // Check condensed summaries have children
        if (summary.kind === "condensed") {
            const parents = await this.summaryStore.getSummaryParents(summary.summaryId);
            if (parents.length === 0) {
                issues.push({
                    severity: "warning",
                    type: "condensed_without_children",
                    description: `Condensed summary ${summary.summaryId} has no child summaries`,
                    affectedIds: [summary.summaryId],
                    repairable: false,
                });
            }
        }
        return issues;
    }
    /**
     * Check messages
     */
    async checkMessages(conversationId) {
        const issues = [];
        const messages = await this.conversationStore.getMessagesByConversation(conversationId);
        for (const msg of messages) {
            if (!msg.content || msg.content.trim().length === 0) {
                issues.push({
                    severity: "info",
                    type: "empty_message_content",
                    description: `Message ${msg.messageId} has empty content`,
                    affectedIds: [`message_${msg.messageId}`],
                    repairable: false,
                });
            }
        }
        return issues;
    }
    /**
     * Check links between summaries and messages
     */
    async checkLinks(conversationId, summaries) {
        const issues = [];
        for (const summary of summaries) {
            // Check summary-message links
            if (summary.kind === "leaf") {
                const messageIds = await this.summaryStore.getSummaryMessages(summary.summaryId);
                for (const msgId of messageIds) {
                    const msg = await this.conversationStore.getMessageById(msgId);
                    if (!msg) {
                        issues.push({
                            severity: "error",
                            type: "missing_linked_message",
                            description: `Summary ${summary.summaryId} links to missing message ${msgId}`,
                            affectedIds: [summary.summaryId, `message_${msgId}`],
                            repairable: true,
                        });
                    }
                }
            }
            // Check parent-child links
            if (summary.kind === "condensed") {
                const childSummaries = await this.summaryStore.getSummaryParents(summary.summaryId);
                for (const child of childSummaries) {
                    const childExists = await this.summaryStore.getSummary(child.summaryId);
                    if (!childExists) {
                        issues.push({
                            severity: "error",
                            type: "missing_linked_summary",
                            description: `Summary ${summary.summaryId} links to missing summary ${child.summaryId}`,
                            affectedIds: [summary.summaryId, child.summaryId],
                            repairable: true,
                        });
                    }
                }
            }
        }
        return issues;
    }
    /**
     * Get all summaries for a conversation
     */
    async getSummariesForConversation(conversationId) {
        const records = await this.summaryStore.getDatabase().all("SELECT * FROM summaries WHERE conversationId = ?", conversationId);
        return records.map((record) => ({
            summaryId: record.summaryId,
            conversationId: record.conversationId,
            kind: record.kind,
            depth: record.depth,
            earliestAt: record.earliestAt,
            latestAt: record.latestAt,
            descendantCount: record.descendantCount,
            tokenCount: record.tokenCount,
            content: record.content,
            createdAt: record.createdAt,
        }));
    }
    /**
     * Attempt to repair integrity issues
     */
    async repairIntegrity(conversationId, issues) {
        const result = {
            success: true,
            issuesRepaired: 0,
            issuesRemaining: 0,
            repairs: [],
        };
        const repairableIssues = issues.filter((i) => i.repairable);
        const unrepairableIssues = issues.filter((i) => !i.repairable);
        result.issuesRemaining = unrepairableIssues.length;
        for (const issue of repairableIssues) {
            let repaired = false;
            switch (issue.type) {
                case "invalid_token_count":
                    repaired = await this.repairTokenCount(issue);
                    break;
                case "invalid_depth":
                    repaired = await this.repairDepth(issue);
                    break;
                case "missing_linked_message":
                case "missing_linked_summary":
                    repaired = await this.repairMissingLink(issue);
                    break;
            }
            if (repaired) {
                result.issuesRepaired++;
                result.repairs.push({
                    issueType: issue.type,
                    description: issue.description,
                    affectedIds: issue.affectedIds,
                });
            }
            else {
                result.issuesRemaining++;
            }
        }
        result.success = result.issuesRemaining === 0 ||
            !issues.some((i) => i.severity === "error" && i.repairable);
        return result;
    }
    async repairTokenCount(issue) {
        // Estimate token count from content
        const summaryId = issue.affectedIds[0];
        const summary = await this.summaryStore.getSummary(summaryId);
        if (!summary)
            return false;
        const estimatedTokens = Math.ceil(summary.content.length / 4);
        await this.summaryStore.getDatabase().run("UPDATE summaries SET tokenCount = ? WHERE summaryId = ?", [estimatedTokens, summaryId]);
        return true;
    }
    async repairDepth(issue) {
        const summaryId = issue.affectedIds[0];
        await this.summaryStore.getDatabase().run("UPDATE summaries SET depth = 0 WHERE summaryId = ?", [summaryId]);
        return true;
    }
    async repairMissingLink(issue) {
        // Remove orphaned links
        const [summaryId, targetId] = issue.affectedIds;
        if (issue.type === "missing_linked_message") {
            await this.summaryStore.getDatabase().run("DELETE FROM summary_messages WHERE summaryId = ? AND messageId = ?", [summaryId, parseInt(targetId.replace("message_", ""), 10)]);
        }
        else {
            await this.summaryStore.getDatabase().run("DELETE FROM summary_parents WHERE summaryId = ? AND parentSummaryId = ?", [summaryId, targetId]);
        }
        return true;
    }
}
/**
 * Factory function for creating CodeMemoryIntegrityChecker instances
 */
export function createIntegrityChecker(conversationStore, summaryStore, deps) {
    return new CodeMemoryIntegrityChecker(conversationStore, summaryStore, deps);
}
//# sourceMappingURL=integrity.js.map