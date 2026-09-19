#!/usr/bin/env bash
#
# Make sure a daemon is serving this session's socket, spawning one if not.
#
# Extracted from session-start.sh because SessionStart is no longer the only
# moment a daemon needs to exist. A daemon now exits when idle, so a session
# that goes quiet and comes back finds no socket, and before this the rest of
# that session had no retrieval at all -- user-prompt-submit.sh saw no socket
# and returned a noop with no way to recover.
#
# Idempotent by design. A healthy socket returns immediately, and two hooks
# racing to spawn leave one process behind: the loser's bind fails with
# EADDRINUSE and that daemon stands down, so the bind is the lock.
#
# Usage:  ensure-daemon.sh <session_id> <cwd> [timeout_seconds]
# Exit 0: socket is ready.  Exit 1: not ready, reason on stdout.

set -uo pipefail

SESSION_ID="${1:-}"
CWD="${2:-}"
TIMEOUT="${3:-${CODEMEMORY_DAEMON_HEALTH_TIMEOUT:-3}}"

[ -z "$SESSION_ID" ] && { echo "no session id"; exit 1; }

SOCKET_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.sock"

# Already serving. This is the common case on every call after the first.
[ -S "$SOCKET_PATH" ] && exit 0

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH"
  exit 1
fi
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || [ ! -d "${CLAUDE_PLUGIN_ROOT}/dist" ]; then
  echo "plugin dist directory not found"
  exit 1
fi

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"

# File tags are qualified as <sha256(workspaceRoot)[:8]>:<relative-path>, and
# workspaceRoot falls back to process.cwd(). The `cd` below is required for the
# relative dist/ path to resolve, but it also makes cwd the plugin directory --
# identical for every project on the machine. Without this export every repo
# hashed to the same key, so tags from different projects collided and absolute
# paths fell out of qualification entirely.
if [ -n "$CWD" ]; then
  export CODEMEMORY_WORKSPACE_ROOT="$CWD"
fi

cd "${CLAUDE_PLUGIN_ROOT}" || { echo "cannot enter plugin root"; exit 1; }

# Fully detach: close stdin, redirect both streams to the log, background and
# disown. If stdout stays attached to the hook pipe, Claude Code waits forever
# for EOF and every command hangs.
nohup node --no-warnings dist/hooks/daemon.js start "$SESSION_ID" "$CWD" \
  </dev/null >>"${LOG_DIR}/daemon.log" 2>&1 &
DAEMON_PID=$!
disown "$DAEMON_PID" 2>/dev/null || true

# Spawning is not the same as having a daemon. A crash on startup -- an
# unreadable database, an unsupported Node -- exits within milliseconds, and
# reporting success over a dead process is how a 100% failure rate stayed
# invisible for months. The socket is the only honest readiness signal.
POLL_INTERVAL="0.1"
MAX_POLLS=$(awk -v t="$TIMEOUT" -v i="$POLL_INTERVAL" \
  'BEGIN { n = int(t / i); print (n < 1 ? 1 : n) }')
POLL=0
while [ "$POLL" -lt "$MAX_POLLS" ]; do
  [ -S "$SOCKET_PATH" ] && exit 0
  # Abandon the wait the moment the process dies, so a crash-on-start costs
  # ~100ms instead of the whole timeout.
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    # It may have lost a spawn race, in which case the winner's socket is
    # there and this is a success, not a failure.
    [ -S "$SOCKET_PATH" ] && exit 0
    echo "the daemon exited during startup"
    exit 1
  fi
  sleep "$POLL_INTERVAL"
  POLL=$((POLL + 1))
done

echo "the daemon did not open its socket within ${TIMEOUT}s"
exit 1
