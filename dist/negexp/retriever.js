/**
 * NegExp retriever — queries by the dimensions PreToolUse actually has at
 * its disposal: filePath, command, signature, symbol. Queries are
 * cross-session by default; pass `sessionId` to scope down.
 */
export class NegExpRetriever {
    store;
    constructor(store) {
        this.store = store;
    }
    get db() {
        return this.store.db;
    }
    /**
     * Look up past failures for a specific file path. Used by PreToolUse on
     * Edit/Write/Read targets. Cross-session by default.
     */
    async retrieveByFilePath(filePath, opts = {}) {
        if (!filePath)
            return [];
        const limit = opts.limit ?? 3;
        const includeResolved = opts.includeResolved === true;
        const conds = ["filePath = ?"];
        const params = [filePath];
        if (!includeResolved)
            conds.push("resolved = 0");
        if (opts.sessionId) {
            conds.push("sessionId = ?");
            params.push(opts.sessionId);
        }
        params.push(limit);
        return await this.db.all(`SELECT * FROM negative_experiences
        WHERE ${conds.join(" AND ")}
        ORDER BY weight DESC, seq DESC
        LIMIT ?`, params);
    }
    /**
     * Look up past failures for a Bash command. Prefers a TWO-token prefix
     * match ("npm test", "git push", "cargo build") so we don't surface
     * "git push" failures when the user runs "git status". Falls back to
     * the leading token only when the command is a single word.
     *
     * This is the #19 noise-control fix: leading-token-only matching was
     * too aggressive and produced unrelated warnings.
     */
    async retrieveByCommand(command, opts = {}) {
        if (!command)
            return [];
        const limit = opts.limit ?? 3;
        const includeResolved = opts.includeResolved === true;
        const tokens = command.trim().split(/\s+/);
        if (tokens.length === 0 || !tokens[0])
            return [];
        // Two-token prefix when we have one, e.g. "npm test%". Otherwise the
        // single token. The retriever's caller (lookup.ts) further gates the
        // result by confidence.
        const prefix = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}%` : `${tokens[0]}%`;
        const conds = ["command LIKE ?"];
        const params = [prefix];
        if (!includeResolved)
            conds.push("resolved = 0");
        if (opts.sessionId) {
            conds.push("sessionId = ?");
            params.push(opts.sessionId);
        }
        params.push(limit);
        return await this.db.all(`SELECT * FROM negative_experiences
        WHERE ${conds.join(" AND ")}
        ORDER BY weight DESC, seq DESC
        LIMIT ?`, params);
    }
    /**
     * Look up past failures associated with a symbol (function/method/class
     * identifier extracted from a previous error's stack trace). Cross-session
     * by default. Used as a secondary pivot when filePath is unknown but the
     * model mentions or operates on a named symbol.
     */
    async retrieveBySymbol(symbol, opts = {}) {
        if (!symbol)
            return [];
        const limit = opts.limit ?? 3;
        const includeResolved = opts.includeResolved === true;
        const conds = ["symbol = ?"];
        const params = [symbol];
        if (!includeResolved)
            conds.push("resolved = 0");
        if (opts.sessionId) {
            conds.push("sessionId = ?");
            params.push(opts.sessionId);
        }
        params.push(limit);
        return await this.db.all(`SELECT * FROM negative_experiences
        WHERE ${conds.join(" AND ")}
        ORDER BY weight DESC, seq DESC
        LIMIT ?`, params);
    }
    async retrieveBySignature(signature, opts = {}) {
        if (!signature)
            return [];
        const limit = opts.limit ?? 2;
        const includeResolved = opts.includeResolved === true;
        const conds = ["signature LIKE ?"];
        const params = [`%${signature}%`];
        if (!includeResolved)
            conds.push("resolved = 0");
        if (opts.sessionId) {
            conds.push("sessionId = ?");
            params.push(opts.sessionId);
        }
        params.push(limit);
        return await this.db.all(`SELECT * FROM negative_experiences
        WHERE ${conds.join(" AND ")}
        ORDER BY weight DESC, seq DESC
        LIMIT ?`, params);
    }
    /**
     * PreToolUse entry point. Strict: only return records that explicitly
     * match by filePath OR command. No tool-name fallback (that produced
     * noise — see Phase 3 review #20).
     */
    async retrieveForPreToolUse(toolName, targets, opts = {}) {
        const limit = opts.limit ?? 2;
        const seen = new Map();
        if (targets.filePath) {
            const rows = await this.retrieveByFilePath(targets.filePath, {
                ...opts,
                limit,
            });
            for (const r of rows)
                if (r.id != null)
                    seen.set(r.id, r);
        }
        if (targets.command && seen.size < limit) {
            const rows = await this.retrieveByCommand(targets.command, {
                ...opts,
                limit: limit - seen.size,
            });
            for (const r of rows)
                if (r.id != null)
                    seen.set(r.id, r);
        }
        return Array.from(seen.values()).slice(0, limit);
    }
}
export function createNegExpRetriever(store) {
    return new NegExpRetriever(store);
}
//# sourceMappingURL=retriever.js.map