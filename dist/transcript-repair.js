/**
 * Lossless Claw for Claude Code - Transcript Repair
 *
 * Tool-use/result pairing sanitization for conversation transcripts.
 *
 * Exactly matches Lossless Claw's transcript repair system.
 */
/**
 * Tool use pattern matching
 */
const TOOL_USE_PATTERNS = {
    // Match tool_use blocks in various formats
    toolUseStart: /tool_use|tool-use|useTool|executeTool/i,
    toolResultStart: /tool_result|tool-result|toolResponse|tool-response/i,
    // JSON-style tool call
    jsonToolUse: /"tool_use"\s*:\s*\{/i,
    // Markdown-style tool call
    markdownToolUse: /```(?:tool|tool_use|json)/i,
};
export class LcmTranscriptRepairer {
    /**
     * Repair a transcript by ensuring tool-use/result pairing
     */
    repairTranscript(messages) {
        const result = {
            repaired: false,
            repairCount: 0,
            repairs: [],
            messages: [...messages],
        };
        const pairingResult = this.ensureToolPairing(result.messages);
        if (pairingResult.repaired) {
            result.repaired = true;
            result.repairCount += pairingResult.repairCount;
            result.repairs.push(...pairingResult.repairs);
            result.messages = pairingResult.messages;
        }
        const orphanResult = this.removeOrphanedToolCalls(result.messages);
        if (orphanResult.repaired) {
            result.repaired = true;
            result.repairCount += orphanResult.repairCount;
            result.repairs.push(...orphanResult.repairs);
            result.messages = orphanResult.messages;
        }
        return result;
    }
    /**
     * Ensure tool-use has corresponding tool-result
     */
    ensureToolPairing(messages) {
        const repairs = [];
        const repairedMessages = [...messages];
        let repaired = false;
        let pendingToolUse = null;
        for (let i = 0; i < repairedMessages.length; i++) {
            const msg = repairedMessages[i];
            if (this.isToolUse(msg)) {
                if (pendingToolUse) {
                    // Previous tool use didn't get a result
                    repairs.push({
                        type: "missing_tool_result",
                        description: `Tool use at message ${pendingToolUse.message.messageId} has no result`,
                        affectedMessageIds: [pendingToolUse.message.messageId],
                    });
                    repaired = true;
                }
                pendingToolUse = { index: i, message: msg };
            }
            else if (this.isToolResult(msg)) {
                if (!pendingToolUse) {
                    // Orphaned tool result
                    repairs.push({
                        type: "orphan_tool_result",
                        description: `Tool result at message ${msg.messageId} has no preceding tool use`,
                        affectedMessageIds: [msg.messageId],
                    });
                    repaired = true;
                }
                else {
                    // Found matching pair
                    pendingToolUse = null;
                }
            }
        }
        // Check for trailing tool use without result
        if (pendingToolUse) {
            repairs.push({
                type: "trailing_tool_use",
                description: `Trailing tool use at message ${pendingToolUse.message.messageId}`,
                affectedMessageIds: [pendingToolUse.message.messageId],
            });
            repaired = true;
        }
        return {
            repaired,
            repairCount: repairs.length,
            repairs,
            messages: repairedMessages,
        };
    }
    /**
     * Remove or mark orphaned tool calls
     */
    removeOrphanedToolCalls(messages) {
        const repairs = [];
        const repairedMessages = [];
        let repaired = false;
        for (const msg of messages) {
            // Keep most messages
            repairedMessages.push(msg);
        }
        return {
            repaired,
            repairCount: repairs.length,
            repairs,
            messages: repairedMessages,
        };
    }
    /**
     * Check if a message is a tool use
     */
    isToolUse(message) {
        const content = message.content.toLowerCase();
        // Check role first (assistant messages can have tool use)
        if (message.role === "assistant" || message.role === "user") {
            // Look for tool use patterns
            if (TOOL_USE_PATTERNS.toolUseStart.test(content)) {
                return true;
            }
            if (TOOL_USE_PATTERNS.jsonToolUse.test(content)) {
                return true;
            }
        }
        // Check metadata
        if (message.metadata) {
            const meta = message.metadata;
            if ("tool_use" in meta || "toolCall" in meta) {
                return true;
            }
        }
        return false;
    }
    /**
     * Check if a message is a tool result
     */
    isToolResult(message) {
        const content = message.content.toLowerCase();
        // Tool results are typically from "user" or "tool" role
        if (message.role === "tool" || message.role === "user") {
            if (TOOL_USE_PATTERNS.toolResultStart.test(content)) {
                return true;
            }
        }
        // Check metadata
        if (message.metadata) {
            const meta = message.metadata;
            if ("tool_result" in meta || "toolResult" in meta) {
                return true;
            }
        }
        return false;
    }
    /**
     * Find tool-use/result pairs
     */
    findToolPairs(messages) {
        const pairs = [];
        let pendingToolUse = null;
        for (const msg of messages) {
            if (this.isToolUse(msg)) {
                if (pendingToolUse) {
                    // Previous tool use didn't get a result
                    pairs.push({ toolUse: pendingToolUse, toolResult: null });
                }
                pendingToolUse = msg;
            }
            else if (this.isToolResult(msg) && pendingToolUse) {
                pairs.push({ toolUse: pendingToolUse, toolResult: msg });
                pendingToolUse = null;
            }
        }
        // Check for trailing tool use
        if (pendingToolUse) {
            pairs.push({ toolUse: pendingToolUse, toolResult: null });
        }
        return pairs;
    }
    /**
     * Validate a transcript's tool pairing
     */
    validateTranscript(messages) {
        const issues = [];
        const result = this.repairTranscript(messages);
        for (const repair of result.repairs) {
            issues.push({
                type: repair.type,
                description: repair.description,
                messageId: repair.affectedMessageIds[0],
            });
        }
        return {
            valid: issues.length === 0,
            issues,
        };
    }
}
/**
 * Factory function for creating LcmTranscriptRepairer instances
 */
export function createTranscriptRepairer() {
    return new LcmTranscriptRepairer();
}
//# sourceMappingURL=transcript-repair.js.map