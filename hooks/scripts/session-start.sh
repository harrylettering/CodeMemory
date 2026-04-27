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
    echo "[$(date -Iseconds)] Daemon started with PID $DAEMON_PID" >> "$LOG_FILE"
else
    echo "[$(date -Iseconds)] Node or dist not found! Node=$(command -v node 2>&1), dist=${CLAUDE_PLUGIN_ROOT}/dist" >> "$LOG_FILE"
fi

# Check if we have existing history for this project
PROJECT_HASH=$(echo "$CWD" | sha256sum | cut -d' ' -f1)
echo "[$(date -Iseconds)] PROJECT_HASH=$PROJECT_HASH" >> "$LOG_FILE"
HAS_HISTORY=$("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check-history.sh" "$PROJECT_HASH" || echo "false")
echo "[$(date -Iseconds)] HAS_HISTORY=$HAS_HISTORY" >> "$LOG_FILE"

# Build system message
SYSTEM_MESSAGE="CodeMemory initialized. "

if [ "$HAS_HISTORY" = "true" ]; then
    SYSTEM_MESSAGE="${SYSTEM_MESSAGE}Found existing conversation history for this project. Use /codememory-grep to search, /codememory-expand-query to ask questions, or /codememory-status to view status."
else
    SYSTEM_MESSAGE="${SYSTEM_MESSAGE}New project session. Conversation will be automatically saved to the CodeMemory database."
fi

echo "[$(date -Iseconds)] Done, systemMessage=$SYSTEM_MESSAGE" >> "$LOG_FILE"

# Output hook result
cat <<EOF
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "$SYSTEM_MESSAGE"
}
EOF
