# 设计：会话中途增减工具、核心开的子会话

> 状态：已实现（1–7 步）· 2026-11-19。第 7 节的待定项已决定（参考 pi、dsh），第 8 节是实现时和设计不同、或者还没做的地方
>
> 相关：[jade.md](./jade.md) 第 4 节（作用域与生命周期）、第 10 节（uncarved 可能缺的）；[jade-log.md](./jade-log.md) 2026-11-11（`/team`、嵌套 Agent 的关卡）、2026-11-18（MCP 工具要 `/clear`）；宪法 1.3、3.4、4.2、4.6、I-5

## 1. 要解决的问题

| # | 现象 | 根源 |
|---|---|---|
| P1 | 会话开始之后才有的工具要 `/clear` 才能用：第一次连上的 MCP 服务、服务的 `notifications/tools/list_changed`、会话中途装的插件 | 插件只能在 `session()` 里调用 `ctx.kernel.tool`；`Runtime` 构造时把工具表定死（`runtime.ts` 的 `#tools`），`#decideTool` 拒绝表外的名字 |
| P2 | 子 Agent 只能用只读工具，不能写 | `jade/task` 自己建一个嵌套 `Runtime`，不经过主会话插件的关卡和 hook（审批、`/undo`、用户 hook、检查）；让它写就绕过了这些 |
| P3 | 子 Agent 跑完什么都不剩：恢复会话后看不到它做过什么，不能重放，`/cost` 靠插件另记 | 它的日志在 `MemoryLogStore` 里；插件拿不到核心的日志存储 |
| P4 | 工具提供方要为嵌套 Agent 另登记一份（`tools@1`），第三方的嵌套 Agent 只能拿到这些"另给的"工具 | 同 P2：嵌套 Agent 不是一个真正的会话，插件没机会在里面注册 |

## 2. 结论：都不改内核

宪法 1.3 要求进内核的东西"内核外做不对"。逐项核对后，内核已经有这两件事要的全部机制：

- **换工具**：`Runtime.resume` 能用一组新的插件对象重建同一个会话。工具表不在日志里（I-5 只要求状态能由日志重建，工具是插件给的），插件清单（id + 版本）不变时也不会写 `plugins.changed`。jade 在两轮之间 detach 旧实例、按新的工具表 resume，就等于"中途换工具"。实测：2.2 MB、111 条事件的真实会话日志，resume 35–45 ms，detach 10–20 ms。
- **子会话**：`Runtime.create` 接受 `parent: { sessionId, eventId }`，`ToolContext.parent` 已经是这个引用，`ToolResult.child` 会被记进父会话的 `tool.completed`（宪法 3.4）。缺的只是 jade 核心让一个会话开出另一个会话。

所以两项都是 jade 核心（`src/session.ts`）和插件 API（`@uncarved/jade-api`）的改动。第 6 节列出以后可能值得进内核的一点。

## 3. 第一部分：会话中途增减工具

### 3.1 插件 API

`ctx.kernel.tool` 在 `session()` 返回之后也能调用，并返回撤销函数（现在返回 `void`，属于向后兼容的扩展）：

```ts
interface SessionKernel {
  /** 注册工具。session() 里注册的在会话开始时就有；之后注册的从下一轮起有。返回撤销 */
  tool(t: ToolDeclaration): () => void
  hook(h: HookSpec): void        // 不变：hook 仍只能在 session() 里注册
}
```

hook 不放开：hook 的顺序和关卡的完整性要在会话开始时就确定，中途增减关卡的问题比工具多得多，目前没有需要它的场景。

### 3.2 核心：两轮之间重挂 Runtime

- 每个 `Part` 的工具表变成可变的。注册、撤销都只改表，然后让 `LiveSession` 排一次**重挂**；同一轮里的多次改动合并成一次。
- 重挂和用户输入在同一个队列里（`LiveSession.#queue`），所以只在两项工作之间、也就是 `phase` 为 `new` 或 `idle` 时执行。正在进行的一轮不受影响：这一轮里新注册的工具下一轮才有；已撤销的工具在这一轮里被调用时，现有的 `liveTool` 包装照样返回"插件已关闭"一类的错误。
- 重挂的步骤：
  1. 用当前的 parts 生成新的内核插件对象（同 id、同版本，换工具表）；
  2. `await rt.detach()`；
  3. `rt = await Runtime.resume({ store, provider, plugins, sessionId })`；
  4. 把订阅转到新实例上。
  
  第 2 步之后如果第 3 步失败，会话已经可以恢复，只是这个进程里暂时停在那里：报告错误，下一次输入时再试一次重挂，仍然失败就按现在"会话打不开"的方式处理。
