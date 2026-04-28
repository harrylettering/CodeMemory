/**
 * Filter/Score Layer — entry point.
 *
 * Decides, for each parsed JsonlMessage, which tier it belongs to and what
 * representation to persist. Tier semantics (see IMPLEMENTATION_PLAN_v2.md §3.3):
 *
 *   S — skeleton, store full text          (user prompts, decisions, errors)
 *   M — metadata only                       (Edit/Write/Bash etc.)
 *   L — fact only, no payload               (Read/Glob/Grep results)
 *   N — noise, drop                         (duplicates, sidechain internals)
 *
 * Scoring is a pure function of the message plus a small piece of session
 * state (passed in by the caller) used to detect repeated exploration.
 */
import { applyCodingRules } from "./rules-coding.js";
/**
 * Duration within which a repeat of the same exploration target is
 * considered "already explored" and degraded to N. Past the window the
 * file/pattern may have changed, so re-reading is legitimate signal.
 *
 * Exposed as a knob through `CodeMemoryConfig.exploredTargetWindowMs`; this is
 * the default (30 minutes) when no config is threaded through.
 */
export const DEFAULT_EXPLORED_TARGET_WINDOW_MS = 30 * 60 * 1000;
/**
 * Cap on the in-memory `exploredTargets` map. When exceeded, we drop the
 * oldest ~10% by `lastSeenAt`. The window already bounds logical lifetime
 * but a very busy session could otherwise grow the map unboundedly
 * between flushes.
 */
export const EXPLORED_TARGETS_CAP = 10_000;
/**
 * FIFO cap for `toolUseTiers`. Long sessions can accumulate thousands of
 * tool_use ids; we only need the recent window because a tool_result
 * follows its tool_use within a few turns.
 */
export const TOOL_USE_TIER_CAP = 2000;
export function createSessionState() {
    return {
        exploredTargets: new Map(),
        _dirtyTargets: new Set(),
        toolUseTiers: new Map(),
    };
}
/**
 * Record an exploration target with the current timestamp. Manages the
 * FIFO cap and the dirty set so callers don't have to.
 */
export function touchExploredTarget(state, target, nowMs) {
    if (state.exploredTargets.size >= EXPLORED_TARGETS_CAP) {
        const entries = Array.from(state.exploredTargets.entries());
        entries.sort((a, b) => a[1] - b[1]);
        const drop = Math.floor(EXPLORED_TARGETS_CAP / 10);
        for (let i = 0; i < drop; i++) {
            state.exploredTargets.delete(entries[i][0]);
        }
    }
    state.exploredTargets.set(target, nowMs);
    state._dirtyTargets.add(target);
}
/**
 * Record a tool_use's classification keyed by its id. Applies FIFO eviction
 * at the cap to keep memory bounded across long-running sessions.
 */
export function recordToolUseTier(state, id, tier, toolName) {
    if (!id)
        return;
    if (state.toolUseTiers.size >= TOOL_USE_TIER_CAP) {
        const dropCount = Math.floor(TOOL_USE_TIER_CAP / 10);
        const iter = state.toolUseTiers.keys();
        for (let i = 0; i < dropCount; i++) {
            const next = iter.next();
            if (next.done)
                break;
            state.toolUseTiers.delete(next.value);
        }
    }
    state.toolUseTiers.set(id, { tier, toolName });
}
/**
 * Score a single message. The state object may be mutated to record
 * exploration history; `state._dirtyTargets` collects any targets the
 * caller should persist.
 */
export function scoreMessage(msg, state, options = {}) {
    // Sidechain (subagent internal turns) are pure noise from the parent
    // session's perspective. Only the final assistant return inside the
    // parent session matters.
    if (msg.metadata?.isSidechain) {
        return { tier: "N", tags: ["sidechain"], content: "" };
    }
    return applyCodingRules(msg, state, {
        nowMs: options.nowMs ?? Date.now(),
        exploredTargetWindowMs: options.exploredTargetWindowMs ?? DEFAULT_EXPLORED_TARGET_WINDOW_MS,
    });
}
//# sourceMappingURL=scorer.js.map