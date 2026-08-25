#!/bin/bash
# CodeMemory - Session Start Hook
# Initializes the memory system when a Claude Code session starts.

set -euo pipefail

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

# Start JSONL watcher daemon
echo "[$(date -Iseconds)] Starting JSONL watcher daemon" >> "$LOG_FILE"
echo "[$(date -Iseconds)] CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-}" >> "$LOG_FILE"

# Spawning the daemon is not the same as having a daemon. A crash on startup
# (a missing native binding, an unreadable database, an unsupported Node) exits
# within milliseconds, and reporting "initialized" over a dead process is how a
# 100% daemon failure rate stayed invisible for months. The socket is the only
# honest readiness signal: nothing can be looked up until it exists.
DAEMON_HEALTH_TIMEOUT="${CODEMEMORY_DAEMON_HEALTH_TIMEOUT:-3}"
DAEMON_HEALTH_POLL_INTERVAL="0.1"
DAEMON_HEALTHY="false"
DAEMON_FAILURE_REASON=""

if command -v node >/dev/null 2>&1 && [ -d "${CLAUDE_PLUGIN_ROOT}/dist" ]; then
    echo "[$(date -Iseconds)] Node and dist found, starting daemon" >> "$LOG_FILE"
    cd "${CLAUDE_PLUGIN_ROOT}"
    # Fully detach daemon: close stdin, redirect stdout+stderr to log file,
    # background, and disown. If stdout stays attached to the hook pipe,
    # Claude Code will wait forever for EOF and hang every command.
    nohup node --no-warnings dist/hooks/daemon.js start "$SESSION_ID" "$CWD" \
        </dev/null >>"${LOG_DIR}/daemon.log" 2>&1 &
    DAEMON_PID=$!
    disown "$DAEMON_PID" 2>/dev/null || true
    echo "[$(date -Iseconds)] Daemon spawned with PID $DAEMON_PID" >> "$LOG_FILE"

    # Poll for readiness, but abandon the wait the instant the process dies so
    # a crash-on-start costs ~100ms rather than the full timeout.
    SOCKET_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.sock"
    DAEMON_HEALTH_MAX_POLLS=$(awk -v t="$DAEMON_HEALTH_TIMEOUT" -v i="$DAEMON_HEALTH_POLL_INTERVAL" \
        'BEGIN { n = int(t / i); print (n < 1 ? 1 : n) }')
    POLL=0
    while [ "$POLL" -lt "$DAEMON_HEALTH_MAX_POLLS" ]; do
        if [ -S "$SOCKET_PATH" ]; then
            DAEMON_HEALTHY="true"
            break
        fi
        if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
            DAEMON_FAILURE_REASON="the daemon exited during startup"
            break
        fi
        sleep "$DAEMON_HEALTH_POLL_INTERVAL"
        POLL=$((POLL + 1))
    done

    if [ "$DAEMON_HEALTHY" = "true" ]; then
        echo "[$(date -Iseconds)] Daemon healthy, socket at $SOCKET_PATH" >> "$LOG_FILE"
    else
        if [ -z "$DAEMON_FAILURE_REASON" ]; then
            DAEMON_FAILURE_REASON="the daemon did not open its socket within ${DAEMON_HEALTH_TIMEOUT}s"
        fi
        echo "[$(date -Iseconds)] DAEMON UNHEALTHY: $DAEMON_FAILURE_REASON" >> "$LOG_FILE"
        # The daemon's own stderr is the only place the real cause appears;
        # copy the tail next to this failure so both live in one log.
        echo "[$(date -Iseconds)] Last lines of daemon.log:" >> "$LOG_FILE"
        tail -n 5 "${LOG_DIR}/daemon.log" 2>/dev/null >> "$LOG_FILE" || true
    fi
else
    DAEMON_FAILURE_REASON="node or ${CLAUDE_PLUGIN_ROOT}/dist was not found"
    echo "[$(date -Iseconds)] Node or dist not found! Node=$(command -v node 2>&1), dist=${CLAUDE_PLUGIN_ROOT}/dist" >> "$LOG_FILE"
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
