# 会话记忆完全隔离 执行计划

## 项目信息
- 项目名称: 会话记忆完全隔离（第一步）
- 创建日期: 2026-09-18
- 版本: v1.0
- 基线: `main` @ 675dd86

## 目标与非目标

**目标**：会话之间的记忆完全不可见。一次会话只能召回自己产生的记忆。

**依据**：污染比丢失贵。实测当前 **49% 的召回节点来自别的会话**（126 本会话 / 121 跨会话）。

**非目标（第二步再做）**：从会话中蒸馏横轴（架构级）记忆，提升到项目级或全局级。本次**只做隔离，不做提升**，跨会话的数据保留在库里不动，作为第二步的原料。

## 验收指标

```
召回节点属于别的会话 = 0
```

统计方法：`retrieval_events.surfacedNodeIds` 逐个 join `memory_nodes.conversationId`，与事件行的 `conversationId` 比对。改造前基线 121。

---

## 阶段一：全项目审计结论

对所有读记忆表的查询做了逐条审计。**泄漏面比预期集中**。

### 本来就已经隔离的（不用动）

| 模块 | 查询 | 边界 |
|---|---|---|
| `compactor.ts` | 5 | 全部按 `conversationId` |
| `explored-targets-store.ts` | 2 | 全部按 `conversationId` |
| `integrity.ts` | 2 | 全部按 `conversationId` |
| `engine.ts` | 4 | 主查询带 `WHERE conversationId = ?` |
| `fix-attempt-tracker.ts` | 3 | 两处按会话，一处按主键 |
| `conversation-store.ts` | 7 | `searchMessages` 硬过滤 |

压缩、摘要 DAG、探索目标去重、修复追踪、消息检索这五条线都是干净的。

### 缺边界的：三个召回函数

```
searchByPlan            标签召回 + content 兜底     2 条 SQL
findFailuresByAnchors   失败锚点召回                 1 条 SQL
getRelationsForNodes    关系缝合（两跳）             6 条 SQL
```

其余"无边界"的查询都是**按主键查**（`WHERE nodeId = ?`），id 来自上游，上游隔离就够；或者是写入/维护路径（`runStaleMaintenance`、`createSummaryNode`），不产生注入。

### 缺边界的：两个模型可调工具（原计划漏掉）

`codememory_grep` 和 `codememory_expand_query` 挂在 `CODEMEMORY_DEBUG_TOOLS_ENABLED` 后面，**当前环境该开关为 true**。它们不走 `searchByPlan`，改那三个函数拦不住。

`codememory_grep` 的 schema **本来就没把 `conversationId` 暴露给模型**（只有 query/mode/scope/limit），但 `call` 直接透传 params，该字段为 undefined 时退化成全库搜。

**采用的方案：工具层统一注入，不暴露给模型。** 装配层已有 `getCurrentSessionId` 闭包（mark 类工具在用），检索类工具接上即可。边界放在模型够不着的地方，比放在参数校验里可靠。

### 确认事项

| # | 问题 | 决定 |
|---|---|---|
| A1 | `check_prior_failures` 工具是否隔离 | **是** |
| A2 | 生命周期维护（复发重开）是否隔离 | **否，本次不动**；不产生注入 |
| A3 | 是否保留 workspace key 作为第二重条件 | **否**；会话隔离严格强于项目隔离 |

**一个必须明说的后果**：`test/failure-lookup.test.ts:99` 那条测试叫
`injects across sessions (the whole point of cross-session recall)`。
它编码的是旧产品定义，本次会被**反转**。这不是测试坏了，是定义变了。

## 项目进度
```
[======··········] 43% 已完成
```

## 统计信息
- 总任务数: 7
- 已完成: 3
- 执行中: 0
- 待执行: 4
- 失败: 0
- 完成率: 43%

---

## 任务列表

### ✅ TASK-001: 基线测量脚本
- **状态**: completed
- **描述**: 把"召回节点跨会话占比"固化成可重复运行的脚本，记录改造前基线
- **预估时间**: 0.5 小时
- **优先级**: 高
- **依赖**: 无
- **测试策略**: test-after（工具脚本，产出是数字不是契约）
- **测试要求**: 在当前库上跑出非零基线，证明脚本能检出污染
- **代码质量要求**: 与 `scripts/analyze-failure-recall.mjs` 风格一致，默认只读
- **风险评估**:
  - 风险等级: 低
  - 风险描述: 无
- **回滚方案**: 删除脚本文件
- **完成时间**: 2026-09-19
- **交付物**: `scripts/check-session-isolation.mjs`
- **改造前基线**:
```
召回节点属于本会话     140  53.2%
召回节点属于别的会话   123  46.8%     ← 目标归零
污染来源 conv6←conv9 47 次，conv1←conv9 30 次，conv7←conv1 19 次
```
- **顺带发现**: 2 条 `retrieval_events` 的 `conversationId` 为 NULL，**且都召回了节点**。
  解析不出会话仍然返回结果，正是 TASK-003 要堵的退化路径，现在有了实证。

