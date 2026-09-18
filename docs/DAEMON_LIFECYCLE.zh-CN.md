# Daemon 生命周期

CodeMemory 的运行时是一个**按会话**的 daemon，通过 Unix socket 对外服务。这份文档记录它什么时候生、什么时候死、为什么按现在这个维度切，以及和每个 hook 的关系。

> **注意**：第 4 节讨论的"按项目切"是**论证过但尚未实现**的改动。今天的实现仍然是按会话。读这一节时请注意区分"现状"和"结论"。

## 1. 什么时候启动

只有一个启动入口：`hooks/scripts/ensure-daemon.sh`。任何需要 daemon 的地方都调它，**不允许第二个 spawn 点**，测试里有守卫盯着这条。

它的契约极简：

```
ensure-daemon.sh <session_id> <cwd> [timeout]
退出 0 = socket 已就绪
退出 1 = 没起来，原因打到 stdout
```

健康的 socket 直接返回，所以重复调用是幂等的。实测连调三次只有一个进程。

两个调用方：

| 时机 | 超时预算 | 为什么 |
|---|---|---|
| **SessionStart** | 3 秒 | 会话开始，还没人在等，可以多等 |
| **UserPromptSubmit**（socket 不存在时） | 1.5 秒 | 跑在用户回车到模型开始之间，起不来就下轮再试 |

第二个入口是后加的。daemon 会空闲自退之后，一个安静一阵又回来的会话会发现没有 socket，而在此之前 `user-prompt-submit.sh` 只会返回 noop，**这个会话余下的时间都不会再有注入**。

**刻意不放在 `pre-tool-use.sh`。** UserPromptSubmit 每轮只触发一次，而且在这一轮的工具之前，等 PreToolUse 跑的时候 daemon 已经回来了。把启动放进每次工具调用的路径，会威胁"钩子绝不阻塞工具执行"这条不变量。`pre-tool-use.sh` 有自己的冷路径 CLI 兜底。

### 并发启动

两个 hook 同时发现没 socket 是可能的。**socket bind 本身就是锁**：输的那个撞 EADDRINUSE，daemon 的 error 处理器让它退出，而不是没有 socket 地干耗着。

这里有个陷阱值得单独记：pid 文件是在 bind **之前**写的，所以输家已经把赢家的 pid 覆盖掉了。error 处理器回收 pid 文件前必须确认文件里写的是自己的 pid，否则会留下一个活着的 daemon 却没有 pid 文件，`stop` 和扫描都找不到它。

实测并发起 5 个：存活 1 个进程、1 个 socket、pid 文件指向存活的那个。

## 2. 什么时候结束

三条路，**可靠性递减**：

**空闲自退（主要路径）。** daemon 自己记活动时钟，任何 hook 访问 socket、或 transcript 出现新行都会重置。超过 `CODEMEMORY_DAEMON_IDLE_TIMEOUT_MS`（默认 30 分钟）就走正常 `cleanup()`，socket 和 pid 文件一起清掉。

**SessionEnd（不可靠）。** `session-end.sh` 调 `daemon.js stop`，逻辑本身是完整的：读 pid、SIGTERM、等 2 秒、再 SIGKILL。但它**只在钩子真的跑完时才生效**，而终端直接关掉、`kill -9`、机器休眠、插件中途被替换，它都不会跑完。

**SessionStart 扫描（收尸）。** `session-start.sh` 开头遍历 runtime 目录，清掉进程已不存在的 pid/sock 对，以及没有 pid 文件陪着的孤儿 socket。**只删文件，从不发信号**，所以 PID 复用不可能导致误杀，最坏只是多留一对文件。

### 为什么不能只靠 SessionEnd

这不是理论问题。排查时在这台机器上发现 **5 个活着的 daemon，其中两个来自 5 天前就结束的会话**。收尾钩子被取消过，日志里有 `Hook cancelled`。

依赖外部信号收尾的设计一定会漏，因为那个信号本身不保证送达。空闲自退不需要任何人配合。

## 3. 为什么依赖 offset 落盘

**这是整个改造的顺序依据。空闲自退只有在读取位置持久化之后才安全。**

watcher 的 offset map 原本只在进程内存里。进程一死，读到哪就忘了，重启只有两个选择，而且**都会丢东西**：

| 做法 | 重复 | 丢失 |
|---|---|---|
| 倒回 0 重读 | 每次重启把全部历史再灌一遍 | 无 |
| seed 到文件末尾 | 无 | daemon 不在的那段 |

第二个是当初发布的止血方案（`67edf92`）。它的代价在每次 `--resume`、每次崩溃恢复、每次插件升级时都要付。

如果在这个前提下加空闲自退，等于**拿掉一个进程泄漏，换来一个每天发生好几次的静默丢数据**。这买卖不划算。

`watcher_offsets` 表按文件记位置之后，重启变成**无缝续读**。daemon 退出的代价从"丢掉这期间的全部消息"降到"延迟摄入"——下一个 daemon 从存储的位置接着读。代价小了，超时就敢设短。

两个实现细节：

- **先恢复，再 seed。** `seedExistingFilesToEnd` 现在只作用于没有存储 offset 的文件。有记录的续读，没记录的（真正没见过的新文件）仍按原逻辑跳过。
- **dispatch 之后才落盘。** 中间崩溃会重读这一批，代价是最多一个轮询周期的重复行；先落盘则是丢掉这一批。**重读是可恢复的方向，丢失不是。**

## 4. 维度：为什么不是全局一个

