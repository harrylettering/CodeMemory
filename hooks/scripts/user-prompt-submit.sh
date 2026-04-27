#!/bin/bash
# CodeMemory - UserPromptSubmit Hook (Phase 4: retrieval injection).
#
# Pulls relevant memory for the current prompt and injects it via
# `additionalContext` so the model sees prior failures + decisions
# before it starts answering. Two paths, mirroring pre-tool-use.sh:
#
#   1. Daemon socket (preferred) — POST /retrieval/onPrompt
#   2. (no fallback) — if the daemon is down we just emit a noop. The
#      cold-start path doesn't make sense here: prompt-time retrieval
#      with a node spawn would add 200ms to every keystroke-of-the-user
#      latency, which is the wrong tradeoff. Hook absence is recoverable.

set -euo pipefail

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
if [ ! -S "$SOCKET_PATH" ] || ! command -v curl >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] no socket / no curl, skipping injection" >> "$LOG_FILE"
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
