---
name: codememory-summarization-skill
description: This skill should be used when creating conversation summaries for CodeMemory, discussing summarization quality, optimizing DAG structure, or working with the compaction system. Provides guidelines for creating high-quality summaries that preserve all important information while fitting within token budgets.
version: 0.1.0
---

# CodeMemory Summarization Skill

Guidelines for creating high-quality conversation summaries in CodeMemory's DAG structure.

## When This Skill Applies

This skill activates when:
- Creating or reviewing conversation summaries
- Working with the DAG compaction system
- Discussing summary quality or token efficiency
- Optimizing the summary hierarchy
- Training or configuring the summarization agent

## Summary Quality Guidelines

### What to Include in Every Summary

1. **Key Decisions**: Any decisions made, with rationale
2. **Action Items**: Tasks assigned, with owners and deadlines
3. **Technical Details**: Architecture choices, API designs, schema changes
4. **Problem Statements**: What issues were being addressed
5. **Alternatives Considered**: Options that were rejected and why
6. **Ambiguities Resolved**: Questions that were clarified
7. **User Preferences**: Stated preferences that affect future work

### What to Exclude

- Redundant chit-chat
- Failed tool calls (unless the failure is informative)
- Repetitive restatements
- Simple acknowledgments ("ok", "got it")

## Leaf Summary Guidelines

**Target**: 8-16 messages, ~1200 tokens

Format:
```markdown
## Summary

[Concise overview of the conversation segment]

### Key Decisions
- [Decision 1]: [What was decided, why]
- [Decision 2]: [What was decided, why]

### Action Items
- [ ] [Action 1]: [Owner/Deadline if mentioned]
- [ ] [Action 2]: [Owner/Deadline if mentioned]

### Technical Details
[Relevant technical information, code snippets, architecture]
```

## Condensed Summary Guidelines

**Target**: 2-4 child summaries, ~2000 tokens

Format:
```markdown
## Summary

[Higher-level synthesis of the child summaries, showing how they connect]

### Key Themes
- [Theme 1]: [How it appears across child summaries]
- [Theme 2]: [How it appears across child summaries]

### Major Outcomes
- [Outcome 1]: [Result from this phase]
- [Outcome 2]: [Result from this phase]

### Child Summaries Referenced
- sum_abc123: [Brief description]
- sum_def456: [Brief description]
```

## DAG Structure Best Practices

1. **Balanced Tree**: Aim for 2-4 children per condensed node
2. **Logical Boundaries**: Split conversations at natural stopping points
3. **Topic Cohesion**: Each summary should have a clear, single topic
4. **Forward References**: If a later summary references an earlier one, note it
5. **Token Awareness**: Stay within target token counts

## Quality Checklist

Before marking a summary complete:
- [ ] All key decisions are included
- [ ] All action items are captured
- [ ] Technical details are accurate
- [ ] Summary is concise but comprehensive
- [ ] Token count is within target range
- [ ] No important information is lost
- [ ] Parent/child relationships make sense
