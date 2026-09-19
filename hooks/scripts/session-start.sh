#!/bin/bash
# CodeMemory - Session Start Hook
# Initializes the memory system when a Claude Code session starts.

set -euo pipefail

# CodeMemory spawns `claude --print` for summaries, query planning, the
# supersede judge and expansion delegation. Those children run our hooks too,
# and an unguarded SessionStart would start a second daemon against the same
# database. This used to be prevented with `--bare`, which also stopped the CLI
# reading the keychain and broke every LLM call for OAuth users; the parent now
# sets CODEMEMORY_CHILD instead and every hook stands down when it sees it.
if [ -n "${CODEMEMORY_CHILD:-}" ]; then
    printf '%s\n' '{"continue":true,"suppressOutput":true}'
    exit 0
fi

# Log directory
LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/session-start.log"

echo "[$(date -Iseconds)] Starting session-start.sh" >> "$LOG_FILE"

# Get hook input from stdin
INPUT=$(cat)
echo "[$(date -Iseconds)] Input received" >> "$LOG_FILE"

# Parse session information
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

echo "[$(date -Iseconds)] SESSION_ID=$SESSION_ID, CWD=$CWD" >> "$LOG_FILE"

# Log startup
echo "[codememory] Session start: $SESSION_ID in $CWD" >&2

# Initialize database if needed
echo "[$(date -Iseconds)] Initializing database" >> "$LOG_FILE"
"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/init-db.sh"

# Reap the runtime files of daemons that are gone.
#
# Each session's .pid and .sock are named after a session id that never recurs,
# so the existing same-id probe below can never clean up after a previous
# session -- leaving the directory to accumulate one dead pair per session
# forever.
#
# This only deletes files, and only when the process is demonstrably gone. It
# never signals anything, so a recycled pid cannot lead it to kill an unrelated
# process; the worst case is leaving a pair in place for another session.
RUNTIME_DIR="${HOME}/.claude/codememory-runtime"
if [ -d "$RUNTIME_DIR" ]; then
    SWEPT=0
    for pidfile in "$RUNTIME_DIR"/*.pid; do
        [ -e "$pidfile" ] || continue
        sid=$(basename "$pidfile" .pid)
        [ "$sid" = "$SESSION_ID" ] && continue
        pid=$(cat "$pidfile" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            continue
        fi
        rm -f "$pidfile" "$RUNTIME_DIR/$sid.sock"
        SWEPT=$((SWEPT + 1))
    done
    # A socket with no pid file beside it belongs to a daemon that died without
    # running its teardown, which is the common case this exists for.
    for sockfile in "$RUNTIME_DIR"/*.sock; do
        [ -e "$sockfile" ] || continue
        sid=$(basename "$sockfile" .sock)
        [ "$sid" = "$SESSION_ID" ] && continue
        [ -e "$RUNTIME_DIR/$sid.pid" ] && continue
        rm -f "$sockfile"
        SWEPT=$((SWEPT + 1))
    done
    [ "$SWEPT" -gt 0 ] && \
        echo "[$(date -Iseconds)] Swept $SWEPT stale runtime file(s)" >> "$LOG_FILE"
fi

# Start JSONL watcher daemon
echo "[$(date -Iseconds)] Starting JSONL watcher daemon" >> "$LOG_FILE"
echo "[$(date -Iseconds)] CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-}" >> "$LOG_FILE"

# Spawning the daemon is not the same as having a daemon. A crash on startup
# (a missing native binding, an unreadable database, an unsupported Node) exits
# within milliseconds, and reporting "initialized" over a dead process is how a
# 100% daemon failure rate stayed invisible for months. The socket is the only
# honest readiness signal: nothing can be looked up until it exists.
#
# The spawn and the readiness poll now live in ensure-daemon.sh, because
# SessionStart is no longer the only moment a daemon needs to exist: it exits
# when idle, so a session that goes quiet and comes back has to be able to
# bring one up again.
DAEMON_HEALTHY="false"
DAEMON_FAILURE_REASON=""

if DAEMON_FAILURE_REASON=$("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/ensure-daemon.sh" \
        "$SESSION_ID" "$CWD" "${CODEMEMORY_DAEMON_HEALTH_TIMEOUT:-3}" 2>>"$LOG_FILE"); then
    DAEMON_HEALTHY="true"
    DAEMON_FAILURE_REASON=""
    echo "[$(date -Iseconds)] Daemon healthy" >> "$LOG_FILE"
else
    [ -z "$DAEMON_FAILURE_REASON" ] && DAEMON_FAILURE_REASON="the daemon could not be started"
    echo "[$(date -Iseconds)] DAEMON UNHEALTHY: $DAEMON_FAILURE_REASON" >> "$LOG_FILE"
    # The daemon's own stderr is the only place the real cause appears; copy
    # the tail next to this failure so both live in one log.
    echo "[$(date -Iseconds)] Last lines of daemon.log:" >> "$LOG_FILE"
    tail -n 5 "${LOG_DIR}/daemon.log" 2>/dev/null >> "$LOG_FILE" || true
fi

# Check if we have existing history for this project
PROJECT_HASH=$(echo "$CWD" | sha256sum | cut -d' ' -f1)
echo "[$(date -Iseconds)] PROJECT_HASH=$PROJECT_HASH" >> "$LOG_FILE"
HAS_HISTORY=$("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check-history.sh" "$PROJECT_HASH" || echo "false")
echo "[$(date -Iseconds)] HAS_HISTORY=$HAS_HISTORY" >> "$LOG_FILE"

# Build system message. Only claim initialization when the daemon is actually
# serving; otherwise say so plainly and point at the log that holds the cause.
if [ "$DAEMON_HEALTHY" = "true" ]; then
    SYSTEM_MESSAGE="CodeMemory initialized. "

    if [ "$HAS_HISTORY" = "true" ]; then
        SYSTEM_MESSAGE="${SYSTEM_MESSAGE}Found existing conversation history for this project. Use /codememory-grep to search, /codememory-expand-query to ask questions, or /codememory-status to view status."
    else
        SYSTEM_MESSAGE="${SYSTEM_MESSAGE}New project session. Conversation will be automatically saved to the CodeMemory database."
    fi
else
    SYSTEM_MESSAGE="CodeMemory is NOT running: ${DAEMON_FAILURE_REASON}. Nothing will be recorded and no prior-failure warnings will be injected this session. See ${LOG_DIR}/daemon.log for the cause."
fi

echo "[$(date -Iseconds)] Done, daemonHealthy=$DAEMON_HEALTHY, systemMessage=$SYSTEM_MESSAGE" >> "$LOG_FILE"

# Output hook result. `continue` stays true even when the daemon is dead — a
# broken memory system must never block the user's session. Built with jq so a
# failure reason containing quotes or newlines cannot produce invalid JSON.
jq -n --arg msg "$SYSTEM_MESSAGE" \
    '{continue: true, suppressOutput: false, systemMessage: $msg}'
