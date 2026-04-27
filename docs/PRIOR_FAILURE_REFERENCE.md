# Prior Failure Reference

> Chinese version: [PRIOR_FAILURE_REFERENCE.zh-CN.md](./PRIOR_FAILURE_REFERENCE.zh-CN.md)
>
> This document describes the responsibilities, data flow, and storage model of the "prior failure" capability under the unified Memory Node architecture.

## 1. Positioning

Prior failure is not general memory. It is a structured failure-memory layer dedicated to one job: preventing the agent from repeating known bad paths.

It is optimized to answer questions like:

- Has this file failed here before?
- Has this command failed before?
- Has this symbol caused a similar issue before?
- Is this edit repeating a previous failed fix attempt?

## 2. Storage model

The old standalone `negative_experiences` table has been merged into `memory_nodes`, distinguished by `kind='failure'` plus tags:

- `kind = 'failure'` identifies a failure node.
- `metadata` carries structured fields such as `type`, `signature`, `raw`, `filePath`, `command`, `symbol`, `location`, `attemptedFix`, and `seq`.
- `memory_tags` writes multidimensional indexes such as `kind='failure'`, `file=<path>`, `command=<bin>`, `symbol=<name>`, and `signature=<normalized>`.
- Status follows the shared lifecycle in `MemoryNodeStore`: `active -> resolved / stale`, with `reopen` using the same path.

Entry APIs:

- `MemoryNodeStore.createFailureNode(input)`: create the failure node, tags, and lifecycle event
- `MemoryNodeStore.findFailuresByAnchors({ files, commands, symbols, signatures, statuses, limit })`: main lookup path
- `MemoryNodeStore.resolveFailureNodesByTarget(...)`: close failures after user confirmation or a successful fix
- `MemoryNodeStore.autoResolveStaleFailureNodes(...)`: periodically resolve failures that have not recurred for a long time

## 3. Data flow

```text
JSONL / tool result
  -> NegExpExtractor.extractFromErrorMessage   (src/negexp/extractor.ts)
  -> signature normalization                   (src/negexp/signature.ts)
  -> memoryStore.createFailureNode             (kind='failure' memory node)
  -> lookupForPreToolUse / retrieveForPrompt   (src/failure-lookup.ts, src/retrieval.ts)
  -> warning injection or prompt context
```

`src/negexp/extractor.ts` still exists and is reused. Its job is only to parse raw error text into structured fields; persistence is handled entirely by `memory_nodes`.

## 4. Current capabilities

- error extraction and signature normalization
- multi-dimensional tag lookup by file, command, symbol, and signature through `findFailuresByAnchors`
- confidence scoring plus 30-day half-life decay (`MIN_CONFIDENCE = 0.6`)
- user-signal-driven resolve and reopen
- daemon-side debounce so the same `nodeId` is not injected repeatedly within 60 seconds
- cross-session recall by default

## 5. PreToolUse behavior

`PreToolUse` is the most visible user-facing value of prior failure.

Execution flow:

1. Extract file, command, and symbol anchors from tool input.
2. Hit the daemon hot path first through `/failure/lookup` and keep `/negexp/lookup` as a compatibility alias.
3. Fall back to the cold path `dist/failure-lookup-cli.js` when needed.
4. Filter with `scoreMatch` confidence scoring.
5. Inject a markdown warning when the result is strong enough.

Current rules:

- hook failures must never block tool execution
- weak matches must not be force-injected
- cross-session failure recall is allowed by default

## 6. Relationship to Memory Nodes

There is no longer a two-layer "NegExp or Memory Node" model. A failure is simply one `kind` of memory node.

- Retrieval: Path A in `RetrievalEngine.retrieveForPrompt` fetches failure nodes directly through `findFailuresByAnchors`, and memory-first retrieval can also recall them.
- Lifecycle: `LifecycleResolver` reads and writes `memory_nodes` directly through operations like `reopenFailure`, `resolveFailuresForSucceededAttempt`, and `markSummaryStale`.
- Relation graph: failure nodes can participate in `memory_relations` such as `relatedTo` and `resolves`, so they can appear inside stitched chains.

## 7. Current boundaries

1. This layer is best at failure avoidance. It does not fully model requirements, decisions, or task state; those belong to other memory-node kinds.
2. The overall retrieval model is memory-first. Prior failure is one of the strongest signals inside that model, not a separate standalone channel.
3. Offline evaluation and long-term quality sampling still need more systematic work.
