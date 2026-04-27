# Prior Failure Reference

> English version: [PRIOR_FAILURE_REFERENCE.md](./PRIOR_FAILURE_REFERENCE.md)

> 本文描述「先前失败 (prior failure)」能力的职责、数据流与在统一 Memory Node 模型下的存储结构。

## 1. 定位

Prior failure 不是通用记忆，而是专门服务于「避免重复犯错」的结构化失败记忆层。

它优先回答的问题是：

- 这个文件以前是不是在这里报过错
- 这个命令以前是不是失败过
- 这个 symbol 以前是不是有同类问题
- 这次修改是不是在重复之前的失败尝试

## 2. 存储模型

旧版独立的 `negative_experiences` 表已被并入 `memory_nodes`，靠 `kind='failure'` 与 tag 索引区分：

- `kind = 'failure'` 标识失败节点。
- `metadata` 携带 `type / signature / raw / filePath / command / symbol / location / attemptedFix / seq` 等结构化字段。
- `memory_tags` 写入 `kind='failure'`、`file=<path>`、`command=<bin>`、`symbol=<name>`、`signature=<norm>` 等多维标签，承担索引职责。
- 状态走 `MemoryNodeStore` 的统一生命周期：`active` → `resolved` / `stale`，`reopen` 也走同一通道。

入口 API：

- `MemoryNodeStore.createFailureNode(input)` — 写入失败节点 + 标签 + lifecycle 事件。
- `MemoryNodeStore.findFailuresByAnchors({ files, commands, symbols, signatures, statuses, limit })` — 主查询路径。
- `MemoryNodeStore.resolveFailureNodesByTarget(...)` — 用户信号 / 修复成功后的目标级关闭。
- `MemoryNodeStore.autoResolveStaleFailureNodes(...)` — 长期未复发的自动 resolve 扫描。

## 3. 数据流

```text
JSONL / tool result
  -> NegExpExtractor.extractFromErrorMessage   (src/negexp/extractor.ts)
  -> signature normalization                   (src/negexp/signature.ts)
  -> memoryStore.createFailureNode             (kind='failure' memory node)
  -> lookupForPreToolUse / retrieveForPrompt   (src/failure-lookup.ts, src/retrieval.ts)
  -> warning injection 或 prompt context
```

`src/negexp/extractor.ts` 仍然存在并被复用，它只负责把原始报错文本解析成结构化字段；存储层完全走 `memory_nodes`。

## 4. 当前能力

- error extraction & signature normalization
- file / command / symbol / signature 多维 tag 查询 (`findFailuresByAnchors`)
- confidence scoring + 30 天半衰期时间衰减 (`MIN_CONFIDENCE = 0.6`)
- 用户信号驱动的 resolve、reopen
- daemon 端的反洪水 debounce（同一 `nodeId` 60s 内不重复注入）
- 跨 session 召回（默认行为）

## 5. PreToolUse 行为

`PreToolUse` 是 prior-failure 最直接的价值体现。

执行流程：

1. 从工具输入提取 file / command / symbol
2. 优先打 daemon hot path（`/failure/lookup`，保留 `/negexp/lookup` 作为兼容别名）
3. fallback 到 cold path（`dist/failure-lookup-cli.js`）
4. 通过 `scoreMatch` 做 confidence 过滤
5. 结果强度足够时注入 markdown warning

当前原则：

- 不因 hook 失败阻塞工具调用
- 不把弱相关结果强塞给模型
- 默认允许跨 session failure 召回

## 6. 与 Memory Node 的关系

不再有「NegExp 或 Memory Node 二选一」的双层结构 —— failure 直接是 memory node 的一种 `kind`。

- 检索：`RetrievalEngine.retrieveForPrompt` 的 Path A 直接通过 `findFailuresByAnchors` 拿失败节点；Memory-first 主检索同样能命中它们。
- 生命周期：`LifecycleResolver` 直接读写 memory_nodes（`reopenFailure` / `resolveFailuresForSucceededAttempt` / `markSummaryStale`），无须双写。
- 关系图：失败节点可参与 `memory_relations` 中的 `relatedTo / resolves` 等边，进入 stitched chain 等更高层能力。

## 7. 当前边界

1. 最擅长 failure avoidance，不负责完整表达需求、决策和任务状态 —— 这些走对应 `kind` 的 memory node。
2. 主检索模型是 Memory-first，prior failure 是其中权重最高的一类信号，而不是独立通道。
3. 更系统的离线评测和长期质量采样仍在补齐中。
