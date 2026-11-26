# 记录：jade 的摩擦与架构证据

> 为什么记、怎么用见 [jade-goals.md](./jade-goals.md) 第 3 节。随手记一行，不用整理；定期按出现次数排序，排在前面的就是下一步。
>
> 格式：`- 日期 想做什么 → 碰到什么 → 结果（切回别的工具 / 忍了 / 绕过去）`。同一件事再碰到，在原条目后面加日期，不另起一条。

## 1. 模型

模型能力或模型来源造成的问题。只记下来，不为它改 jade。

- 2026-11-09 想用 jade 开发 uncarved 本身 → 手上只有较弱的模型能接进 jade；Claude Code 的 Team 订阅按条款不能用于第三方 harness → 工程工作留在 Claude Code。出路：向公司要 Anthropic API key，或试别家的强模型（`provider-openai-compat`）。

## 2. jade 本身

和模型无关的问题：工具、审批、上下文、界面、缺的功能。这一节就是 A 的路线图。

- 2026-11-11 想在对话框里直接执行 shell 命令（`!git status`、`!bun test`），不走模型、不占一轮，输出进上下文 → 没有这个功能 → 同日补上：`jade/shell` 的 `/sh <命令>`，`jade/tui` 把 `!<命令>` 当作它的简写。和消息一样排队（模型正在工作时等这一轮结束再执行），esc 能停掉。输入 `!` 时输入框边框变色、上边框右边有一行说明（和"已复制"的提示同一个位置）；运行中边跑边显示输出的末尾几行，被 esc 停掉时已经输出的也留下；结果和工具结果一样收成一行，点击或 ctrl+o 展开。没做的：命令读不到键盘输入（`npm login` 能看到它给的网址，但要按回车、输密码的程序用不了）。~~这样执行的改动不进 `/undo` 的检查点~~（2026-11-21 补上：`jade/undo` 提供 `undo@1.track`，`/sh` 前后各拍一张工作区快照，单独算一步撤销，和 Agent 的轮次按时间先后撤）。
- 2026-11-11 模型让我先 `!npm login`，执行完它停在那里 → `/sh` 只留说明、不开始一轮，还得再发一句"继续" → 同日改：会话里已经有对话时，`/sh` 把结果作为用户的消息发给模型（`commands@1` 已有的 `{ prompt }`），它接着做；还没有对话、被 esc 停掉时照旧只留说明。没做的：键盘输入（考虑过经 `ui@1.suspend` 把终端交给命令：stdout 也交出去就收不到输出给模型，只交 stdin 则程序看到 stdout 不是终端，密码会显示出来、`gh auth login` 这类不肯提示，先不做）。
- 2026-11-11 `!npm login` 运行中按 esc → 一直停在 Interrupting，Ctrl+C 也退不出去，只能关终端 → Windows 上 Git Bash 执行脚本形式的命令（`npm` 是个 sh 脚本）时会换一个 Windows 进程，原来按 WINPID 和 `taskkill /T` 都找不到它，没杀掉的进程占着输出管道，读取永远不结束；模型的 bash 工具有同样的问题。同日改：启动时在环境变量里放标记，按标记在 msys 的 `/proc` 里找进程杀；杀掉之后最多再等 2 秒就不等了；运行中连按两次 Ctrl+C 退出，退出最多等 3 秒；中断时吉祥物的汗珠会动。
- 2026-11-11 对复合命令点"总是允许" → 规则只认整条命令原文（`git add -A && git commit -m '…'`、`bun install && bun test`），提交信息一变又要问，等于没允许 → 同日改：复合命令里每条不是只读的命令各记一条规则（`git add…`、`git commit…`），以后换了提交信息、换了组合都不再问；带输出重定向的仍只认整条原文。范围因此变宽：批准过 `bun install && bun test`，单独的 `bun install` 也不问了。没改的：`mkdir -p a/b`、`git -C <dir> status` 这类第二个词是选项的命令仍只认原文（取一个词当前缀会把 `rm -rf` 也放进来）。
- 2026-11-11 审批对话框里两个"总是允许"选项看不清 → 规则（整条命令）写在选项中间，区别（本会话 / 这个目录）在句尾，超宽时被截掉，两项看起来一样 → 同日改：规则只在正文里写一次，选项只写范围。
- 2026-11-26 想让 auto 模式尽量少问用户（同 Claude Code）→ 原来审查只能放行或转给用户，规则判断不了的调用常常还是要问 → 同日改：审查只放行或拦下，拦下时模型用 `ask_user` 问用户，同意后重试放行；连续拦下 3 次（累计 20 次）才转回问一次。用户的回答由 `jade/ask` 记成 `jade/ask/answered` 事件，审查只认这一份（工具结果文本里的问题是模型写的，可以伪造回答）。
- 2026-11-26 想取消交互模式下的轮次限制 → 原来一轮默认 100 步就停下、让模型总结 → 同日改：不配置 `maxSteps` 时交互式前端和子 Agent 不限步数（随时能 esc 中断），只有 `-p` 这类不能提问的默认 200。

