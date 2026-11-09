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

### 架构挡了路

- 2026-11-09 想让用户在终端里一条命令装网上的 skill 和 MCP 服务（`jade skills add`、`jade mcp add`）→ 插件没法加 `jade <子命令>`，直接写进 `main.ts` 又要让核心认识 skill 和 MCP → 给核心加了 `cli@1`（核心只查名字、转交参数），安装逻辑留在 `jade/skills`、`jade/mcp`。见 [jade.md](./jade.md) 3.4。
- 2026-11-05 移植 memory、undo → 没有"给模型留一句说明"的接口，两个插件各自往 `context.project` 里附说明（`/undo` 的已撤销记录另存在 `$JADE_HOME/checkpoints`）→ 绕过去了。两个插件绕同一条路，说明插件接口缺这一项。见 [jade.md](./jade.md) 第 11 节第 7 步。