- 重名检查和现在一样，在加入时做：后注册的同名工具被拒绝、报告，不影响已有的工具。
- 插件被隔离时也排一次重挂，把它的工具从表里拿掉，模型就不会再看到这些已经失效的工具。

### 3.3 订阅不能跟着 Runtime 走

现在 `LiveSession.subscribe` 直接返回 `rt.subscribe(fn)`，`attach()` 也只订阅一次。改成 `LiveSession` 自己持有监听者集合，从当前的 `rt` 转发；重挂时只把转发从旧实例换到新实例。前端、插件的 `ctx.session.subscribe` 都不需要知道发生过重挂。

### 3.4 代价

- **提示缓存**：工具定义在请求最前面，工具表一变，下一次请求的缓存全部失效。这是换工具本身的代价，换哪种实现都一样；不加 `/clear` 的话，至少对话历史还在。
- **日志**：每次重挂多一条 `session.detached`。它的含义是"宿主离开过、会话仍可恢复"，在这里是真的，只是宿主马上就回来了。查看日志的工具会看到它。如果觉得别扭，见第 6 节。
- **时间**：一次重挂约几十毫秒，而且只在工具变了时发生。

### 3.5 jade/mcp 怎么用

- 服务在后台连上后：注册它的工具，撤销缓存里有、服务已经不提供的工具（缓存见 2026-11-18 的改动）。
- 收到 `notifications/tools/list_changed`：重新列出工具，同样增减。
- `/mcp add` 加的服务：连上之后注册，不用重启 jade。
- 第一次用的服务仍最多等 5 秒（`STARTUP_WAIT_MS`），等不到的连上后从下一轮起有，不再要 `/clear`。见第 7 节第 1 条。

## 4. 第二部分：核心开的子会话

### 4.1 插件 API

```ts
interface SessionHandle {          // ctx.session 上新增
  /** 开一个子会话：记录 parent，所有插件照常加入（ctx.session.parent 有值） */
  spawn(opts: SpawnOptions): Promise<ChildSession>
  /** 本会话的父会话；顶层会话没有 */
  readonly parent?: SessionRef
}

interface SpawnOptions {
  /** 调用 spawn 的工具调用：ToolContext.parent。必须属于本会话 */
  parent: SessionRef
  /** 子会话里保留哪些工具：收到工具声明（含 effect），返回 true 的保留。不给时保留全部 */
  tools?: (t: ToolInfo) => boolean
  /** 子会话用的模型；不给时用会话的 provider@1 */
  provider?: Provider
  /** 打开子会话的插件给它的系统提示词，放在其他插件给的之前 */
  system?: string
}

interface ChildSession {
  readonly id: string
  send(input: UserInput): Promise<void>
  readonly state: State
  subscribe(fn: (n: RuntimeNotice) => void): () => void
  abort(reason?: string): void
  /** 结束子会话（session.ended），返回给父会话 tool.completed 用的引用 */
  close(): Promise<ChildRef>
}
```

工具的用法：

```ts
async execute(input, toolCtx) {
  const child = await ctx.session.spawn({ parent: toolCtx.parent, tools: (t) => t.name !== "task" })
  try { await child.send(prompt) } finally { var ref = await child.close() }
  return { content: report(child.state), child: ref }
}
```

### 4.2 核心

- 子会话是一个普通的 `LiveSession`：日志在同一个 `LogStore` 里，`Runtime.create({ parent })`；所有激活的插件都执行 `session()`，`ctx.session.parent` 有值，插件可以据此调整自己的行为。
- `Sessions` 除了"当前会话"，再管一组子会话，按父会话记：
  - 子会话**不会成为当前会话**，`sessions.current` 不变；
  - 父会话离开（`/clear`、`/resume`、退出）之前，先中止并结束它的全部子会话；
  - 子会话还能再开子会话，受层数和同时数量的上限限制（见第 7 节第 2 条）。
- 前端不为子会话提供会话界面（状态栏段落、面板、输入框）：`ui@1.session` 不对子会话调用，`ctx.status` 等不存在。对话框（`ui@1.select`）照常可用。
- `tools` 过滤在建 `Runtime` 之前做：插件照常注册，核心只把保留下来的工具交给内核。被过滤掉的工具对子会话的模型不存在。
- `system` 由核心自己的插件（`jade/core`）在 `context.build` 里放在最前面，标为 trusted。它来自打开子会话的插件，不是用户，所以加一个 `ContentSource`，写明是哪个插件给的。

