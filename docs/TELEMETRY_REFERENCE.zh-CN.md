# 埋点数据参考

`~/.claude/codememory.db` 里有六张表记录记忆系统做了什么，**包括什么都没做的那些次**。它们存在的原因是：每一个主打功能都曾经无法和"从来没跑过"区分开。六张表都是尽力而为写入，埋点失败绝不会让它描述的操作失败。

| 表 | 一行代表 | 回答什么 |
|---|---|---|
| `failure_lookup_events` | 一次 PreToolUse 查找 | 历史失败警告有没有触发，没触发的话是哪一层吞掉的 |
| `retrieval_events` | 一次 UserPromptSubmit 检索 | 召回了什么、走哪条路径、漏斗在哪一段损失 |
| `compaction_events` | 一次摘要生成 | 摘要是模型写的还是截断降级的 |
| `decision_judge_events` | 一次自动 supersede 判官调用 | 判官跑没跑、同不同意、有没有失败 |
| `ingestion_events` | 一个被打分的消息 | 进来了什么、什么被当噪音丢掉、按哪条规则丢的 |
| `extraction_events` | 一次抽取的一个 chunk | 报出来的记忆条数，实际花了几次模型调用 |

看板要把"结果为空"的行当作数据，不是当作缺数据。空结果是分母。

---

## `failure_lookup_events`

历史失败警告的热路径。

| 列 | 说明 |
|---|---|
| `conversationId`、`sessionId` | 作用域 |
| `toolName` | 即将执行的工具 |
| `targetFile`、`targetCommand` | 原始值，工具收到什么就是什么 |
| `targetFileTag`、`targetCommandTag` | 归一化成 `memory_tags` 的形式。**join 用这两列，不要用原始列。** |
| `outcome` | `injected`、`debounced`、`below_confidence`、`no_candidates`、`no_target` |
| `candidateCount`、`passedCount` | 置信度阈值前后 |
| `topScore` | 最高分，包括被阈值挡下时的最高分 |
| `surfacedNodeIds` | JSON 数组，可 join `memory_nodes` |
| `source` | `daemon`（socket）或 `cli`（冷路径兜底） |

四种非注入结果要用相反的办法解决。`no_target` 是抽取问题，`no_candidates` 是覆盖问题，`below_confidence` 是阈值问题，`debounced` 是设计如此。

**衍生指标：** 全部查找的注入率；至少有一个候选时的注入率。两者背离说明瓶颈不在阈值。

---

## `retrieval_events`

每个进入检索的提示一行，包括注入为空的。

| 列 | 说明 |
|---|---|
| `promptLength`、`injectedChars`、`outcome` | `outcome` 取 `injected` 或 `empty` |
| `plannerSource` | `fast`、`smart` 或 `fallback` |
| `plannerAttempted`、`plannerReason`、`plannerError` | `fallback` 指 smart 规划器跑了并抛异常；在返回结果里它和 `fast` 长得一样 |
| `intent` | 计划判定的检索意图 |
| `candidateCount` → `selectedNodeCount` | 漏斗。候选少是覆盖问题，候选多而选中少是筛选问题 |
| `stitchedRelationCount`、`stitchedChainCount` | 关系缝合的贡献。长期为 0 说明图太稀疏，缝不起来 |
| `summaryEvidenceCount` | 摘要 DAG 的贡献 |
| `firstHopNodeCount`、`secondHopNodeCount` | 第二跳的成本值不值 |
| `queryCount`、`failureLookupCount` | 工作量 |
| `failureHits`、`decisionHits`、`messageHits` | 路径归因：注入的内容到底哪条路径产出的 |
| `estimatedTokens` | 注入上下文的成本 |
| `surfacedNodeIds` | JSON 数组，可 join `memory_nodes` |
| `latencyMs` | 整次检索耗时 |

漏斗和路径这些列**没测量时是 null，不是 0**。求平均必须排除 null，否则一次没测量的调用会被算成一次未命中。

**衍生指标：** 按 intent 分的注入率；候选存活率；各路径在注入中的占比；smart 规划器的使用率，以及它是否真的比它替换掉的 fast plan 召回更多。

---

## `compaction_events`

每次摘要生成一行，leaf 和 condensed 都记。

| 列 | 说明 |
|---|---|
| `kind` | `leaf` 或 `condensed` |
| `trigger` | 谁触发的 |
| `summaryId` | 可 join `summaries` |
| `inputCount` | leaf 是消息数，**condensed 是叶子数** |
| `inputChars`、`outputTokens` | 压缩量 |
| `llmOutcome` | `ok`、`ok_after_retry`、`validation_failed`、`error`、`disabled` |
| `usedFallback` | 为 1 表示存的是原文片段，不是摘要 |
| `errorMessage` | 额度、超时，或校验失败原因 |
| `model`、`latencyMs` | 成本 |

`ok_after_retry` 本身有意义：第一版摘要没通过质量校验，重试救回来了。这个占比上升说明提示词或 token 目标正在漂出合理区间。

`validation_failed` 和 `error` 都以降级收场，但不是一回事。一个是模型连答两次都答砸，一个是调用根本没完成。

**衍生指标：** 降级率；压缩比；重试率；降级原因随时间的变化。**只看压缩比不看降级率会得出错误结论**，因为截断降级是靠砍掉内容压缩的，不是靠总结。

---

## `decision_judge_events`

**历史数据。** 每次自动 supersede 判官调用一行。判官已在压缩时抽取接管 supersede 之后下线，不再产生新行。它留下的 29 行全部是额度失败，这正是下线它的依据。