### ✅ TASK-002: searchByPlan 加会话过滤
- **状态**: completed
- **描述**: 标签召回的两条 SQL（tag 匹配、content LIKE 兜底）加 `AND n.conversationId = ?`，`conversationId` 从可选加权参数变为必需过滤条件
- **预估时间**: 1.5 小时
- **优先级**: 高
- **依赖**: TASK-001
- **测试策略**: **tdd**（核心召回契约，先用测试钉死"别的会话的节点查不到"）
- **测试要求**:
  - Red: 建两个 conversation，各写一个同标签节点，断言只召回本会话的 → 必须先失败
  - Green: 加过滤
  - 边界: `conversationId` 缺省时的行为（建议：返回空而非全量，失败要响）
- **代码质量要求**: `npx tsc --noEmit` 干净；两条 SQL 都要改，不能只改一条
- **风险评估**:
  - 风险等级: 中
  - 风险描述: `searchByPlan` 是记忆召回主入口，漏改一条 SQL 会留下静默泄漏
  - 应对建议: TASK-001 的脚本在本任务后立即跑一次，不等全部做完
- **回滚方案**: `git revert` 单个 commit
- **完成时间**: 2026-09-19
- **交付物**: `src/store/memory-store.ts`, `src/retrieval-plan.ts`, `test/session-isolation.test.ts`, `test/memory-store.test.ts`
- **Red 证据**: 三条断言全部失败，`expected [ 'decision-mine', 'decision-theirs' ] to not include 'decision-theirs'`
- **真实库验证**: conv1 / conv9 各召回 24 个，属于别的会话的均为 0；会话未知时召回 0
- **顺带发现**: `RetrievalPlan.scope` 的 `preferCurrentConversation` 和 `allowCrossSessionFailures` 两个字段
  **声明了、赋值了、从来没有任何地方读**（第三处"设计好没接上"的路）。已把 `allowCrossSessionFailures`
  改为 `false` 与实际行为一致，边界由 store 无条件强制，不做成 per-plan 开关
- **契约变更**: `memory-store.test.ts` 那条 `prefers current conversation` 改为 `within the conversation only`。
  偏好变成了排他，是契约变了不是测试坏了，注释里写明了

### ✅ TASK-003: findFailuresByAnchors 加会话过滤并打通热路径
- **状态**: completed
- **描述**: SQL 加过滤；`lookupForPreToolUse` 的 `options` 增加 `conversationId` 并由 daemon 与冷路径 CLI 传入
- **预估时间**: 2 小时
- **优先级**: 高
- **依赖**: TASK-002
- **测试策略**: **tdd**（跨模块契约变更，签名和行为都要先钉住）
- **测试要求**:
  - Red: 反转 `test/failure-lookup.test.ts:99`，改为断言跨会话**不**注入
  - 四个调用方逐一覆盖：daemon 热路径、冷路径 CLI、`retrieval.ts`、`check_prior_failures` 工具
  - 冷路径 CLI 只有 `sessionId`，需验证它能解析出 `conversationId`
- **代码质量要求**: 四个调用方全部显式传参，不允许依赖默认值
- **风险评估**:
  - 风险等级: **高**
  - 风险描述: 热路径拿不到 `conversationId` 时如果静默退化为"不过滤"，泄漏会完全无声
  - 应对建议: 拿不到就**返回空**，并写一行 `failure_lookup_events` 记 `no_target`，让埋点看得见
- **回滚方案**: `git revert`；该任务独立成 commit
- **完成时间**: 2026-09-19
- **交付物**: 上述五个文件，外加 `src/retrieval.ts`、迁移 31、5 个测试文件
- **真实库验证**: 样本失败节点属于 conv10；以 conv10 查到 1 个候选，以 conv999 查到 0 个，
  会话未知查到 0 个；热路径无作用域时 `shouldInject=false` 且 `unresolvedConversation=true`
- **计划外增加的迁移 31**: `failure_lookup_events.unresolvedConversation`。
  原计划说复用 `no_target`，实施时判定那是**把两种原因合并**——"查了没找到"和"根本没查"
  需要相反的修法，而 outcome 的 CHECK 约束不重建表就加不了值，所以用一列而不是新值
- **反转的测试**: `injects across sessions (the whole point of cross-session recall)`
  → `does not inject a failure another session recorded`，注释写明是产品定义变了

### ⏳ TASK-003b: 检索类工具统一注入 conversationId
- **状态**: pending
- **描述**: `codememory_grep`、`codememory_expand_query`、`codememory_describe`、`codememory_expand` 四个工具在装配层接上 `getCurrentSessionId`，在 `call` 内部解析出 `conversationId` 并强制注入；schema 不暴露该参数
- **预估时间**: 1.5 小时
- **优先级**: 高
- **依赖**: TASK-002
- **测试策略**: **tdd**（这是一个绕过口，必须先有一条"模型能搜到别的会话"的失败测试）
- **测试要求**:
  - Red: 直接调工具的 `call`，不传 `conversationId`，断言搜不到别的会话的内容 → 必须先失败
  - 断言 schema 的 `properties` 里**没有** `conversationId` 键，防止将来被加回去
  - 解析不出会话时返回空结果，不退化成全库搜
