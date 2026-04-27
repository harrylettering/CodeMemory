#!/bin/bash
# CodeMemory - PreToolUse Hook: prior-failure recall.
#
# Looks up prior failures (memory_nodes kind='failure') for the tool's
# target and injects them into systemMessage. Two retrieval paths:
#   1. (preferred) curl the per-session daemon's unix socket — hot path,
#      no node cold-start, sub-50ms typical.
#   2. (fallback)  spawn `node failure-lookup-cli.js` — cold path,
#                  ~150-300ms.
# Either path produces the same JSON shape: {shouldInject, markdown, ...}.

set -euo pipefail

LOG_DIR="${HOME}/.claude/codememory-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/pre-tool-use.log"

# Always emit a valid response — the hook must never crash, even on
# malformed input or missing dependencies.
emit_noop() {
  printf '%s\n' '{"continue":true,"suppressOutput":true}'
}
trap 'emit_noop' ERR

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')

echo "[$(date -Iseconds)] PreToolUse for $TOOL_NAME (sid=${SESSION_ID})" >> "$LOG_FILE"

if [ -z "$TOOL_NAME" ]; then
  emit_noop
  exit 0
fi

RESPONSE=""

# --- Path 1: daemon socket ----------------------------------------------
SOCKET_PATH="${HOME}/.claude/codememory-runtime/${SESSION_ID}.sock"
if [ -S "$SOCKET_PATH" ] && command -v curl >/dev/null 2>&1; then
  PAYLOAD=$(jq -nc \
    --arg name "$TOOL_NAME" \
    --argjson input "$TOOL_INPUT" \
    '{toolName: $name, toolInput: $input}')

  if RESPONSE=$(curl -fsS \
        --unix-socket "$SOCKET_PATH" \
        --max-time 0.5 \
        -H 'content-type: application/json' \
        --data "$PAYLOAD" \
        http://localhost/failure/lookup 2>>"$LOG_FILE"); then
    echo "[$(date -Iseconds)] socket lookup ok" >> "$LOG_FILE"
  else
    echo "[$(date -Iseconds)] socket lookup failed, falling back" >> "$LOG_FILE"
    RESPONSE=""
  fi
fi

# --- Path 2: cold-start CLI fallback ------------------------------------
if [ -z "$RESPONSE" ] \
   && command -v node >/dev/null 2>&1 \
   && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] \
   && [ -f "${CLAUDE_PLUGIN_ROOT}/dist/failure-lookup-cli.js" ]; then
  RESPONSE=$(node "${CLAUDE_PLUGIN_ROOT}/dist/failure-lookup-cli.js" \
    "$SESSION_ID" "$TOOL_NAME" "$TOOL_INPUT" 2>>"$LOG_FILE") || RESPONSE=""
fi

if [ -z "$RESPONSE" ]; then
  emit_noop
  exit 0
fi

SHOULD_INJECT=$(printf '%s' "$RESPONSE" | jq -r '.shouldInject // false')

if [ "$SHOULD_INJECT" = "true" ]; then
  MARKDOWN=$(printf '%s' "$RESPONSE" | jq -r '.markdown // ""')
  echo "[$(date -Iseconds)] Injecting $(printf '%s' "$MARKDOWN" | wc -c) characters of context" >> "$LOG_FILE"
  jq -nc \
    --arg md "$MARKDOWN" \
    '{
      continue: true,
      suppressOutput: true,
      systemMessage: ("⚠️ PRIOR FAILURE ALERT\n\n" + $md)
    }'
  exit 0
fi

emit_noop
