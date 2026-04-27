#!/bin/bash
# CodeMemory - Session End Hook
# Cleans up and finalizes the memory system when session ends.

set -euo pipefail

# Get hook input from stdin
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

echo "[codememory] Session end: $SESSION_ID" >&2

# Final compaction BEFORE stopping the daemon — the /compact endpoint
# lives on the daemon's unix socket, so the daemon must still be alive
# when we POST to it. The compaction itself runs in the background inside
# the daemon; we only need the socket open long enough for the 202.
"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/final-compact.sh" "$SESSION_ID"

# Stop the project watcher daemon. Give it a short grace period so any
# in-flight background compaction has a chance to flush.
if command -v node >/dev/null 2>&1 && [ -d "${CLAUDE_PLUGIN_ROOT}/dist" ]; then
    echo "[codememory] Stopping project watcher daemon..." >&2
    sleep 1
    node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/daemon.js" stop "$SESSION_ID" 2>&1 || true
fi

echo "[codememory] Session ended: $SESSION_ID" >&2

cat <<EOF
{
  "continue": true,
  "suppressOutput": true
}
EOF