### 4.3 对各插件的影响

| 插件 | 子会话里应该怎样 |
|---|---|
| `jade/approval` | 照常把关；问用户的对话框由核心排队、标上是哪个子 Agent（第 7 节第 4 条）。这正是能让子 Agent 写文件的原因：写操作和主会话经过同一套审批 |
| `jade/undo` | 子会话里的改动要算进父会话当前这一轮，父会话 `/undo` 时一起撤销。需要按"根会话"共享检查点（插件内部的进程级状态），不需要新接口 |
| `jade/hooks`、`jade/checks` | 照常运行，不用改 |
| `jade/prompts` | 子会话里给环境信息和指令文件（CLAUDE.md 一类），不给主 Agent 的角色说明（由 `system` 代替），见第 7 节第 3 条 |
| `jade/sessions` | `/resume` 的列表不列子会话 |
| `jade/task` | 改用 `spawn`，见 4.5 |
| `jade/cost` | 子会话的用量在它自己的日志里；先保留现在由 `jade/task` 记 `derived` 的做法，以后再改成从子会话日志统计 |
| `jade/tui` | 不变：子会话不是当前会话，它的过程仍由打开它的工具经 `ctx.progress` 显示 |

### 4.4 日志与恢复

- 父会话的 `tool.completed` 带 `child: { sessionId, seq }`，子会话的 `session.started` 带 `parent`。内核保证引用能解析到（3.4），所以 jade 删除会话时，要连同或者阻止删除被引用的子会话（`jade/sessions` 以后加删除功能时注意）。
- 父会话崩溃时子会话可能没有 `session.ended`：父会话那次调用会变成 `tool.interrupted`，子会话日志留着，不再被使用。`task` 声明了 `idempotent`，恢复后会重新运行，开一个新的子会话。
- 以后可以加"查看子会话"：渲染器从 `child` 引用读出子会话日志，展开显示。不在这次范围内。

### 4.5 迁移

1. `jade/task` 改用 `spawn`，过滤成 `effect === "read"`。行为和现在一样，只是日志落了盘，审批、hook 也照常生效。
2. 加配置 `jade/task.write: true`：不再按 `effect` 过滤，写操作经过子会话里的审批。默认关，先在日常使用里试。
3. `jade/fs`、`jade/shell`、`jade/web`、`jade/mcp` 不再向 `tools@1` 另登记一份；`tools@1` 保留一个版本给第三方插件，并在文档里标为不推荐使用，然后删掉。

## 5. 实施顺序

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 ✅ | `LiveSession` 自己转发订阅（3.3） | 现有测试全过 |
| 2 ✅ | 可变工具表 + 重挂（3.1、3.2） | 新测试：`session()` 之后注册的工具从下一轮起出现在请求里；撤销后消失；进行中的一轮不受影响；隔离插件后它的工具消失；重挂失败后下一次输入再试 |
| 3 ✅ | `jade/mcp` 用上（3.5） | 新测试：慢启动的服务连上后，不 `/clear` 下一轮就有它的工具；`list_changed` 生效；`/mcp add`、`/mcp remove` 不用重启 |
| 4 ✅ | `spawn`、子会话的生命周期（4.1、4.2），层数和数量上限（7.2），委派说明（7.3），对话框排队（7.4） | 新测试：子会话日志落盘、`parent` 和 `child` 能互相解析；父会话离开时子会话被结束；层数上限（恢复后也对）、超出数量时等待；工具过滤；两个子会话同时问时一次显示一个 |
| 5 ✅ | `jade/task` 迁移（4.5 第 1 步），`jade/sessions`、`jade/approval` 的调整 | 现有 `task.test.ts` 全过；子会话里的写操作被主会话的审批拦下 |
| 6 ✅ | `jade/undo` 按根会话共享检查点，`task.write` | 子 Agent 写的文件能被父会话 `/undo` 撤销 |
| 7 ✅ | 内置插件不再往 `tools@1` 登记，`jade/tools` 标为不推荐使用 | — |

1–3 和 4–7 可以分开合并，前三步完成就能解决 P1。

1–3 的实现：`src/session.ts`（`Part.tools`、`LiveSession.invalidate`、`#remount`、自己持有的监听者）、`@uncarved/jade-api` 的 `kernel.tool` 返回撤销函数、`plugins/mcp`（按服务的变化同步会话里的工具和说明，`list_changed`，`/mcp add|remove` 马上生效）。测试在 `test/session.test.ts` 的 "tools registered after session() returns" 和 `test/mcp.test.ts`。进程外插件的 `kernel/tool` 还没有撤销（RPC 回复 null），需要时再加。

