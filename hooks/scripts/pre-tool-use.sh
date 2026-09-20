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

# Stand down inside a `claude --print` child spawned by CodeMemory itself;
# see the note in session-start.sh.
if [ -n "${CODEMEMORY_CHILD:-}" ]; then
  emit_noop
  exit 0
fi

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')
# Who is making this call, and which call it is.
#
# A subagent can write memory, and nothing else on that write says who wrote
# it: its CLAUDE_* environment is byte-identical to the main agent's, so a
# script curling the daemon cannot learn its own identity. This payload is the
# one place the answer exists, and tool_use_id is what later ties a mark back
# to it. Empty on main-agent calls -- absence is the main agent's identity.
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // ""')
PROMPT_ID=$(printf '%s' "$INPUT" | jq -r '.prompt_id // ""')
TOOL_USE_ID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // ""')
# The cold-start CLI qualifies file tags against CODEMEMORY_WORKSPACE_ROOT,
# falling back to cwd. The daemon gets this exported by session-start.sh; pin
# it here too so the read path computes the same workspace key the write path
# used, instead of whatever directory this hook happened to inherit.
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')
if [ -n "$CWD" ]; then
  export CODEMEMORY_WORKSPACE_ROOT="$CWD"
fi

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
      --arg agentId "$AGENT_ID" \
      --arg promptId "$PROMPT_ID" \
      --arg toolUseId "$TOOL_USE_ID" \
      '{toolName: $name, toolInput: $input,
        agentId: (if $agentId == "" then null else $agentId end),
        promptId: (if $promptId == "" then null else $promptId end),
        toolUseId: (if $toolUseId == "" then null else $toolUseId end)}')

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
  # --no-warnings matches the daemon spawn in session-start.sh. Without it
  # node:sqlite's ExperimentalWarning is appended to the log on every single
  # tool call, which is how this log reached 11 MB.
  RESPONSE=$(node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/failure-lookup-cli.js" \
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
