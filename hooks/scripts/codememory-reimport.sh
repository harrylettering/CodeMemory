#!/bin/bash
# CodeMemory - Re-import a session from its transcript.
#
# Destructive by design: everything the session owns is deleted and rebuilt
# from the jsonl on disk. That is what makes it idempotent — running it twice
# leaves the same rows as running it once.
#
# The daemon does no backfill on startup, so this is how a gap gets closed:
# a session that ran while the daemon was down, or one whose stored data is
# suspect.

set -euo pipefail

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/reimport.log"

TARGET_SESSION="${1:-${CLAUDE_SESSION_ID:-}}"
RUNTIME_DIR="${HOME}/.claude/codememory-runtime"

if [ -z "$TARGET_SESSION" ]; then
  echo '{"ok":false,"error":"no session id given and CLAUDE_SESSION_ID is unset"}'
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo '{"ok":false,"error":"curl is required"}'
  exit 0
fi

# Prefer this session's own daemon; fall back to the most recently active one,
# since the transcript being rebuilt may belong to a different session in the
# same project.
SOCKET=""
if [ -S "$RUNTIME_DIR/${CLAUDE_SESSION_ID:-none}.sock" ]; then
  SOCKET="$RUNTIME_DIR/${CLAUDE_SESSION_ID}.sock"
else
  while IFS= read -r candidate; do
    [ -S "$candidate" ] && SOCKET="$candidate" && break
  done < <(ls -t "$RUNTIME_DIR"/*.sock 2>/dev/null || true)
fi

if [ -z "$SOCKET" ]; then
  echo '{"ok":false,"error":"no live CodeMemory daemon socket under ~/.claude/codememory-runtime/"}'
  exit 0
fi

echo "[$(date -Iseconds)] reimport requested for $TARGET_SESSION via $SOCKET" >> "$LOG_FILE"

PAYLOAD=$(jq -nc --arg sid "$TARGET_SESSION" '{sessionId: $sid}')
RESPONSE=$(curl -sS --unix-socket "$SOCKET" --max-time 600 \
  -H 'content-type: application/json' --data "$PAYLOAD" \
  http://localhost/reimport 2>>"$LOG_FILE") || RESPONSE=''

if [ -z "$RESPONSE" ]; then
  echo '{"ok":false,"error":"daemon did not respond; see ~/.claude/codememory-logs/reimport.log"}'
  exit 0
fi

echo "[$(date -Iseconds)] $RESPONSE" >> "$LOG_FILE"
printf '%s\n' "$RESPONSE"