- **代码质量要求**: 四个工具全部改，不能只改 grep；装配层复用既有闭包，不新造一个
- **风险评估**:
  - 风险等级: 中
  - 风险描述: 这批工具挂在 debug 开关后，容易被认为"不重要"而漏改；但当前环境该开关是开的
  - 应对建议: 测试不受开关影响，直接测工具对象
- **回滚方案**: `git revert`
- **交付物**: `src/plugin/index.ts`, `src/tools/codememory-grep-tool.ts`, `src/tools/codememory-expand-query-tool.ts`, `src/tools/codememory-describe-tool.ts`, `src/tools/codememory-expand-tool.ts`

### ⏳ TASK-004: getRelationsForNodes 加会话过滤
- **状态**: pending
- **描述**: 关系缝合的两跳查询加过滤；`relationConversationBonus` 在隔离后恒定，标记为待删并加注释说明原因
- **预估时间**: 1 小时
- **优先级**: 中
- **依赖**: TASK-002
- **测试策略**: **tdd**（图遍历边界，容易漏第二跳）
- **测试要求**:
  - Red: 构造一条跨会话的 `relatedTo` 边，断言缝合不到对面
  - **两跳都要覆盖**：`memory-retrieval.ts:220` 和 `:405` 是两个独立调用点
- **代码质量要求**: 不删 `relationConversationBonus`，只标注，避免和本次改动混在一起
- **风险评估**:
  - 风险等级: 低
  - 风险描述: 实测关系缝合只贡献 14 条边，影响面小
  - 应对建议: 无
- **回滚方案**: `git revert`
- **交付物**: `src/store/memory-store.ts`, `src/memory-retrieval.ts`, `test/session-isolation.test.ts`

### ⏳ TASK-005: 回归测试审计
- **状态**: pending
- **描述**: 逐一审查依赖跨会话可见的既有测试，判定"反转"还是"改成同会话"，不允许简单删除
- **预估时间**: 1.5 小时
- **优先级**: 高
- **依赖**: TASK-002, TASK-003, TASK-003b, TASK-004
- **测试策略**: test-after（本任务的产出就是测试本身）
- **测试要求**: 已知受影响文件 4 个：`retrieve-for-prompt`、`negexp-symbol-e2e`、`negexp-symbol-retrieval`、`memory-store`；每处改动写明改的理由
- **代码质量要求**: 全套 346 个测试通过
- **风险评估**:
  - 风险等级: 中
  - 风险描述: 把测试改绿最省事的办法是删掉断言，那样会把真实的行为退化一起藏掉
  - 应对建议: 每一处改动在 commit message 里说明是"契约变了"还是"测试写错了"
- **回滚方案**: 不适用
- **交付物**: 上述 4 个测试文件

### ⏳ TASK-006: 验收与文档
- **状态**: pending
- **描述**: 跑 TASK-001 的脚本确认归零；更新 CLAUDE.md 中"跨会话检索刻意保留双方可见"这条已经失效的不变量
- **预估时间**: 1 小时
- **优先级**: 高
- **依赖**: TASK-005
- **测试策略**: test-after
- **测试要求**:
  - 脚本输出"召回节点属于别的会话 = 0"
  - 在真实库副本上验证，不改动线上库
  - **新数据验证**：隔离只对改造后产生的 `retrieval_events` 有效，历史行仍是旧值，统计要按时间切
- **代码质量要求**: `npm run plugin:release-check` 通过
- **风险评估**:
  - 风险等级: 低
  - 风险描述: 拿历史埋点算验收会得出"没改好"的错误结论
  - 应对建议: 脚本加 `--since` 参数
- **回滚方案**: 不适用
- **交付物**: `CLAUDE.md`, 验收输出

---

## 全局风险

| 风险 | 等级 | 说明 | 应对 |
|---|---|---|---|
| 静默退化 | **高** | 任一路径拿不到 `conversationId` 就不过滤，泄漏无声 | 统一约定：拿不到就返回空，并留埋点 |
| 召回量骤降 | 中 | 隔离后本会话早期记忆变少，注入率可能下降 | 这是预期结果不是 bug；用 `retrieval_events.outcome` 观察，不要急着放宽 |
| 第二步的原料 | 中 | 跨会话数据不再可见，但必须保留 | 本次**不删任何数据**，只改查询 |
| 产品定义变更未记录 | 中 | CLAUDE.md 的不变量与新行为矛盾 | TASK-006 必须改文档，否则下一个人会"修回去" |
| 工具层绕过口重开 | 中 | 将来有人给工具 schema 加回 `conversationId` 参数 | TASK-003b 的测试直接断言 schema 里没有该键 |

## 提交策略

七个任务对应七个 commit，TASK-002/003/003b/004 各自独立，便于单独 revert。全部完成后合成一个 PR。

按既有约定：**不主动 push，不主动开 PR**。
