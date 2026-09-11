# Telemetry reference

Six tables in `~/.claude/codememory.db` record what the memory system did,
including the times it did nothing. They exist because every headline feature
was, at some point, impossible to distinguish from a feature that had never
run. All four are written best-effort: a telemetry failure never fails the
operation it describes.

| Table | One row per | Answers |
|---|---|---|
| `failure_lookup_events` | PreToolUse lookup | Did a prior-failure warning fire, and if not, which stage swallowed it |
| `retrieval_events` | UserPromptSubmit retrieval | What was recalled, through which path, and what the funnel lost |
| `compaction_events` | summary generation | Was the summary written by the model or by the truncation fallback |
| `decision_judge_events` | auto-supersede judge call | Did the judge run, agree, or fail |
| `ingestion_events` | scored message | What entered, what was discarded as noise, and under which rule |
| `extraction_events` | key-memory extraction chunk | How many model calls the reported memories actually cost |

A dashboard should read the rows with a null outcome as data, not as missing
data. The empty results are the denominator.

---

## `failure_lookup_events`

The hot path behind prior-failure warnings.

| Column | Notes |
|---|---|
| `conversationId`, `sessionId` | Scope |
| `toolName` | The tool about to run |
| `targetFile`, `targetCommand` | Raw, as the tool received them |
| `targetFileTag`, `targetCommandTag` | Normalized to the `memory_tags` form. **Join on these, never the raw columns.** |
| `outcome` | `injected`, `debounced`, `below_confidence`, `no_candidates`, `no_target` |
| `candidateCount`, `passedCount` | Before and after the confidence floor |
| `topScore` | Best score seen, including when it lost to the floor |
| `surfacedNodeIds` | JSON array, joins to `memory_nodes` |
| `source` | `daemon` (socket) or `cli` (cold fallback) |

The four non-injecting outcomes demand opposite fixes. `no_target` is an
extraction problem, `no_candidates` is a coverage problem, `below_confidence`
is a threshold problem, `debounced` is working as intended.

**Derived:** injection rate over all lookups; injection rate over lookups that
had at least one candidate. The two diverging says the floor is not the
bottleneck.

---

## `retrieval_events`

One row per prompt that reached retrieval, including prompts that injected
nothing.

| Column | Notes |
|---|---|
| `promptLength`, `injectedChars`, `outcome` | `outcome` is `injected` or `empty` |
| `plannerSource` | `fast`, `smart`, or `fallback` |
| `plannerAttempted`, `plannerReason`, `plannerError` | `fallback` means the smart planner was tried and threw; in the response it is indistinguishable from `fast` |
| `intent` | Retrieval intent from the plan |
| `candidateCount` → `selectedNodeCount` | The funnel. A low injection rate is a coverage problem when candidates are few and a filter problem when they are many |
| `stitchedRelationCount`, `stitchedChainCount` | What relation stitching added. Persistently zero means the graph is too sparse to stitch |
| `summaryEvidenceCount` | Contribution from the summary DAG |
| `firstHopNodeCount`, `secondHopNodeCount` | Where the second hop earns its cost, or does not |
| `queryCount`, `failureLookupCount` | Work done |
| `failureHits`, `decisionHits`, `messageHits` | Path attribution: which of the paths produced the surfaced content |
| `estimatedTokens` | Injected context cost |
| `surfacedNodeIds` | JSON array, joins to `memory_nodes` |
| `latencyMs` | Whole retrieval |

Funnel and path columns are **null when not measured**, never zero. Averaging
them must exclude nulls or an unmeasured call is counted as a miss.

**Derived:** injection rate by intent; candidate survival rate; share of
injections attributable to each path; smart-planner take rate and whether it
recalls more than the fast plan it replaced.

---

## `compaction_events`

One row per summary attempt, leaf and condensed alike.

