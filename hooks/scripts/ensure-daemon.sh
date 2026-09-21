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

VERSION_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.version"

# Already serving -- the common case on every call after the first -- but only
# if the daemon behind the socket came from this plugin version. A live socket
# used to be enough, and a plugin update plus /reload-plugins keeps the session
# id, so the old version's socket stayed live and every new hook talked to the
# old daemon. After the 0.6.0 install all 8 daemons on the machine still ran
# 0.5.0 code. Nor would they leave by themselves: the idle exit that retires a
# daemon is a newer feature than the daemons that need retiring.
if [ -S "$SOCKET_PATH" ]; then
  WANT=""
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    WANT=$(jq -r '.version // empty' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null)
  fi
  HAVE=$(cat "$VERSION_PATH" 2>/dev/null)
  # An unreadable manifest keeps the running daemon: replacing on it would
  # restart the daemon on every prompt. A missing version file does not --
  # daemons older than the file never wrote one, and they are exactly the
  # ones this check exists to replace.
  if [ -z "$WANT" ] || [ "$HAVE" = "$WANT" ]; then
    exit 0
  fi
  mkdir -p "${HOME}/.claude/codememory-logs"
  node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/daemon.js" stop "$SESSION_ID" \
    >>"${HOME}/.claude/codememory-logs/daemon.log" 2>&1
  # stop waits for the pid file to go; the socket only goes if the old daemon
  # shut down cleanly, and a leftover would read as "already serving" below.
  rm -f "$SOCKET_PATH" "$VERSION_PATH"
fi

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