## 3. 架构证据

C 的证据。"多亏是插件才能这样做"是架构对的证据，"架构挡了路"是该改架构的证据。挡路的项如果涉及内核，按 [jade.md](./jade.md) 第 10 节的流程决定进不进内核。

### 多亏是插件

- 2026-11-10 摆正两处插件直接 import 核心模块的地方（`jade/update` 用 `src/update.ts`，`jade/skills` 用 `src/fetch.ts` 等）→ 改成核心服务 `update@1`、`sources@1` 之后，两个插件的清单写明了依赖，第三方插件也能装东西、查版本；核心一行功能代码都没加，只是把已有的函数挂成服务。

- 2026-11-10 一次加了一批日常功能（按目录记住的审批规则、`/undo` 撤销 shell 改动、后台命令结束提示、子 Agent 的只读 bash、自定义命令、用户 hook、费用显示、`-p --json`）→ 全部落在插件里，三个是新插件（`jade/custom-commands`、`jade/hooks`、`jade/cost`），`src/` 一行没动。用到的都是已有的接口：`commands@1`、`shell@1`、`prompts@1.note`、`ctx.status`、`derived`、内核 hook。注意：这一批是读代码找出来的，不是用出来的，哪些真的有用要等日常使用来验证。

- 2026-11-11 `!<命令>` 直接执行 shell → 落在 `jade/shell`（`/sh`，用已有的 `commands@1`、`shell@1`、`prompts@1.note`）加 `jade/tui` 输入层的一行改写，`src/` 没动。"往上下文里加内容但不开始一轮"用 `prompts@1.note` 就够。补的接口都是给命令用的显示能力：`print` 多了 `details`（折叠的内容），`CommandContext` 多了 `progress`（运行中的临时显示），`shell@1.run` 多了 `onOutput`。原来这些只有工具有（工具结果的折叠、`ToolContext.progress`），命令只能在结束时显示一整段文字。

- 2026-11-10 把上面和下面记的几个缺口一次补上（中途插话、恢复后重新问审批、子 Agent 带指令文件、`$EDITOR`、选中复制不带折行）→ 新功能都是插件（`jade/steer`、`jade/editor`）或插件里的改动；接口上只是把已有的东西拉平或补全：前端才有的 `Session.state`、`subscribe` 给了插件的 `ctx.session`，`ui@1` 加了 `copy`、`suspend`，`prompts@1` 加了 `instructions`，服务的类型搬进 `@uncarved/jade-api/services`。核心只改了会话里的十几行（转发通知、恢复时不再直接结束等审批的一轮）。唯一进内核的是混合批次的并发（宪法 v0.11），因为执行工具只有运行时能做。注意：`ui@1.suspend` 只用假终端测过，真终端里的 vim、Windows 上 stdin 的交接还没有实际用过。

### 架构挡了路

- 2026-11-18 MCP 服务启动慢（超过 5 秒）时，它的工具要 `/clear` 开新会话才能用 → 内核的工具表在 `Runtime` 创建时就定了（`#decideTool` 拒绝表外的名字，`context.build` 往请求里加工具也没用）。没改内核，在 `jade/mcp` 里绕过去：每个服务上次连上时的工具和说明记在 `$JADE_HOME/state/mcp-tools.json`，连上过的服务不再等，会话先按上次的工具开始，调用时再等它连上；这次连上发现工具变了，少了的调用时报错，多出来的提示从下一个会话起才有。还挡着的：第一次用的服务、工具变了的服务、MCP 的 `notifications/tools/list_changed`、会话中途装的插件，新工具都只能等下一个会话。要真正解决得让内核支持会话中途增减工具（按宪法第 3 条，等至少有第二种需要它的场景再定；改了还要想清楚提示缓存和 `plugins.changed` 怎么记）。
  - 2026-11-19 解决，内核没改：内核的 `Runtime.resume` 本来就能用一组新的工具重建同一个会话，插件清单不变时不写 `plugins.changed`。jade 核心在两轮之间 detach 旧实例、按新的工具表 resume（"重挂"，2.2 MB 的日志约几十毫秒），`ctx.kernel.tool` 在 `session()` 之后也能调用、返回撤销。`jade/mcp` 改为跟着服务变化增减工具，上面挡着的几种情况都从下一轮起生效。见 [live-tools-and-child-sessions.md](./live-tools-and-child-sessions.md)。

