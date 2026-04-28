/**
 * Lossless Claw for Claude Code - Session Pattern Matching
 *
 * Session pattern matching utilities, exactly matching Lossless Claw.
 *
 * `*` matches any non-colon characters, while `**` can span colons.
 */
/**
 * Compile a session glob into a regex.
 *
 * `*` matches any non-colon characters, while `**` can span colons.
 */
export function compileSessionPattern(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^:]*")
        .replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`);
}
/**
 * Compile all configured ignore patterns once at startup.
 */
export function compileSessionPatterns(patterns) {
    return patterns.map((pattern) => compileSessionPattern(pattern));
}
/**
 * Check whether a session key matches any compiled ignore pattern.
 */
export function matchesSessionPattern(sessionKey, patterns) {
    return patterns.some((pattern) => pattern.test(sessionKey));
}
//# sourceMappingURL=session-patterns.js.map