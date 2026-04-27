---
name: codememory-watch
description: Start/stop watching ~/.claude/projects/ directory for JSONL conversation files
---

# codememory-watch

Start or stop the JSONL file watcher that monitors `~/.claude/projects/` for conversation history files.

## Usage

```
/codememory-watch --start
/codememory-watch --stop
/codememory-watch --status
```

## Options

- `--start`: Start watching the projects directory
- `--stop`: Stop watching
- `--status`: Show current watcher status

## What It Does

When started, the watcher will:
1. Scan `~/.claude/projects/` for existing `.jsonl` files
2. Monitor for new files being created
3. Monitor for existing files being updated
4. Ingest new messages into the CodeMemory database

## Integration with Hooks

The file watcher works alongside Claude Code hooks:
- **Hooks**: Real-time capture of current session
- **File watcher**: Backfill of historical sessions and recovery

## See Also

- `/codememory-status`: Check overall system status
- `/codememory-grep`: Search ingested history
