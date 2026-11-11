# 记录：jade 的摩擦与架构证据

> 为什么记、怎么用见 [jade-goals.md](./jade-goals.md) 第 3 节。随手记一行，不用整理；定期按出现次数排序，排在前面的就是下一步。
>
> 格式：`- 日期 想做什么 → 碰到什么 → 结果（切回别的工具 / 忍了 / 绕过去）`。同一件事再碰到，在原条目后面加日期，不另起一条。

## 1. 模型

模型能力或模型来源造成的问题。只记下来，不为它改 jade。

- 2026-11-09 想用 jade 开发 uncarved 本身 → 手上只有较弱的模型能接进 jade；Claude Code 的 Team 订阅按条款不能用于第三方 harness → 工程工作留在 Claude Code。出路：向公司要 Anthropic API key，或试别家的强模型（`provider-openai-compat`）。

## 2. jade 本身

和模型无关的问题：工具、审批、上下文、界面、缺的功能。这一节就是 A 的路线图。

- 2026-11-11 想在对话框里直接执行 shell 命令（`!git status`、`!bun test`），不走模型、不占一轮，输出进上下文 → 没有这个功能 → 同日补上：`jade/shell` 的 `/sh <命令>`，`jade/tui` 把 `!<命令>` 当作它的简写。和消息一样排队（模型正在工作时等这一轮结束再执行），esc 能停掉。输入 `!` 时输入框边框变色、上边框右边有一行说明（和"已复制"的提示同一个位置）；运行中边跑边显示输出的末尾几行，被 esc 停掉时已经输出的也留下；结果和工具结果一样收成一行，点击或 ctrl+o 展开。没做的：命令读不到键盘输入（`npm login` 能看到它给的网址，但要按回车、输密码的程序用不了）；这样执行的改动不进 `/undo` 的检查点。
- 2026-11-11 `!npm login` 运行中按 esc → 一直停在 Interrupting，Ctrl+C 也退不出去，只能关终端 → Windows 上 Git Bash 执行脚本形式的命令（`npm` 是个 sh 脚本）时会换一个 Windows 进程，原来按 WINPID 和 `taskkill /T` 都找不到它，没杀掉的进程占着输出管道，读取永远不结束；模型的 bash 工具有同样的问题。同日改：启动时在环境变量里放标记，按标记在 msys 的 `/proc` 里找进程杀；杀掉之后最多再等 2 秒就不等了；运行中连按两次 Ctrl+C 退出，退出最多等 3 秒；中断时吉祥物的汗珠会动。
- 2026-11-11 对复合命令点"总是允许" → 规则只认整条命令原文（`git add -A && git commit -m '…'`、`bun install && bun test`），提交信息一变又要问，等于没允许 → 同日改：复合命令里每条不是只读的命令各记一条规则（`git add…`、`git commit…`），以后换了提交信息、换了组合都不再问；带输出重定向的仍只认整条原文。范围因此变宽：批准过 `bun install && bun test`，单独的 `bun install` 也不问了。没改的：`mkdir -p a/b`、`git -C <dir> status` 这类第二个词是选项的命令仍只认原文（取一个词当前缀会把 `rm -rf` 也放进来）。
- 2026-11-11 审批对话框里两个"总是允许"选项看不清 → 规则（整条命令）写在选项中间，区别（本会话 / 这个目录）在句尾，超宽时被截掉，两项看起来一样 → 同日改：规则只在正文里写一次，选项只写范围。

## 3. 架构证据

C 的证据。"多亏是插件才能这样做"是架构对的证据，"架构挡了路"是该改架构的证据。挡路的项如果涉及内核，按 [jade.md](./jade.md) 第 10 节的流程决定进不进内核。

### 多亏是插件

- 2026-11-10 摆正两处插件直接 import 核心模块的地方（`jade/update` 用 `src/update.ts`，`jade/skills` 用 `src/fetch.ts` 等）→ 改成核心服务 `update@1`、`sources@1` 之后，两个插件的清单写明了依赖，第三方插件也能装东西、查版本；核心一行功能代码都没加，只是把已有的函数挂成服务。

- 2026-11-10 一次加了一批日常功能（按目录记住的审批规则、`/undo` 撤销 shell 改动、后台命令结束提示、子 Agent 的只读 bash、自定义命令、用户 hook、费用显示、`-p --json`）→ 全部落在插件里，三个是新插件（`jade/custom-commands`、`jade/hooks`、`jade/cost`），`src/` 一行没动。用到的都是已有的接口：`commands@1`、`shell@1`、`prompts@1.note`、`ctx.status`、`derived`、内核 hook。注意：这一批是读代码找出来的，不是用出来的，哪些真的有用要等日常使用来验证。

- 2026-11-11 `!<命令>` 直接执行 shell → 落在 `jade/shell`（`/sh`，用已有的 `commands@1`、`shell@1`、`prompts@1.note`）加 `jade/tui` 输入层的一行改写，`src/` 没动。"往上下文里加内容但不开始一轮"用 `prompts@1.note` 就够。补的接口都是给命令用的显示能力：`print` 多了 `details`（折叠的内容），`CommandContext` 多了 `progress`（运行中的临时显示），`shell@1.run` 多了 `onOutput`。原来这些只有工具有（工具结果的折叠、`ToolContext.progress`），命令只能在结束时显示一整段文字。