| 列 | 说明 |
|---|---|
| `newNodeId` | 触发这次检查的新决策 |
| `candidateCount` | 参与比对的活跃决策数 |
| `outcome` | `superseded`、`all_kept`、`no_candidates`、`empty_verdict`、`error` |
| `supersededCount`、`supersededNodeIds` | 退役了哪些 |
| `errorMessage`、`latencyMs` | |

`all_kept` 和 `error` 都是零次 supersede。前者是判官正常工作并保持保守，这是设计意图；后者是功能挂了。这张表之前，两者是同一个空结果。

`empty_verdict` 指模型答了但一条都没解析出来，这既不是前者也不是后者，是提示词问题。


---

## `ingestion_events`

每个被打分的消息一行，**包括被判为 N 而丢弃的那些**。丢弃才是这张表存在的理由：N 档消息在任何写入之前就被丢掉，别处没有任何记录能证明它曾经出现过。

| 列 | 说明 |
|---|---|
| `messageId` | 可 join `conversation_messages`；被丢弃时为 null |
| `role`、`tier` | `S`、`M`、`L`、`N` |
| `tags` | JSON 数组。被丢弃时，这就是把它踢掉的规则 |
| `rawChars` | 进来时的大小，打分压缩之前 |
| `storedChars` | 实际落库的大小。M 和 L 存的是元数据，不是正文 |
| `stored` | N 档丢弃为 0 |
| `subagent` | 为 1 表示来自 subagent 的 transcript。早于 `producerAgentId`，现在两者一起写，所以按任一列统计新行结果一致 |
| `producerAgentId` | 是哪个子 agent，主 agent 为 NULL。此列之前的行只有布尔标记 |
| `producerPromptId` | 属于哪一轮派发；同一轮派出的两个子 agent 靠它区分 |

**衍生指标：** 丢弃率；按 tag 排序的丢弃原因；各档的字符留存率；subagent 流量占比。**某一个 tag 在丢弃里占绝对多数**，既可能是过滤器正常工作，也可能是某条规则下手太重，只有翻原始 transcript 才能判断。

---

## `extraction_events`

关键记忆抽取的每个 chunk 一行，一个 chunk 就是一次模型调用。同一次抽取的多个 chunk 用 `runId` 归组。

| 列 | 说明 |
|---|---|
| `runId` | 把一次抽取的多个 chunk 归为一组 |
| `chunkIndex`、`chunkCount`、`chunkChars` | 位置和大小 |
| `sourceRawChars`、`sourceProseChars` | 整次运行的数值，重复写在每一行上。prose 过滤会去掉工具流量，两者之比就是模型根本不用读的那部分 |
| `outcome` | `ok`、`parse_empty`、`error` |
| `itemCount` 及分 kind 的计数 | 这个 chunk 产出了什么 |
| `revisesCount` | 覆盖了更早陈述的条目数 |
| `errorMessage`、`model`、`latencyMs` | |

单个 chunk 失败会被捕获，这样部分重建仍能保留。这是正确的行为，也正是需要这张表的原因：**一次报出 12 条记忆的运行，可能有 8 个 chunk 全挂了**，光看总数看不出来。

`parse_empty` 指模型答了但解析不出东西，这是提示词或格式问题，不是故障。

**衍生指标：** 每次运行的 chunk 成功率；每个成功 chunk 的产出条数；prose 过滤的压缩比；修订率，这是"会话改过主意"而非"只是不断累加"的信号。

---

## 怎么读

`scripts/analyze-failure-recall.mjs` 会打印六张表，对应第 ⑤ 到 ⑪ 节，和不依赖埋点的锚点覆盖率、签名质量分析放在一起。在有实际流量的库上跑；没有数据时各节会退化成一行"尚未产生数据"，而不是把空表误报成结论。

### `compaction_events` 上的抽取列

抽取搭在压缩调用上，所以它的成本和产出记在同一行。这个配对本身就是要回答的问题：搭便车是为了不新增调用，而只有成本和产出放在一起，才能说明多出来的输入值不值。

| 列 | 含义 |
|---|---|
| `promptChars` | 整个提示的长度，也就是这次调用真正付费的部分。`inputChars` 只统计转录那一段。 |
| `dialogueChars` | 窗口自己的对话文字。为 0 表示这是纯工具调用窗口，抽取整个跳过。 |
| `candidateCount` | 发给模型的候选记忆条数。 |
| `candidateFromSurfaced` / `candidateFromRecent` / `candidateFromScan` | 来源：窗口内提示时召回过的（A）、上次压缩之后新写入的（B）、锚点扫描（C）。A 覆盖近期 85% 的窗口；这个比例下降，说明是扫描在扛着，而扫描的权重是拍出来的。 |
| `candidateDropped` | 被字符预算挤掉的候选数。长期大于零，才说明按相关度挑选值得它的成本。 |
| `extractionAdded` / `extractionUpdated` / `extractionInvalidated` | 实际写入了什么。 |
| `extractionRejected` | 被拒绝的操作：目标 id 不在候选里、缺目标、空陈述、本轮不产出的 kind、对同一节点的矛盾操作。模型反复点名没给过的 id，是提示词的问题，而这里是唯一能看出来的地方。 |
| `extractionRetries` | 降级之后的补做次数，上限 2。降级意味着根本没到模型，那个窗口还欠一次抽取；补做只补抽取，不重做摘要。 |

`retrieval_events.promptId` 记录这次召回服务的是哪一轮，压缩窗口因此能精确对上它覆盖的轮次，而不是靠时间范围去套。
