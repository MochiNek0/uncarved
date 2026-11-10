# 记录：jade 的摩擦与架构证据

> 为什么记、怎么用见 [jade-goals.md](./jade-goals.md) 第 3 节。随手记一行，不用整理；定期按出现次数排序，排在前面的就是下一步。
>
> 格式：`- 日期 想做什么 → 碰到什么 → 结果（切回别的工具 / 忍了 / 绕过去）`。同一件事再碰到，在原条目后面加日期，不另起一条。

## 1. 模型

模型能力或模型来源造成的问题。只记下来，不为它改 jade。

- 2026-11-09 想用 jade 开发 uncarved 本身 → 手上只有较弱的模型能接进 jade；Claude Code 的 Team 订阅按条款不能用于第三方 harness → 工程工作留在 Claude Code。出路：向公司要 Anthropic API key，或试别家的强模型（`provider-openai-compat`）。

## 2. jade 本身

和模型无关的问题：工具、审批、上下文、界面、缺的功能。这一节就是 A 的路线图。

## 3. 架构证据

C 的证据。"多亏是插件才能这样做"是架构对的证据，"架构挡了路"是该改架构的证据。挡路的项如果涉及内核，按 [jade.md](./jade.md) 第 10 节的流程决定进不进内核。

### 多亏是插件

- 2026-11-10 摆正两处插件直接 import 核心模块的地方（`jade/update` 用 `src/update.ts`，`jade/skills` 用 `src/fetch.ts` 等）→ 改成核心服务 `update@1`、`sources@1` 之后，两个插件的清单写明了依赖，第三方插件也能装东西、查版本；核心一行功能代码都没加，只是把已有的函数挂成服务。

### 架构挡了路

- 2026-11-09 想让用户在终端里一条命令装网上的 skill 和 MCP 服务（`jade skills add`、`jade mcp add`）→ 插件没法加 `jade <子命令>`，直接写进 `main.ts` 又要让核心认识 skill 和 MCP → 给核心加了 `cli@1`（核心只查名字、转交参数），安装逻辑留在 `jade/skills`、`jade/mcp`。见 [jade.md](./jade.md) 3.4。
- 2026-11-05 移植 memory、undo → 没有"给模型留一句说明"的接口，两个插件各自往 `context.project` 里附说明（`/undo` 的已撤销记录另存在 `$JADE_HOME/checkpoints`）→ 绕过去了。两个插件绕同一条路，说明插件接口缺这一项。见 [jade.md](./jade.md) 第 11 节第 7 步。2026-11-10 补上：`prompts@1.note`，两份 `notes.ts` 删掉。
- 2026-11-10 审批没有走内核的 `ask`：`jade/approval` 在 `tool.gate` 里面弹对话框（超时设成 24 小时），自己返回 allow 或 deny → 内核的 `ask → AwaitInput → input.received` 这条路在 jade 主流程里没人用；日志里记的是"插件放行"，看不出是用户点的。没改：内核的批准只带"同意/拒绝"，放不下"本会话总是允许"和多个审批渠道。是内核的 `ask` 表达力不够，还是 jade 该把用户的选择另记一条事件，以后再定。
- 2026-11-10 所有内置插件都从 `src/api.ts` import `definePlugin` 这个值（其余只 import 类型），构建时还要把 `../../src/` 改写成 `../../dist/` → 第三方插件没有这条路径。同日拆出 `@uncarved/jade-api`（`packages/jade-api`），内置插件改从它 import，构建时的路径改写删掉。剩下的缺口：内置插件的服务类型（`Commands`、`Prompts`……）还在各插件目录里，第三方拿不到。
