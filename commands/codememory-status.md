---
name: codememory-status
description: Show CodeMemory system status and statistics
---

# codememory-status

Display current status of the CodeMemory memory system.

## Usage

```
/codememory-status
```

## Options

None.

## Process

1. Check database connection
2. Gather statistics:
   - Total conversations
   - Total messages
   - Total summaries
   - Database size
   - DAG depth statistics
3. Show active session information
4. Display configuration

## Output

Status overview including:
- Database health
- Storage usage
- Compaction statistics
- Active hooks status
- Configuration details
