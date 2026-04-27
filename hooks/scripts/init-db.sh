#!/bin/bash
# CodeMemory - Database Initialization
# Ensures the SQLite database exists and is migrated.

set -euo pipefail

CODEMEMORY_DB="${HOME}/.claude/codememory.db"
CODEMEMORY_DIR="${HOME}/.claude"

# Ensure directory exists
mkdir -p "$CODEMEMORY_DIR"

# If database doesn't exist, create it
if [ ! -f "$CODEMEMORY_DB" ]; then
    echo "[codememory] Creating database at $CODEMEMORY_DB" >&2

    # Use our TypeScript code to initialize
    if command -v node >/dev/null 2>&1; then
        cd "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}"
        if [ -d "dist" ]; then
            node --no-warnings dist/hooks/scripts/init-db.js 2>/dev/null || true
        fi
    fi
fi

# Always ensure we have the queue directory
mkdir -p "${HOME}/.claude/codememory-queue"

exit 0
