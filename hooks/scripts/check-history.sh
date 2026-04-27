#!/bin/bash
# CodeMemory - Check History
# Checks if we have existing conversation history for a project.

set -euo pipefail

PROJECT_HASH="$1"
CODEMEMORY_DB="${HOME}/.claude/codememory.db"

if [ ! -f "$CODEMEMORY_DB" ]; then
    echo "false"
    exit 0
fi

# Use sqlite3 to check if we have conversations for this project
if command -v sqlite3 >/dev/null 2>&1; then
    COUNT=$(sqlite3 "$CODEMEMORY_DB" "SELECT COUNT(*) FROM conversations WHERE project_hash = '$PROJECT_HASH'" 2>/dev/null || echo "0")
    if [ "$COUNT" -gt 0 ]; then
        echo "true"
    else
        echo "false"
    fi
else
    # Fallback: if sqlite3 not available, just check if DB exists
    echo "false"
fi

exit 0
