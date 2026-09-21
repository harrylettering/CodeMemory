#!/bin/bash
# CodeMemory - UserPromptSubmit Hook (Phase 4: retrieval injection).
#
# Pulls relevant memory for the current prompt and injects it via
# `additionalContext` so the model sees prior failures + decisions
# before it starts answering. Two paths, mirroring pre-tool-use.sh:
#
#   1. Daemon socket (preferred) — POST /retrieval/onPrompt
#   2. Respawn and retry once — the daemon now exits when idle, so a session
#      that goes quiet and comes back finds no socket. Without this, that
#      session had no retrieval for the rest of its life. There is still no
#      cold-start CLI path: a node spawn per prompt is the wrong trade, but
#      bringing the daemon back once, on the prompt that noticed it was gone,
#      pays for itself over every prompt after it.
#
# The respawn lives here rather than in pre-tool-use.sh on purpose.
# UserPromptSubmit fires once per turn, before that turn's tools, so by the
# time PreToolUse runs the daemon is already back; putting a spawn on the
# per-tool-call path would risk the invariant that hooks never block tools.

set -euo pipefail

# Stand down inside a `claude --print` child spawned by CodeMemory itself;
# see the note in session-start.sh.
if [ -n "${CODEMEMORY_CHILD:-}" ]; then
  printf '%s\n' '{"continue":true,"suppressOutput":true}'
  exit 0
fi

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/user-prompt-submit.log"

emit_noop() {
  printf '%s\n' '{"continue":true,"suppressOutput":true}'
}
trap 'emit_noop' ERR

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_message // ""')

echo "[$(date -Iseconds)] UserPromptSubmit (sid=${SESSION_ID}, len=${#PROMPT})" >> "$LOG_FILE"

if [ -z "$PROMPT" ]; then
  emit_noop
  exit 0
fi

SOCKET_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.sock"

if ! command -v curl >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] no curl, skipping injection" >> "$LOG_FILE"
  emit_noop
  exit 0
fi

# Called on every prompt, not only when the socket is missing. ensure-daemon.sh
# also replaces a daemon from another plugin version, and after an update plus
# /reload-plugins that old daemon's socket is live -- guarding the call on a
# missing socket meant the replacement never ran on the path an upgrade takes.
# When the daemon is current the script returns after a stat and two reads.
#
# Budget is deliberately shorter than SessionStart's. This runs between the
# user pressing enter and the model starting, so a daemon that cannot come up
# quickly is not worth waiting for -- it will be retried next prompt, and
# nothing is lost meanwhile because read positions are durable.
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  if ! REASON=$("${CLAUDE_PLUGIN_ROOT}/hooks/scripts/ensure-daemon.sh" \
        "$SESSION_ID" "$CWD" "${CODEMEMORY_RESPAWN_TIMEOUT:-1.5}" 2>>"$LOG_FILE"); then
    echo "[$(date -Iseconds)] daemon not ready: ${REASON:-unknown}" >> "$LOG_FILE"
    emit_noop
    exit 0
  fi
elif [ ! -S "$SOCKET_PATH" ]; then
  # Without the plugin root nothing can be spawned or replaced; a live socket
  # is still worth using.
  echo "[$(date -Iseconds)] no socket and no CLAUDE_PLUGIN_ROOT" >> "$LOG_FILE"
  emit_noop
  exit 0
fi

PAYLOAD=$(jq -nc --arg prompt "$PROMPT" '{prompt: $prompt}')

if ! RESPONSE=$(curl -fsS \
      --unix-socket "$SOCKET_PATH" \
      --max-time 1.0 \
      -H 'content-type: application/json' \
      --data "$PAYLOAD" \
      http://localhost/retrieval/onPrompt 2>>"$LOG_FILE"); then
  echo "[$(date -Iseconds)] retrieval lookup failed" >> "$LOG_FILE"
  emit_noop
  exit 0
fi

SHOULD_INJECT=$(printf '%s' "$RESPONSE" | jq -r '.shouldInject // false')
if [ "$SHOULD_INJECT" != "true" ]; then
  emit_noop
  exit 0
fi

MARKDOWN=$(printf '%s' "$RESPONSE" | jq -r '.markdown // ""')
echo "[$(date -Iseconds)] Injecting $(printf '%s' "$MARKDOWN" | wc -c) chars" >> "$LOG_FILE"

jq -nc --arg md "$MARKDOWN" '{
  continue: true,
  suppressOutput: true,
  additionalContext: $md
}'