| Column | Notes |
|---|---|
| `kind` | `leaf` or `condensed` |
| `trigger` | What asked for it |
| `summaryId` | Joins to `summaries` |
| `inputCount` | Messages for a leaf, **leaves for a condensed** |
| `inputChars`, `outputTokens` | Compression |
| `llmOutcome` | `ok`, `ok_after_retry`, `validation_failed`, `error`, `disabled` |
| `usedFallback` | 1 when the stored text is verbatim fragments, not a summary |
| `errorMessage` | Quota, timeout, or the validation reason |
| `model`, `latencyMs` | Cost |

`ok_after_retry` matters on its own: the first summary failed quality
validation and the retry saved it. A rising share means the prompt or the
token target is drifting out of range.

`validation_failed` and `error` both end in a fallback but are not the same
event. One is a model that answered badly twice, the other is a call that
never completed.

**Derived:** fallback rate; compression ratio; retry rate; fallback causes over
time. Compression ratio without fallback rate is misleading, because a
truncation fallback compresses by cutting, not by summarizing.

---

## `decision_judge_events`

One row per auto-supersede judge invocation. Only active when
`CODEMEMORY_AUTO_SUPERSEDE_VIA_LLM=true`.

| Column | Notes |
|---|---|
| `newNodeId` | The decision that triggered the check |
| `candidateCount` | Active decisions it was compared against |
| `outcome` | `superseded`, `all_kept`, `no_candidates`, `empty_verdict`, `error` |
| `supersededCount`, `supersededNodeIds` | What it retired |
| `errorMessage`, `latencyMs` | |

`all_kept` and `error` both leave zero supersedes behind. The first is the
judge working and being conservative, which is the designed behavior. The
second is an outage. Before this table they were the same empty result.

`empty_verdict` means the model answered but nothing parsed, which is a prompt
problem rather than either of the above.


---

## `ingestion_events`

One row per message the scorer ruled on, **including the N-tier ones it
discarded**. The drops are the reason this table exists: an N-tier message is
dropped before any write, so nothing else records that it was ever seen.

| Column | Notes |
|---|---|
| `messageId` | Joins to `conversation_messages`; null for a drop |
| `role`, `tier` | `S`, `M`, `L`, `N` |
| `tags` | JSON array. On a drop these are the rule that rejected it |
| `rawChars` | Size as it arrived, before scoring compressed it |
| `storedChars` | Size actually persisted. M and L keep metadata, not text |
| `stored` | 0 for an N-tier drop |
| `subagent` | 1 when the message came from a subagent transcript |

**Derived:** drop rate; drop reasons ranked by tag; character retention per
tier; subagent share of traffic. A single tag dominating the drops reads
either as the filter working or as one rule overreaching, and only the
transcript can say which.

---

## `extraction_events`

One row per key-memory extraction chunk, which is one model call. Chunks are
grouped by `runId`.

| Column | Notes |
|---|---|
| `runId` | Groups the chunks of one extraction |
| `chunkIndex`, `chunkCount`, `chunkChars` | Position and size |
| `sourceRawChars`, `sourceProseChars` | Whole-run figures repeated on each row. The prose filter drops tool traffic; the ratio is how much of a transcript the model never reads |
| `outcome` | `ok`, `parse_empty`, `error` |
| `itemCount` and the per-kind counts | What the chunk produced |
| `revisesCount` | Items that supersede an earlier statement |
| `errorMessage`, `model`, `latencyMs` | |

Per-chunk failures are caught so a partial rebuild survives. That is correct
behavior and it is exactly why this table is needed: a run reporting twelve
memories may have lost eight chunks, and the total alone cannot say so.

`parse_empty` is a model that answered with nothing parseable, which is a
prompt or format problem rather than an outage.

**Derived:** chunk success rate per run; memories per successful chunk; prose
filter reduction; revision rate, which is the signal that a session changed
its mind rather than simply accumulating.

---

## Reading the tables

`scripts/analyze-failure-recall.mjs` prints all six, sections ⑤ through ⑪,
alongside the anchor-coverage and signature-quality analyses that do not need
telemetry. Run it against a database with accumulated traffic; the sections
degrade to a "no data yet" line rather than misreporting an empty table.
