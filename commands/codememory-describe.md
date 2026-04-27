---
name: codememory-describe
description: Describe a specific summary or conversation from CodeMemory
---

# codememory-describe

Show detailed information about a specific summary or conversation.

## Usage

```
/codememory-describe --id sum_abc123
```

## Options

- `--id`: Summary ID or Conversation ID (required)
- `--type`: Type of ID - "summary" or "conversation" (auto-detected)
- `--show-children`: Include child summaries in output (default: true)
- `--show-messages`: Include raw messages (default: false)

## Process

1. Retrieve the summary or conversation from database
2. Show metadata (created_at, token count, depth, etc.)
3. Display the summary content
4. Show parent/child relationships in DAG
5. Optionally show linked messages

## Output

Detailed view including:
- Summary metadata
- Full content
- DAG position and relationships
- Token usage information
- Compaction history