## 6. 以后可能进内核的

如果重挂带来的 `session.detached` 或重放开销成为问题，可以给内核加一个"把工具表交给新实例"的操作：同一个进程内不写 `session.detached`、不重读日志，直接用当前状态建一个工具不同的新实例。按宪法 1.3，等第二个发行版也需要会话中途换工具时再提。现在 jade 一家用，又能在内核外做对，不进内核。

## 7. 决定（2026-11-19）

参考了 pi（earendil-works/pi @ ff8721f）和 dsh（deepseek-ai/deepseek-harness @ 2e39e704）的做法。四项都在 jade 核心或插件里做，内核不改。

### 7.1 第一次用的 MCP 服务等多久

| | 做法 |
|---|---|
| pi | 服务在后台连；第一条消息发出前（`before_agent_start`）最多等 10 秒，等不到提示一句接着跑，连上后的工具下一次请求就有 |
| dsh | 插件激活时一直等到连上并列出工具，默认没有总时限，慢的服务会拖慢启动 |

**决定**：连上过的服务（缓存里有它的工具）不等；第一次用的服务在会话打开时最多等 5 秒；不能交互（`-p`）时等到连上或超时。等不到的连上后工具从下一轮起有，不再要 `/clear`。已实现。

pi 在"第一条消息发出前"等，比 jade 在"会话打开时"等更好：用户打字的时间也算进去了。jade 要这样做，需要核心在每项工作开始前给插件一个可以等待的时机（例如 `ctx.session.beforeTurn`），这是 jade 核心的事，不涉及内核。等真有人嫌打开会话慢再加。

### 7.2 子会话的层数和数量上限

| | 做法 |
|---|---|
| pi | 核心没有子 Agent；示例扩展把子 Agent 作为单独的 `pi -p` 进程运行，**没有层数限制**，只在扩展里写死了一次最多 8 个、同时 4 个 |
| dsh | 子 Agent 服务（核心的一部分）强制：`maxDepth` 默认 1（子 Agent 不能再开子 Agent），0 关掉；父会话的层数从它持久化的头部读，恢复后的会话不能冒充顶层。整棵树同时最多 8 个（`maxActiveSubagents`） |

**决定**：放在 jade 核心的 `spawn` 里，跟 dsh 一样。上限防的是资源失控，不是策略：任何开子会话的插件都不能绕过它。
- 层数默认 **1**（不是草稿里的 3）：子 Agent 再开子 Agent 的需求还没出现过，要的人在配置里调大；0 表示不允许开子会话。
- 一棵会话树同时最多 **8** 个子会话，超出的 `spawn` 等待前面的结束，而不是报错（并行的 task 调用照样能跑完）。
- 层数从日志算：子会话的 `session.started` 带着 `parent`，沿着它往上数。内核已经保证引用能解析到（宪法 3.4），所以恢复的会话也数得对，不用另记。
- 配置在核心的配置里（用户 `config.json` 的 `"jade/core": { "maxDepth": 1, "maxActive": 8 }`），不是某个插件的配置；项目层的 `.jade/config.json` 设不了，克隆的仓库不能放宽上限。

### 7.3 子会话的系统提示词

| | 做法 |
|---|---|
| pi | 子 Agent 是一个完整的 pi 进程，照常生成自己的系统提示词（含 AGENTS.md、skills），再追加 Agent 定义文件（`.pi/agents/*.md`）的正文；看不到父会话的对话 |
| dsh | 子 Agent 默认沿用父会话的预设（工具、提示词段落、人设），另外每个子 Agent 都有一段固定的"你是被委派的"说明；任务以"Agent <父> 发来消息"的形式给出 |

**决定**：接近 pi。
- `jade/prompts`：给环境信息和指令文件（AGENTS.md、CLAUDE.md），不给主 Agent 的角色说明。指令文件是用户对这个仓库的要求，子 Agent 也要遵守；角色说明由开子会话的插件经 `system` 给。
- `jade/core`：在最前面放一段固定的委派说明（你是被另一个 Agent 委派的，看不到它的对话，做完把结果写清楚交回去），和 dsh 一样。插件不能去掉它。
- 其他插件（skills、memory 等）通过 `ctx.session.parent` 自己决定在子会话里给什么。默认照常给。
- 自定义的 Agent 定义文件（pi 的 `.pi/agents/*.md`）是 `jade/task` 的功能，不在核心里。

### 7.4 几个子会话同时弹出对话框

