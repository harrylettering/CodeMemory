# 子 agent 身份标记 执行计划

## 项目信息
- 名称: 记忆归属到具体 agent（第一步：标记，不改检索）
- 创建日期: 2026-09-20
- 版本: v1.0
- 基线: `main` @ 8c40a40（#19–#22 已合并，#23 待合并）

## 目标与非目标

**目标**：每一条消息和记忆节点都记下"是谁产生的"——主 agent，还是哪一个子 agent、哪一轮派发。

**非目标**：**不改检索范围。** 今天实测的边界（子 agent 只收得到失败警告）暂时保持不动。要不要改，等有数据再定。

## 为什么先做标记

现在最实际的风险不是"子 agent 读不到东西"，是**写入无法区分**。

子 agent 能调 `codememory_mark_decision` 和 `codememory_mark_requirement`，写进去的节点落在父会话的 conversation 里，而 `memory_nodes` 表**没有任何 agent 标记**。一个被派去修测试的子 agent 顺手标的一条决策，和主 agent 深思熟虑定下的架构决策在库里长得一模一样，事后也分不出来。

> 读不到只是少了信息。写进去分不清，是污染判断依据本身。

## 阶段一：身份从哪来（已实测，不需再确认）

三条写入路径**各自就地拿得到身份，不需要维护"当前活跃 agent"这种全局状态**。

| 路径 | 身份来源 | 现状 |
|---|---|---|
| 摄入 | 记录条目自带 `agentId` / `promptId` | `jsonl-watcher.ts` 里两处 `agentId` **都是注释**，没有真正解析 |
| 失败查找 | `PreToolUse` 载荷带 `agent_id` / `agent_type` / `prompt_id` | `pre-tool-use.sh` 只转发 `session_id`、`tool_name`、`cwd` |
| 标记写入 | 工具层注入 | 落点与 #20 的会话注入相同 |

实测对照（同一次探针）：

```
子 agent 的调用   agent_id=a0ff7a03…  agent_type=general-purpose
主 agent 的调用   agent_id=无          agent_type=无
```

**主 agent 的标志是这个字段不存在**，不是某个特殊值。所以列可空，`NULL` 即主 agent——与 `sourceUuid` 同一约定。

`promptId` 必须一起带：同一次派发里 `prompt_id` 相同而 `agent_id` 不同，**两个字段组合才是完整身份**，也是区分并行子 agent 的唯一依据。

### 明确不做的

**不注册 `SubagentStart` / `SubagentStop`。** 它们的载荷确实好用（`agent_transcript_path` 给出子 agent 记录的确切路径，`last_assistant_message` 直接给出回传给父会话的结论），但既然 `PreToolUse` 已经带 `agent_id`，标记这件事用不上它们。它们属于下一步——精确摄入、抓取返回结论——不该和标记混在一起。

---

## 项目进度
```
[========········] 50% 已完成
```

## 统计信息
- 总任务数: 4
- 已完成: 2
- 待执行: 2
- 完成率: 50%

---

## 任务列表

### ✅ T1: 摄入侧带上 agent 身份
- **状态**: completed
- **描述**: `jsonl-watcher` 解析 `agentId` / `promptId` 并放进 `JsonlMessage`；`ingestOne` 传给 `insertMessage`；迁移给 `conversation_messages` 加两列
- **预估时间**: 1.5 小时
- **优先级**: 高
- **依赖**: 无
- **测试策略**: **tdd**（解析契约，先钉住"主 agent 的条目解析出 undefined"）
- **测试要求**:
  - Red: 用真实形状的子 agent 条目断言解析出 `agentId`，主 agent 条目断言是 `undefined` → 必须先失败
  - 主 agent 的行必须存成 `NULL`，不能存成字符串 `"undefined"` 或空串
  - 同一会话两个不同 `agentId` 的条目分别存对
- **代码质量要求**: `sourceUuid` 已经趟过一次同样的路，字段传递照它的形状走
- **风险评估**:
  - 风险等级: **中**
  - 风险描述: `CodeMemoryJsonlWatcher` 的构造函数曾经把选项重建成只列举已知键的新对象，导致新字段**声明了、传了、通过类型检查、却永远不生效**。#23 改成了先展开再套默认值，但同类陷阱可能还在别处
  - 应对建议: 测试断言解析结果本身，不只断言"写进去没报错"
- **回滚方案**: `git revert`
- **完成时间**: 2026-09-20
- **交付物**: `src/hooks/jsonl-watcher.ts`, `src/hooks/daemon.ts`, `src/store/conversation-store.ts`, 迁移 33, `test/agent-attribution.test.ts`
- **变异检验**（针对计划里"新字段静默失效"那条高风险）:

| 变异 | 结果 |
|---|---|
| 去掉 watcher 的 `agentId` 解析 | 1 条红 ✓ |
| 去掉 `insertMessage` 的字段绑定 | 2 条红 ✓ |

  两段各自独立可失败，说明字段是真的在起作用，不是"写进去没报错"
- **真实数据端到端**: 拿线上一份真实子 agent 记录跑通，解析出
  `agentId=a46733a66c860abb9  promptId=83be3dd3…`
- **迁移验证**: 真实库副本 7751 条消息完好，两列就位

