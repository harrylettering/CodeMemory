---
name: codememory-grep
description: Search conversation history and summaries using CodeMemory
---

# codememory-grep

Search conversation history and summaries stored in the CodeMemory database.

## Usage

```
/codememory-grep --query "database schema" --mode full_text --scope both
```

## Options

- `--query`: Search query text (required)
- `--mode`: Search mode - "regex" or "full_text" (default: full_text)
- `--scope`: Search scope - "messages", "summaries", or "both" (default: both)
- `--limit`: Maximum number of results to return (default: 20)

## Process

1. Connect to the CodeMemory SQLite database at `~/.claude/codememory.db`
2. Perform full-text search or regex search based on mode
3. Return matching messages and summaries with context
4. Format results for readability

## Output

Shows matching content with:
- Message/Summary ID
- Timestamp
- Role (user/assistant)
- Content snippet
- Relevance score

## Integration

After search, offers to:
- Expand specific results with `/codememory-expand`
- Ask questions about results with `/codememory-expand-query`
