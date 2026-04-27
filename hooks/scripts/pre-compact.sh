#!/bin/bash
# CodeMemory - PreCompact Hook
#
# Posts to the daemon's /compact unix-socket endpoint and returns
# immediately. The daemon handles the actual compaction in background so
# Claude Code's PreCompact path is never blocked by our LLM call.
#
# If the daemon isn't reachable we just emit a safe noop — compaction
# will catch up on the next threshold-based auto-trigger from the ingest
# path, or on the next explicit codememory_compact invocation.

set -euo pipefail

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/pre-compact.log"

emit_noop() {
  printf '%s\n' '{"continue":true,"suppressOutput":true}'
}
trap 'emit_noop' ERR

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')

echo "[$(date -Iseconds)] PreCompact (sid=${SESSION_ID})" >> "$LOG_FILE"

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

emit_noop
