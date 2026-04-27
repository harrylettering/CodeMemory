#!/bin/bash
# CodeMemory - Mark wrapper
#
# Posts a JSON payload to the per-session daemon's mark endpoint.
# Used by the codememory-mark-decision / codememory-mark-task / codememory-mark-constraint Skills.
#
# Usage:
#   codememory-mark.sh <endpoint> <json_payload>
#
# <endpoint> is the daemon path, e.g. "decision" or "requirement".
# <json_payload> is the request body (a JSON object).
#
# Socket discovery (in order):
#   1. $CODEMEMORY_SOCKET if exported.
#   2. $HOME/.claude/codememory-runtime/$CLAUDE_SESSION_ID.sock if the env var
#      is set and the file exists.
#   3. The most recently modified *.sock under ~/.claude/codememory-runtime/
#      whose owning daemon process (per the matching .pid) is alive.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo '{"ok":false,"reason":"usage: codememory-mark.sh <endpoint> <json_payload>"}' >&2
  exit 2
fi

ENDPOINT="$1"
PAYLOAD="$2"

case "$ENDPOINT" in
  decision|requirement) ;;
  *)
    echo "{\"ok\":false,\"reason\":\"unknown endpoint: $ENDPOINT\"}" >&2
    exit 2
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo '{"ok":false,"reason":"curl not found"}' >&2
  exit 2
fi

RUNTIME_DIR="${HOME}/.claude/codememory-runtime"
SOCKET=""

# 1. Explicit override.
if [ -n "${CODEMEMORY_SOCKET:-}" ] && [ -S "$CODEMEMORY_SOCKET" ]; then
  SOCKET="$CODEMEMORY_SOCKET"
fi

# 2. Session id from env.
if [ -z "$SOCKET" ] && [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  CANDIDATE="$RUNTIME_DIR/${CLAUDE_SESSION_ID}.sock"
  if [ -S "$CANDIDATE" ]; then
    SOCKET="$CANDIDATE"
  fi
fi

# 3. Pick the most recent live socket.
if [ -z "$SOCKET" ] && [ -d "$RUNTIME_DIR" ]; then
  while IFS= read -r sock; do
    [ -z "$sock" ] && continue
    [ -S "$sock" ] || continue
    sid="$(basename "$sock" .sock)"
    pid_file="$RUNTIME_DIR/${sid}.pid"
    if [ -f "$pid_file" ]; then
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        SOCKET="$sock"
        break
      fi
    else
      SOCKET="$sock"
      break
    fi
  done < <(ls -t "$RUNTIME_DIR"/*.sock 2>/dev/null || true)
fi

if [ -z "$SOCKET" ]; then
  echo '{"ok":false,"reason":"no live CodeMemory daemon socket found under ~/.claude/codememory-runtime/"}' >&2
  exit 1
fi

URL="http://localhost/mark/${ENDPOINT}"

curl -fsS \
  --unix-socket "$SOCKET" \
  --max-time 2 \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" \
  "$URL"
