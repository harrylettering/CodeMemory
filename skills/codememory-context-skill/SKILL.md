---
name: codememory-context-skill
description: This skill should be used when the user asks questions about past conversations, wants to recall previous discussions, references "earlier", "before", "previous", "what did we say", "remember when", or any query that requires retrieving information from conversation history. Automatically retrieves and injects relevant context from the CodeMemory memory system.
version: 0.1.0
---

# CodeMemory Context Skill

Automatically retrieves relevant conversation history when the user asks about past discussions.

## When This Skill Applies

This skill activates when the user's request involves:
- Asking about "what we discussed earlier"
- Referencing "previous" decisions or conversations
- Questions like "do you remember when..."
- Needing context from earlier in the session or past sessions
- Any query that would benefit from historical context

## How to Use This Skill

When activated:

1. **Identify the Context Need**: Determine what time period or topic the user is asking about
2. **Retrieve Relevant Content**: Use `/codememory-grep` to search for matching content
3. **Expand if Needed**: Use `/codememory-expand` on promising summaries for more detail
4. **Inject Context**: Add the retrieved information to the conversation context
5. **Answer the User**: Use the injected context to provide an informed answer

## Context Injection Format

When adding retrieved context, format it as:

```markdown
--- BEGIN CODEMEMORY CONTEXT ---

## Retrieved from Conversation History:

[Summary: sum_abc123 (2026-04-04)]
Key discussion points about database schema...

[Message: msg_456 (2026-04-04, USER)]
"We should use SQLite with FTS5 for full-text search"

--- END CODEMEMORY CONTEXT ---
```

## Best Practices

- **Be selective**: Only retrieve the most relevant context to avoid token bloat
- **Cite sources**: Include summary/message IDs so user can verify
- **Ask for clarification**: If the query is ambiguous about what time period to search
- **Use sub-agent**: For complex queries, delegate to `codememory-query-agent`

## Tools Available

- `/codememory-grep` - Search conversation history
- `/codememory-describe` - Get details about a specific summary
- `/codememory-expand` - Expand a summary for more detail
- `/codememory-expand-query` - Ask a question with sub-agent delegation
- `/codememory-status` - Check system status