- 2026-11-11 设想做一个 `/team` 插件（成员是另起的 Agent）→ 嵌套 Agent 的工具只能经 `jade/task` 的 `task@1` 拿，而且是 `fs`、`shell`、`web`、`mcp` 各自在代码里"向 `task@1` 登记"：提供工具的一方得认识用工具的一方。第三方插件想另起 Agent，没法让内置插件向它登记，只能改这四个插件。这和"服务缺一个方法"不同，提需求也补不上。同日改：拆出中立的注册表 `jade/tools`（`tools@1`：`register`、`list`），提供方只管登记，`jade/task` 改成和第三方一样来取；`task@1` 删掉。`src/` 没动。检验的问题记进了 [jade.md](./jade.md) 第 11 节第 7 步。没做的（`/team` 先不做）：嵌套 Runtime 不经过主会话其他插件的关卡和 hook（审批、`/undo`、用户 hook、兜底关卡），所以登记的仍然只有只读工具和由使用方把关的 `bash`；要让嵌套 Agent 安全地写，得由核心来开子会话。
  - 2026-11-19 解决，内核没改：jade 核心加了 `ctx.session.spawn`，子会话用内核已有的 `parent`/`child` 引用，所有插件照常加入，审批、`/undo`、用户 hook、兜底关卡都生效，日志存盘。`jade/task` 改用它（配置 `write: true` 让子 Agent 写），内置插件不再往 `tools@1` 登记。第三方插件另起 Agent 也用 `spawn`。~~还没做的：子 Agent 的 shell 命令改的文件 `/undo` 撤销不了~~（2026-11-21 补上：算在根会话的这一轮里，整棵会话树一张快照）。见 [live-tools-and-child-sessions.md](./live-tools-and-child-sessions.md)。

- 2026-11-10 想做"用 `$EDITOR` 编辑输入"和通用的"复制到剪贴板"→ `ui@1` 没有暂停/恢复终端的方法，也没有剪贴板方法，插件做不了终端编辑器；`/copy` 因此只能放在 `jade/tui` 里。没改，等真的需要时给 `ui@1` 加方法。同日补上：`ui@1.copy`、`ui@1.suspend`，`jade/editor` 用后者；`/copy` 还留在 `jade/tui` 里，没有搬。2026-11-18 搬出：单独的 `jade/copy`，回复从 `sessions.current.state` 取，剪贴板经 `ui@1.copy`，`jade/tui` 里只剩 `/help`、`/exit`。
- 2026-11-26 `jade/budget` 到了步数上限想问用户要不要继续 → `turn.continue` 关卡的 `ask` 在内核里等于停止，没有 `ask → AwaitInput` 这条路，只好在关卡里弹对话框等（最长 24 小时），和 2026-11-10 审批走过的老路一样：等待期间内核以为自己在驱动这一轮，会话不能序列化、宿主写入被拒；用户的回答一开始也没记进日志（违反 I-5）。绕过去了：选"继续"时先记 `jade/budget/continued` 再放行。不绕的做法是先停下（`deny`），在 `afterTurn` 里问、选继续就发一条消息（同 `jade/continue`）。不配置 `maxSteps` 时交互模式不限步数，这条路很少走到，先不改。
- 2026-11-10 想让会话里的插件读自己会话的日志（`jade/cost` 恢复会话后接着算）→ `ctx.session` 没有 `history()`（命令里的 `sessions.current` 有）→ 绕过去了：合计每轮记进 `derived`。同日 `ctx.session` 加了 `state()` 和 `subscribe()`（和前端的一样）；整份日志（`history()`）仍然只有前端和命令拿得到。

