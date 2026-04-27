---
name: codememory-expand-query
description: Answer a question using conversation history with optional sub-agent delegation
---

# codememory-expand-query

Ask a question about the conversation history, using CodeMemory's retrieval and optionally delegating to a specialized sub-agent.

## Usage

```
/codememory-expand-query --query "What database schema did we discuss?" --delegate
```

## Options

- `--query`: Question to answer (required)
- `--delegate`: Delegate to sub-agent for complex queries (default: false)
- `--token-budget`: Max tokens for response (default: 3000)
- `--conversation-id`: Limit to specific conversation (optional)
- `--query-language`: Language for query (optional)

## Process

1. Search conversation history for relevant content
2. Assemble context from matching summaries and messages
3. If delegate=true: Spawn codememory-query-agent to analyze
4. Generate answer based on retrieved context
5. Cite sources with summary/message IDs

## Output

- Answer to the question
- Source citations (which summaries/messages were used)
- Token usage information
- Option to expand on specific sources

## Sub-Agent Delegation

When `--delegate` is used, spawns the `codememory-query-agent` specialized in:
- Deep analysis of conversation history
- Complex reasoning across multiple summaries
- Synthesizing answers from disparate sources