- 2026-11-10 把上面和下面记的几个缺口一次补上（中途插话、恢复后重新问审批、子 Agent 带指令文件、`$EDITOR`、选中复制不带折行）→ 新功能都是插件（`jade/steer`、`jade/editor`）或插件里的改动；接口上只是把已有的东西拉平或补全：前端才有的 `Session.state`、`subscribe` 给了插件的 `ctx.session`，`ui@1` 加了 `copy`、`suspend`，`prompts@1` 加了 `instructions`，服务的类型搬进 `@uncarved/jade-api/services`。核心只改了会话里的十几行（转发通知、恢复时不再直接结束等审批的一轮）。唯一进内核的是混合批次的并发（宪法 v0.11），因为执行工具只有运行时能做。注意：`ui@1.suspend` 只用假终端测过，真终端里的 vim、Windows 上 stdin 的交接还没有实际用过。

### 架构挡了路

- 2026-11-10 想做"用 `$EDITOR` 编辑输入"和通用的"复制到剪贴板"→ `ui@1` 没有暂停/恢复终端的方法，也没有剪贴板方法，插件做不了终端编辑器；`/copy` 因此只能放在 `jade/tui` 里。没改，等真的需要时给 `ui@1` 加方法。同日补上：`ui@1.copy`、`ui@1.suspend`，`jade/editor` 用后者；`/copy` 还留在 `jade/tui` 里，没有搬。
- 2026-11-10 想让会话里的插件读自己会话的日志（`jade/cost` 恢复会话后接着算）→ `ctx.session` 没有 `history()`（命令里的 `sessions.current` 有）→ 绕过去了：合计每轮记进 `derived`。同日 `ctx.session` 加了 `state()` 和 `subscribe()`（和前端的一样）；整份日志（`history()`）仍然只有前端和命令拿得到。

- 2026-11-09 想让用户在终端里一条命令装网上的 skill 和 MCP 服务（`jade skills add`、`jade mcp add`）→ 插件没法加 `jade <子命令>`，直接写进 `main.ts` 又要让核心认识 skill 和 MCP → 给核心加了 `cli@1`（核心只查名字、转交参数），安装逻辑留在 `jade/skills`、`jade/mcp`。见 [jade.md](./jade.md) 3.4。
- 2026-11-05 移植 memory、undo → 没有"给模型留一句说明"的接口，两个插件各自往 `context.project` 里附说明（`/undo` 的已撤销记录另存在 `$JADE_HOME/checkpoints`）→ 绕过去了。两个插件绕同一条路，说明插件接口缺这一项。见 [jade.md](./jade.md) 第 11 节第 7 步。2026-11-10 补上：`prompts@1.note`，两份 `notes.ts` 删掉。
- 2026-11-10 审批没有走内核的 `ask`：`jade/approval` 在 `tool.gate` 里面弹对话框（超时设成 24 小时），自己返回 allow 或 deny → 内核的 `ask → AwaitInput → input.received` 这条路在 jade 主流程里没人用；日志里记的是"插件放行"，看不出是用户点的。没改：内核的批准只带"同意/拒绝"，放不下"本会话总是允许"和多个审批渠道。是内核的 `ask` 表达力不够，还是 jade 该把用户的选择另记一条事件，以后再定。2026-11-10 查清楚：表达力不用改内核，用户选了什么、哪个渠道答的，由 `jade/approval` 观察那条 `input.received` 时自己记一条事件。真正挡路的是停在 `awaiting` 的一轮结束不了（`abort` 只发信号，发新消息被拒绝，逐个拒绝又会再请求一次模型），第三方插件的关卡今天返回 `ask` 也会让会话卡住。同日内核补上 `Runtime.endTurn`（宪法 4.4，v0.10）。随后 jade 改完：核心的会话把 `awaiting` 当作这一轮没完，审批的回答经 `session.send` 交给正在等的这一轮；`jade/approval` 的关卡返回 `ask`，观察到 `tool.decided` 是 `ask` 时才问，回答另记 `jade/approval/answered`（选了什么、谁回答的）。插件不需要新接口就能知道要问：`event` 观察加上关卡里记下的调用就够了。24 小时的 hook 超时没有了（`askTimeoutMinutes` 改成插件自己的定时器）。没做的：退出时停在 `awaiting` 的会话恢复后不重新问，这一轮直接结束；子 Agent 的关卡没动。同日前一项补上（见 [jade.md](./jade.md) 第 7 节）：恢复时 `jade/approval` 按内核再发的 `awaiting` 通知重新问。
- 2026-11-10 所有内置插件都从 `src/api.ts` import `definePlugin` 这个值（其余只 import 类型），构建时还要把 `../../src/` 改写成 `../../dist/` → 第三方插件没有这条路径。同日拆出 `@uncarved/jade-api`（`packages/jade-api`），内置插件改从它 import，构建时的路径改写删掉。剩下的缺口：内置插件的服务类型（`Commands`、`Prompts`……）还在各插件目录里，第三方拿不到。同日补上：搬进 `@uncarved/jade-api/services`，内置插件之间也不再互相 import。