### ✅ T2: 记忆节点带上 agent 身份
- **状态**: completed
- **描述**: 迁移给 `memory_nodes` 加 `producerAgentId` / `producerPromptId`；`createFailureNode` 等写入点从触发它的消息继承
- **预估时间**: 2 小时
- **优先级**: **最高**
- **依赖**: T1
- **测试策略**: **tdd**（这是防写入污染的那一条，必须先有一条"分不出来"的失败测试）
- **测试要求**:
  - Red: 同一个 conversation 里，一条子 agent 产生的失败节点和一条主 agent 产生的，断言可区分 → 必须先失败
  - 六种 kind 逐一覆盖写入点，不能只改 failure
  - 主 agent 产生的节点该是 `NULL`
- **代码质量要求**: 继承链要显式——节点的身份来自产生它的消息，不是来自"当前某个全局变量"
- **风险评估**:
  - 风险等级: 中
  - 风险描述: 写入点分散（failure / fix_attempt / summary / decision / task / constraint），漏一个就留一类分不出来的节点
  - 应对建议: 测试按 kind 枚举，不按调用点枚举
- **回滚方案**: `git revert`
- **完成时间**: 2026-09-20
- **交付物**: `src/store/memory-store.ts`, `src/hooks/daemon.ts`, 迁移 34, 测试
- **按 kind 枚举奏效了**: 五个 `create*` 函数全部汇入 `upsertNode`，所以 SQL 只有一处，
  但**入参类型分散**。`it.each` 逐 kind 断言之后，六种都确认能带上身份
- **变异检验**: 去掉 `upsertNode` 的字段绑定 → **9 条红**
- **迁移验证**: 真实库副本 333 个节点完好；存量**全部为 NULL**——历史数据无法回溯归属，
  这是预期的，不是缺陷
- **过程记录**: 用正则往 `createFailureNode` 插转发代码，连续三次落到了
  `createFixAttemptNode` 上（两者在同一段匹配范围内，且前者用 `return this.upsertNode({`
  而非 `const node = await`）。两次造成重复键、一次完全没改到。最后改用行号定位才对。
  **正则改代码在相似结构上不可靠**，这已是本轮第二次

### ⏳ T3: 标记工具注入 agent 身份
- **状态**: pending
- **描述**: `pre-tool-use.sh` 把 `agent_id` / `agent_type` / `prompt_id` 转发给 daemon；mark 工具在装配层注入，**schema 不暴露**
- **预估时间**: 1.5 小时
- **优先级**: 高
- **依赖**: T2
- **测试策略**: **tdd**
- **测试要求**:
  - Red: 直接调工具的 `call`，伪造一个 `producerAgentId` 参数，断言**被覆盖而不是被采信** → 必须先失败
  - 断言 schema 的 `properties` 里**没有** `producerAgentId`，防止将来被加回去
  - 转发链完整：hook 脚本 → daemon 路由 → 工具
- **代码质量要求**: 与 #20 的会话注入同一个落点和同一个模式，不新造机制
- **风险评估**:
  - 风险等级: 中
  - 风险描述: 身份若可由模型指定，就可以被伪造；而这条链最长（脚本 → 路由 → 工具），中间任一段漏掉都是静默的
  - 应对建议: 端到端测一次完整链路，不只测工具层
- **回滚方案**: `git revert`
- **交付物**: `hooks/scripts/pre-tool-use.sh`, `src/hooks/daemon.ts`, `src/tools/codememory-mark-*.ts`, `src/plugin/index.ts`, 测试

### ⏳ T4: 埋点升级并观察
- **状态**: pending
- **描述**: `ingestion_events.subagent` 布尔升级成 `producerAgentId`；分析脚本加一节；**然后停下来看数据**
- **预估时间**: 1 小时
- **优先级**: 中
- **依赖**: T1, T2, T3
- **测试策略**: test-after
- **测试要求**: 新旧列并存期间统计不能重复计数；历史行的 `subagent=1` 要能继续读
- **代码质量要求**: 与 `TELEMETRY_REFERENCE` 的既有风格一致
- **风险评估**:
  - 风险等级: 低
- **回滚方案**: 不适用
- **交付物**: 迁移 35, `scripts/analyze-failure-recall.mjs`, 文档

---

## 全局风险

| 风险 | 等级 | 说明 | 应对 |
|---|---|---|---|
| 新字段静默失效 | **高** | 这个代码库已经出现过三次"声明了、传了、过了类型检查、却不生效"：watcher 构造函数丢弃未列举的键、目录守卫补丁没落到位、工具参数透传成 undefined | 每个字段都要有一条断言**它的值**的测试，不能只断言写入没报错 |
| 写入点漏改 | 中 | 六种 kind 分散在不同函数 | 测试按 kind 枚举 |
| 身份可伪造 | 中 | 模型可调的工具若接受身份参数 | 装配层注入，schema 不暴露，测试断言 schema |
| 过早设计边界 | 中 | 有了标记就想顺手改检索 | 本计划范围内**不改检索**，等 T4 的数据 |

## 数据观察目标（T4 之后）

做完标记后，这些问题第一次变得可答：

- 子 agent 产生了多少记忆节点，分 kind 各多少
- 这些节点后来被召回过几次，被谁召回
- 子 agent 有没有真的在调 `mark_decision`（现在完全不知道）
- 并行子 agent 的记忆有没有互相串

**在这些数字出来之前，不动检索范围。** 否则又会变成凭感觉调阈值。

## 提交策略

四个任务对应四个 commit，T1/T2/T3 各自独立可 revert。全部完成后合成一个 PR。

按既有约定：**不主动 push，不主动开 PR**。
