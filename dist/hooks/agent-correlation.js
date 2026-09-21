/**
 * Which agent triggered a given tool call.
 *
 * A subagent can write memory -- codememory_mark_decision is a tool like any
 * other -- and nothing about the write says who made it. Two routes to that
 * answer are closed:
 *
 *   - The environment cannot say. A subagent's CLAUDE_* variables are
 *     byte-identical to the main agent's, so a shell script curling the daemon
 *     has no way to learn its own identity.
 *
 *   - A "current agent" field on the daemon is wrong by construction. Two
 *     subagents dispatched in one turn run concurrently, and whichever wrote
 *     last would claim both their marks.
 *
 * Correlation on a key both sides already carry does work. PreToolUse receives
 * `tool_use_id` next to `agent_id`; the mark payload already carries
 * `sourceToolUseId` as an idempotency key. Recording the pair when the call is
 * announced and reading it back when the write arrives attributes each write to
 * its own caller, concurrently, with no shared mutable state.
 *
 * Absence is the main agent. PreToolUse carries no `agent_id` for main-agent
 * calls, so nothing is recorded and the lookup misses -- which is the correct
 * answer, not a failure. A sentinel would turn the main agent into a subagent
 * named "unknown".
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
export class AgentCorrelationTable {
    entries = new Map();
    ttlMs;
    maxEntries;
    now;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.now = options.now ?? (() => Date.now());
    }
    record(toolUseId, identity) {
        if (!toolUseId || !identity?.agentId)
            return;
        // Re-inserting moves the key to the end, which is what makes the eviction
        // below drop the least recently recorded rather than an arbitrary one.
        this.entries.delete(toolUseId);
        this.entries.set(toolUseId, { identity, at: this.now() });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next();
            if (oldest.done)
                break;
            this.entries.delete(oldest.value);
        }
    }
    lookup(toolUseId) {
        if (!toolUseId)
            return undefined;
        const hit = this.entries.get(toolUseId);
        if (!hit)
            return undefined;
        if (this.now() - hit.at > this.ttlMs) {
            this.entries.delete(toolUseId);
            return undefined;
        }
        return hit.identity;
    }
    get size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=agent-correlation.js.map