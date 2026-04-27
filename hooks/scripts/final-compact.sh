#!/bin/bash
# CodeMemory - Final Compaction
#
# Called from session-end.sh BEFORE the daemon is stopped, so the socket
# is still alive when we hit it. Same fire-and-forget pattern as
# pre-compact.sh: POST /compact and return fast.

set -euo pipefail

SESSION_ID="${1:-unknown}"

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/final-compact.log"

echo "[$(date -Iseconds)] SessionEnd final-compact (sid=${SESSION_ID})" >> "$LOG_FILE"

SOCKET_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.sock"
if [ -S "$SOCKET_PATH" ] && command -v curl >/dev/null 2>&1; then
  PAYLOAD=$(jq -nc --arg sid "$SESSION_ID" '{sessionId: $sid}')
  if curl -fsS \
       --unix-socket "$SOCKET_PATH" \
       --max-time 1 \
       -H 'content-type: application/json' \
       --data "$PAYLOAD" \
       http://localhost/compact >> "$LOG_FILE" 2>&1; then
    echo "[$(date -Iseconds)] compact request accepted" >> "$LOG_FILE"
  else
    echo "[$(date -Iseconds)] compact request failed (daemon unreachable)" >> "$LOG_FILE"
  fi
else
  echo "[$(date -Iseconds)] no daemon socket at ${SOCKET_PATH}, skipping" >> "$LOG_FILE"
fi

exit 0