> 本节是论证，不是现状。今天 socket 仍然是 `<sessionId>.sock`。

### 先说为什么现在的按会话是错配

watcher 盯的目录由 `projectPath` 推导，**和 sessionId 无关**：

```ts
const dashedDirName = this.pathToDashedDir(options.projectPath);
this.projectWatchPath = join(home, ".claude", "projects", dashedDirName);
```

而且没有任何按 session 过滤文件的逻辑。所以今天的形态是**一个 per-session 的进程，持有一个 per-project 的资源**。同一个项目开两个会话，就是两个进程盯同一个目录、各自读目录里的每一个 transcript。

归属不会错（`ingestOne` 按 transcript 条目自带的 sessionId 解析 conversation），但**做了两遍，而且没有去重**。这台机器上还没触发，只是因为同项目的会话基本是串行的。

### 为什么不是全局一个

因为 `workspaceKey()` 读的是**进程级**的 `CODEMEMORY_WORKSPACE_ROOT`：

```ts
return process.env.CODEMEMORY_WORKSPACE_ROOT || process.cwd();
```

文件标签的格式是 `<sha256(workspaceRoot)[:8]>:<相对路径>`，这个前缀是**项目之间唯一的隔离边界**（检索按标签匹配，不按 conversationId 过滤）。

一个服务多项目的 daemon，进程环境里放不下多个 workspace root。要么把它改成随每条请求传进来并去掉模块级缓存，要么就退回同一个错误——那个错误刚在 0.5.0 修掉，当时的实际后果是两个不相干的项目拿到过字节数完全相同的注入内容。

另外两条：

- **爆炸半径。** 崩一个只影响一个仓库，而不是全部会话。这个项目有过 100% daemon 死亡率持续数月的历史。
- **版本锁定。** 长命的共享 daemon 会把插件版本钉死，新会话起来时如果老 daemon 还在就静默用旧代码。这几天刚在版本分叉上吃过亏，同时跑过三个版本。

### 为什么按项目是对的

**进程边界和数据边界重合。** 文件标签本来就按 workspace 归一化，watcher 本来就按项目组织。把进程维度对齐到这两者，重复读的隐患直接消失，不需要额外加锁或过滤。

**workspaceRoot 是身份，workspaceKey 是文件名。** root 是真值，daemon 必须持有它且只持有一个；key 定长、无路径分隔符，适合做 socket 文件名。

### 做之前的前置条件

两个热路由现在用的是闭包里的 `sessionId`，共享进程之后会解析到**错的 conversation**：

| 路由 | sessionId 来源 | 共享后 |
|---|---|---|
| `/reimport`、`/compact`、`/mark/decision`、`/mark/requirement` | `body.sessionId` | 已就绪 |
| `/retrieval/onPrompt`、`/failure/lookup` | 闭包 | **要改** |

这一条漏了后果很重：`conversationId` 决定关键词兜底查哪个会话的 S 档消息，而按埋点，**注入内容的 93.6% 来自这条路径**。

## 5. 和各 hook 的关系

| hook | 和 daemon 的关系 | 没有 daemon 时 |
|---|---|---|
| `session-start.sh` | 扫描 + `ensure-daemon.sh` | 报告未初始化，`continue` 仍为 true |
| `user-prompt-submit.sh` | 访问 socket；没有就 `ensure-daemon.sh` 后重试一次 | 返回 noop |
| `pre-tool-use.sh` | 访问 socket；**有冷路径 CLI 兜底** | 走 `failure-lookup-cli.js` |
| `pre-compact.sh` / `final-compact.sh` | 访问 socket | 跳过 |
| `codememory-mark.sh` | 访问 socket | 标记丢失 |
| `codememory-reimport.sh` | 访问 socket | 命令失败 |
| `session-end.sh` | `daemon.js stop` | 无操作 |
| `init-db.sh` / `check-history.sh` | 不接触 daemon | 不受影响 |

**一条贯穿所有 hook 的不变量：daemon 挂掉绝不能阻塞用户。** 每个 hook 都有降级路径，`continue` 永远是 true。记忆系统坏掉的表现应该是"没有提示"，不是"命令跑不了"。

## 6. 完整时序

```
SessionStart
  ├─ 扫描 runtime 目录，清掉死进程留下的文件
  └─ ensure-daemon.sh（3 秒预算）
       └─ daemon 启动：写 pid → bind socket → 从 watcher_offsets 恢复位置 → 开始 watch

运行中
  ├─ UserPromptSubmit  → socket → 活动时钟重置
  ├─ PreToolUse        → socket（或冷路径 CLI）→ 活动时钟重置
  ├─ transcript 新行   → watcher → 活动时钟重置 → dispatch → 落盘 offset
  └─ 空闲 30 分钟      → cleanup() → 退出

安静之后回来
  └─ UserPromptSubmit 发现没 socket
       └─ ensure-daemon.sh（1.5 秒预算）
            └─ 新 daemon 从 watcher_offsets 续读，中间那段不会丢

SessionEnd（如果钩子跑得完）
  └─ daemon.js stop → SIGTERM → 等 2 秒 → SIGKILL
```

## 7. 未决

- **按项目切**尚未实现，前置是把那两个热路由改成读 `body.sessionId`。
- **空闲阈值 30 分钟没有数据支撑**，是估的。`retrieval_events` 和 `ingestion_events` 的时间分布可以算出真实的会话间隔，届时应该按数据调。
- **重启次数没有埋点。** 按需重启发生的频率现在看不出来，而它直接关系到阈值定得对不对。