- 2026-11-09 想让用户在终端里一条命令装网上的 skill 和 MCP 服务（`jade skills add`、`jade mcp add`）→ 插件没法加 `jade <子命令>`，直接写进 `main.ts` 又要让核心认识 skill 和 MCP → 给核心加了 `cli@1`（核心只查名字、转交参数），安装逻辑留在 `jade/skills`、`jade/mcp`。见 [jade.md](./jade.md) 3.4。
- 2026-11-05 移植 memory、undo → 没有"给模型留一句说明"的接口，两个插件各自往 `context.project` 里附说明（`/undo` 的已撤销记录另存在 `$JADE_HOME/checkpoints`）→ 绕过去了。两个插件绕同一条路，说明插件接口缺这一项。见 [jade.md](./jade.md) 第 11 节第 7 步。2026-11-10 补上：`prompts@1.note`，两份 `notes.ts` 删掉。
- 2026-11-10 审批没有走内核的 `ask`：`jade/approval` 在 `tool.gate` 里面弹对话框（超时设成 24 小时），自己返回 allow 或 deny → 内核的 `ask → AwaitInput → input.received` 这条路在 jade 主流程里没人用；日志里记的是"插件放行"，看不出是用户点的。没改：内核的批准只带"同意/拒绝"，放不下"本会话总是允许"和多个审批渠道。是内核的 `ask` 表达力不够，还是 jade 该把用户的选择另记一条事件，以后再定。2026-11-10 查清楚：表达力不用改内核，用户选了什么、哪个渠道答的，由 `jade/approval` 观察那条 `input.received` 时自己记一条事件。真正挡路的是停在 `awaiting` 的一轮结束不了（`abort` 只发信号，发新消息被拒绝，逐个拒绝又会再请求一次模型），第三方插件的关卡今天返回 `ask` 也会让会话卡住。同日内核补上 `Runtime.endTurn`（宪法 4.4，v0.10）。随后 jade 改完：核心的会话把 `awaiting` 当作这一轮没完，审批的回答经 `session.send` 交给正在等的这一轮；`jade/approval` 的关卡返回 `ask`，观察到 `tool.decided` 是 `ask` 时才问，回答另记 `jade/approval/answered`（选了什么、谁回答的）。插件不需要新接口就能知道要问：`event` 观察加上关卡里记下的调用就够了。24 小时的 hook 超时没有了（`askTimeoutMinutes` 改成插件自己的定时器）。没做的：退出时停在 `awaiting` 的会话恢复后不重新问，这一轮直接结束；子 Agent 的关卡没动。同日前一项补上（见 [jade.md](./jade.md) 第 7 节）：恢复时 `jade/approval` 按内核再发的 `awaiting` 通知重新问。
- 2026-11-10 所有内置插件都从 `src/api.ts` import `definePlugin` 这个值（其余只 import 类型），构建时还要把 `../../src/` 改写成 `../../dist/` → 第三方插件没有这条路径。同日拆出 `@uncarved/jade-api`（`packages/jade-api`），内置插件改从它 import，构建时的路径改写删掉。剩下的缺口：内置插件的服务类型（`Commands`、`Prompts`……）还在各插件目录里，第三方拿不到。同日补上：搬进 `@uncarved/jade-api/services`，内置插件之间也不再互相 import。
- 2026-11-25 关闭会话（`--serve` 的 `close`、切换会话、子会话结束）要等这一轮停下，内核对模型调用有 1 秒宽限，对工具没有（工具有副作用，结果不明不能当完成）→ 一个不理会中止信号的工具会让 `close` 永远不返回，会话也释放不了。改在 jade 里：离开时最多等 `"jade/core": { "closeTimeoutMs" }`（默认 10 秒），等不到就放弃这个 Runtime：它写日志经过的围栏关上，之后的写入一律被拒，迟到的结果写不进去，正在等的 `send` 立即被拒；围栏关上之前已经开始的写入先等它写完，再按日志恢复一个新的 Runtime 接手（和进程在那里退出后再恢复一样；同一时间只有一个写入者，宪法 4.3），由它照常收尾：顶层会话写 `session.detached`（没结果的调用留着，恢复时记为中断），子会话结束这一轮（`aborted`）再写 `session.ended`，插件照常观察到这些事件。卡住的工具和旧 Runtime 要等工具自己返回才会被回收。卡住的工具归到提供它的插件：报告里写出工具名和插件，记一次故障（连续故障计数，5.4）；只记故障、不隔离，和插件加入会话失败一样，一条命令卡住不该让整个插件在这个进程里停掉。同日：`store@1` 的契约加可选的 `release`（只在 jade 和存储之间，内核的 `LogStore` 不变：内核不用它，内核外做得对，按宪法 1.3 不进内核），会话离开时 `JsonlLogStore` 丢掉它的写入位置；`--serve` 关闭会话时删掉它的轮次计数。同日：插件的会话作用域关闭原来每个清理函数最多等 5 秒、逐个累加，几个插件都卡住时要等很久 → `Scope.close` 加了总期限，一个会话的所有清理函数加起来最多等 `closeTimeoutMs`，每个清理函数照常都会调用，没等到的在后台接着跑。这段从等会话停下之后才开始算，所以离开一个会话最多等 2 × `closeTimeoutMs`（另加写收尾事件的时间，内核 hook 有自己的超时）；子会话同时结束，不一个个累加。实测（进程内全部内置插件、假模型，每个会话跑一轮带工具调用再关）：开关 600 个会话，GC 后 `LiveSession`、`Runtime` 不留，堆上对象数不涨。例外：不理会中止信号的工具没返回之前，整个会话（两个 Runtime 和历史）都还被引用着，工具返回后才回收；工具永远不返回就一直占着，这是插件违反 I-9 的代价，靠故障计数把它停用。