| | 做法 |
|---|---|
| pi | 子 Agent 以 `-p` 运行，没有界面，示例的权限扩展直接拒绝，子 Agent 的审批到不了用户。主进程的界面把扩展的对话框**叠起来**：新的盖住旧的，关掉一个露出上一个，对话框上没有标明是哪个子 Agent |
| dsh | 子 Agent 的审批策略**固定为不问**（需要审批的一律拒绝，告诉子 Agent 把限制报告回去），沙箱和预设继承父会话；没有跨会话的排队 |

**决定**：在 jade 核心排队，先来先问。
- 核心交给子会话的 `ui@1` 包一层：`select`、`input` 在整个进程里排成一队，一次只显示一个，标题前加上子 Agent 的名字（由 `spawn` 的调用方给，例如 task 的描述）。现在 `jade/task` 自己做的排队由此退役。
- 不用 pi 的"叠起来"：审批是要用户看清楚再答的，后来的盖住先来的，用户容易答错对象。
- dsh 的"子 Agent 一律不问"做成一个选项，不是默认：`jade/task.write` 关着时子 Agent 只有只读工具，用不到审批；打开后写操作照常经过审批。不能交互（`-p`）时，审批插件本来就按规则直接决定，不弹对话框。
- 主会话自己的对话框不进这个队（它们本来就一次一个）。子会话的对话框排在主会话正在显示的那个后面。

### 7.5 子会话的日志

pi 的子 Agent 不存会话（`--no-session`），过程只留在父会话工具结果的 `details` 里。dsh 每个子 Agent 是一个独立的持久会话，父会话的日志里记一条目录事实，可以列出、冷恢复。jade 按 dsh 的方向做（第 4.4 节），而且不用另记：内核的 `parent`、`child` 引用就是这份目录。

## 8. 实现记录（2026-11-19）

和上面的设计不同、或者设计里没写到的：

- **API**：`ctx.session.spawn` 之外加了 `ctx.session.depth`、`ctx.session.canSpawn`（到了层数上限的会话不注册开子会话的工具，jade/task 据此不给 `task`）；`SpawnOptions.label` 用于对话框标题。
- **委派说明的位置**：放在单独的内核插件 `jade/core/delegation` 里，`context.build` 的 hook `order` 设得很大。jade/prompts 等插件把自己的段落放在已有段落之前，最后执行的才能排在最前面。
- **子会话里不做的事**（插件看 `ctx.session.parent` 决定）：
  - `jade/sessions` 不记索引（`/resume` 不列），也不碰输入框；
  - `jade/schedule` 不建、不收定时任务；
  - `jade/compact` 不压缩（子 Agent 活不长，jade/task 接近窗口时让它写报告）；
  - `jade/hooks` 的 `turn` 不触发（用户等的是主会话的一轮）；
  - `jade/skills` 不接管 `/<skill>` 命令；
  - `jade/modes` 不给 `propose_plan`；
  - `jade/prompts` 不给主 Agent 的角色说明，也不再提示"读了哪些指令文件"；
  - `jade/shell` 的 bash 不能在后台跑，没有 `bash_output`、`kill_shell`。
- **`prompts@1` 的段落是进程级的**：子会话里的插件会再加一份同样的段落（skill 列表、MCP 说明），jade/prompts 按插件和文字去重，父会话的提示词不会因为开了子会话而变。
- **审批**：子会话的 jade/approval 也认父会话现在的"总是允许"规则；子会话里选的"总是允许"只管这个子会话。`web_fetch` 现在按主会话的规则判断（原来 jade/task 自己规定子 Agent 每次都要问）。
- **jade/task**：`task` 的 effect 仍是 `read`，`write: true` 时也是：子 Agent 的每个写操作在子会话里各自审批，没有审批插件时被核心的兜底关卡拒绝；这时 `idempotent` 为 false。只读时不给 `ask_user`。
- **/undo**：子会话里文件工具的改动记在根会话的目录里，`via` 是根会话里打开它的那次调用（从父会话的 `tool.decided` 事件找到 toolUseId），父会话 `/undo` 时算作那一轮。**子 Agent 的 shell 命令改的文件还撤销不了**：工作区快照是每个会话一个影子仓库，并行的子 Agent 不能共用根会话的。需要时给影子仓库加锁，或者每个子会话一个、`/undo` 时合并。
- **代价**：每个子会话都要所有插件执行一次 `session()`（找 skill、读指令文件、MCP 同步……），开一个子 Agent 多花几百毫秒；全量测试的负载下 task 测试可能超过默认的 5 秒，测试文件里放宽了时限。
