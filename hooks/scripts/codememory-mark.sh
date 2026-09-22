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
#   2. The calling session's socket, by session id:
#        $CLAUDE_SESSION_ID       -- the skills pass the id Claude Code
#                                    substitutes for ${CLAUDE_SESSION_ID}
#        $CLAUDE_CODE_SESSION_ID  -- present in the Bash tool's environment
#                                    (observed, not documented)
#   Nothing else. There used to be a third step, "the most recently modified
#   live socket", and with several sessions open that is usually another
#   session's daemon: the mark would be stored in, and recalled by, a session
#   that never made it. A mark that cannot be tied to its session is refused.

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

# 2. The calling session, by id.
SESSION="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
if [ -z "$SOCKET" ]; then
  if [ -z "$SESSION" ]; then
    echo '{"ok":false,"reason":"no session id: cannot tell which session this mark belongs to"}' >&2
    exit 1
  fi
  CANDIDATE="$RUNTIME_DIR/${SESSION}.sock"
  if [ ! -S "$CANDIDATE" ]; then
    # Not an invitation to use some other session's daemon. The prompt hook
    # restarts this one on every turn, so a mark made mid-turn finds it.
    echo "{\"ok\":false,\"reason\":\"no CodeMemory daemon for session ${SESSION}\"}" >&2
    exit 1
  fi
  SOCKET="$CANDIDATE"
fi

URL="http://localhost/mark/${ENDPOINT}"

curl -fsS \
  --unix-socket "$SOCKET" \
  --max-time 2 \
  -H 'content-type: application/json' \
  --data "$PAYLOAD" \
  "$URL"
