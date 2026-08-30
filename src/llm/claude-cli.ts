/**
 * CodeMemory for Claude Code - Shared `claude` CLI subprocess construction
 *
 * Four features shell out to the CLI: compaction summaries, the query planner,
 * the decision supersede judge, and expansion delegation. They must agree on
 * how the child is invoked, because getting it wrong disables the feature
 * silently rather than loudly.
 *
 * All four used to pass `--bare`. The intent was sound — `--bare` skips hooks,
 * and a child that replays our own SessionStart hook starts a second daemon
 * against the same database. But `--bare` also stops the CLI reading the
 * keychain, and documents that Anthropic auth is then *strictly*
 * ANTHROPIC_API_KEY or an apiKeyHelper. Anyone signed in through OAuth — every
 * subscription user — got `Not logged in · Please run /login` and exit code 1
 * on every call. Every LLM-backed feature in the system was dead, and because
 * each one has a graceful fallback, nothing ever surfaced it.
 *
 * Recursion is now prevented by `CODEMEMORY_CHILD` instead, which every hook
 * script checks and exits on.
 */

/**
 * Set on spawned children so CodeMemory's own hooks stand down. Without it a
 * child session replays SessionStart and starts a competing daemon.
 */
export const CODEMEMORY_CHILD_ENV = "CODEMEMORY_CHILD";

/**
 * `--no-session-persistence` is not a performance tweak: without it the child
 * writes a transcript into `~/.claude/projects/<project>/`, which our own
 * JSONL watcher then ingests as if it were the user's conversation.
 */
export function buildClaudeCliArgs(model?: string): string[] {
  const args = [
    "--print",
    "--output-format",
    "text",
    "--no-session-persistence",
  ];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function claudeCliSpawnEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...base, [CODEMEMORY_CHILD_ENV]: "1" };
}

/**
 * The CLI reports refusals to start — an expired login above all — on stdout
 * with an empty stderr. Reporting stderr alone turned every such failure into
 * `exited with code 1: ` and threw the one useful line away.
 */
export function describeClaudeCliFailure(
  stdout: string,
  stderr: string,
  limit = 500
): string {
  const err = stderr.trim();
  if (err) return err.slice(0, limit);

  const out = stdout.trim();
  if (out) return out.slice(0, limit);

  return "(no output on stdout or stderr)";
}
