---
name: codememory-expand
description: Expand a summary to see its children and original messages
---

# codememory-expand

Expand a summary node in the DAG to view its children and original source messages.

## Usage

```
/codememory-expand --summary-id sum_abc123 --depth 2
```

## Options

- `--summary-id`: Summary ID to expand (required)
- `--depth`: Expansion depth (default: 1, max: 5)
- `--include-messages`: Include original raw messages (default: true)
- `--token-budget`: Max tokens for expanded context (default: 4000)

## Process

1. Traverse the DAG from the given summary ID
2. Collect child summaries up to specified depth
3. Retrieve linked original messages
4. Assemble context within token budget
5. Format and display expanded view

## Output

Expanded context showing:
- Summary hierarchy
- Original messages in chronological order
- Token usage breakdown
- Navigation options for further expansion

## Integration

After expansion, offers to:
- Ask questions about the expanded context
- Search within expanded content
- Expand further with different parameters
