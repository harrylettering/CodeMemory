# Tool Surface Reference

> English version: [TOOL_SURFACE_REFERENCE.md](./TOOL_SURFACE_REFERENCE.md)

> 本文描述当前项目里真正暴露给模型、hook、daemon 的工具与接口表面。

## 1. 模型可调用工具

### 1.1 默认工具

默认启用：

- `codememory_check_prior_failures`
- `codememory_mark_decision`
- `codememory_mark_requirement`
- `codememory_compact`

这些工具构成当前默认产品表面。

### 1.2 Debug / admin 工具

仅当 `debugToolsEnabled=true` 时注册：

- `codememory_grep`
- `codememory_describe`
- `codememory_expand`
- `codememory_expand_query`
- `codememory_memory_pending`
- `codememory_memory_lifecycle`

它们的角色更偏排障、观察、手工调试，不是默认 workflow 的主入口。

## 2. Hook 脚本

当前项目 hook 侧的主要入口：

- `session-start.sh`
- `user-prompt-submit.sh`
- `pre-tool-use.sh`
- `pre-compact.sh`
- `final-compact.sh`
- `session-end.sh`

职责分别是：

- 启停 daemon
- 请求 prompt retrieval
- 查询 prior-failure 预警
- 请求后台 compaction

## 3. Daemon socket 接口

当前 daemon 对外暴露的内部接口：

- `/retrieval/onPrompt`
- `/failure/lookup`（保留 `/negexp/lookup` 作为兼容别名）
- `/compact`

这些接口面向 hook 和本地运行时，不是模型直接调用的公开产品接口。

## 4. 当前工具设计原则

当前工具表面遵循三个原则：

1. 默认表面小  
   只保留最稳定、最有产品价值的工具

2. 诊断能力留在 debug 后面  
   grep / expand / lifecycle admin 仍然有价值，但不强行塞进默认路径

3. 自动检索优先于手工检索  
   目标是让系统主动在 prompt / tool use 阶段召回，而不是让模型频繁手工调用搜索工具

## 5. 当前推荐使用顺序

对正常使用者而言，优先顺序是：

1. 自动 prompt retrieval
2. `PreToolUse` 的 prior-failure warning
3. `codememory_mark_requirement`
4. `codememory_mark_decision`
5. `codememory_compact`

只有在排障和系统调试时，才建议打开 debug tools。
