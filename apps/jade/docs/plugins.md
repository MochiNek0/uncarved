# 为 jade 开发插件

插件可以给 jade 加上：

- **工具**：模型可以调用的新能力，例如查询内部系统、调用 git。
- **hook**：在固定的扩展点上观察或改变 jade 的行为，例如拦截某些修改、在工具输出里脱敏、往系统提示词里加内容、记录审计日志。
- **斜杠命令**：用户在 jade 里输入的 `/命令`，可以和用户交互（选择、输入）。
- **内容**：skills、Markdown 写的命令、MCP 服务配置，放在插件目录里随插件一起安装，不用写代码。
- **代替内置功能**：jade 自己的功能（文件工具、shell、web、提示词、压缩……）也是插件，第三方插件可以代替其中任何一个，只有审批（`jade/policy`）不能代替。见[内置插件](#内置插件)。
- **和用户的交互**：在输入框里给出下一条消息的建议（[suggest](#预测下一条消息suggest)）、在消息发出前改写它（[beforeSend](#改写用户消息beforesend)）、在状态栏显示一段文字（[ctx.status](#状态栏ctxstatus)）、在终端之外回答审批（[responder](#远程应答responder)）。插件还能用 [ctx.complete](#调用模型ctxcomplete) 调用用户配置的模型。

先看看是不是不用写插件：

- 只是想让模型用上已有的服务（GitHub、数据库、浏览器），接 [MCP](../README.md#mcp) 服务就行。
- 只是想教模型按某种流程做事（发版、写某类文档），写一个 [skill](../README.md#skills) 就行。

需要改变 jade 本身的行为（拦截、改写、审计）或者加斜杠命令时，再写插件。

jade 的插件就是 [uncarved](../../../packages/kernel/README.md) 内核的插件，外加 jade 认识的 `commands`、`replaces`、`responder`、`suggest`、`beforeSend` 字段。为 uncarved 写的插件不用改就能在 jade 里用。

本文的完整示例在 [`examples/plugins`](../examples/plugins)：

| 示例 | 形式 | 演示 |
|---|---|---|
| [`protect-files`](../examples/plugins/protect-files/index.ts) | TypeScript，默认导出对象 | `tool.gate` 拦截修改，`ctx.emit` 在界面上提示 |
| [`git-review`](../examples/plugins/git-review/index.ts) | TypeScript，工厂函数 | 工具、斜杠命令、用上下文里的 `run` 执行命令 |
| [`redact-secrets`](../examples/plugins/redact-secrets) | Python，独立进程 | `tool.after` 改写工具输出 |

用户用 `jade plugin add` 安装插件，见[安装和发布](#安装和发布)。

## 五分钟上手

在项目里新建 `.jade/plugins/hello/index.ts`：

```ts
import type { JadePluginFactory } from "@uncarved/jade";

const factory: JadePluginFactory = ({ definePlugin }) =>
  definePlugin({
    id: "me/hello",
    version: "1.0.0",
    tools: [
      {
        name: "hello",
        description: "Greet someone by name.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        effect: "read",
        concurrency: "safe",
        idempotent: true,
        execute: async (input) => ({ content: `Hello, ${(input as { name: string }).name}!` }),
      },
    ],
    commands: [{ name: "hello", description: "say hello", run: (args) => `Hello, ${args || "world"}!` }],
  });

export default factory;
```

启动 jade，确认加载这个插件，然后：

- 输入 `/plugins`，能看到 `me/hello` 和它的工具、命令；
- 输入 `/hello jade`，显示 `Hello, jade!`；
- 对模型说"用 hello 工具跟 Ada 打招呼"，模型会调用它。

`import type` 只用于编辑器里的类型提示，运行时会被去掉，不需要安装任何依赖。想要类型提示的话，在插件目录或项目里 `bun add -d @uncarved/jade uncarved`。

## 安装和发布

用户这样安装、管理插件（在会话外运行，不需要配置模型）：

```sh
jade plugin add github:me/jade-hello          # GitHub 仓库；也可以是任何 git 地址，#分支、#tag、#提交 指定版本
jade plugin add me/plugins --path hello       # 仓库里放了好几个插件时，只装其中一个子目录
jade plugin add jade-hello                    # npm 包（可以带 @版本、@作用域），或者本地的 .tgz
jade plugin add ./hello --link                # 本地目录；--link 只建链接，开发插件时用
jade plugin add <来源> --project              # 装进 <仓库>/.jade/plugins，提交后整个团队都有
jade plugin list                              # 内置插件和装了的插件
jade plugin update [名字…]                    # 按安装记录重新下载（git 看提交，npm 看版本）
jade plugin remove <名字>
jade plugin disable <名字|内置插件 id>         # 停用，例如 jade plugin disable jade/web
jade plugin enable <名字|内置插件 id>
```

- 安装时先下载到临时目录，确认是插件（有代码入口、`plugin.json` 或者 skills/命令/MCP 配置）之后才放到位，失败不会留下半个插件。
- 插件的 `package.json` 有 `dependencies` 时，安装后会在插件目录里安装依赖：jade 跑在 Bun 下时用 `bun install --production`，跑在 Node 下时用 `npm install --omit=dev`。两种都不运行安装脚本。
- jade 跑在 Node 下时，`.ts` 入口靠 Node 自带的类型擦除加载：只支持能直接擦掉的类型语法（不支持 `enum`、`namespace`、参数属性），相对导入要写完整扩展名（`./util.ts`）。想在两种运行时下都能用，用 `.js` 或者只写这类语法。
- 目录名依次取 `--name`、`plugin.json` 的 `name`、`.claude-plugin/plugin.json` 的 `name`、`package.json` 的 `name`（去掉作用域）、来源的最后一段。
- 安装记录在插件目录的 `.installed.json` 里。直接复制进去的插件也能用，只是 `update` 不管它。
- 自己用 `--project` 装的进程内插件不会在启动时再问一遍；别人拉取仓库后第一次加载时仍要确认。
- 停用记录在 `$JADE_HOME/plugins.json`，只有用户自己能停用，仓库里的配置不能停用你的插件。

所以发布插件只要：把插件目录放进一个 git 仓库（或者仓库的子目录），或者发布成 npm 包。npm 包的入口按下面的规则找，**不看** `package.json` 的 `main`，请提供 `index.ts`/`index.js` 或者在 `plugin.json` 里写 `entry`。

## 插件放在哪里

一个目录就是一个插件，目录名随意：

| 位置 | 层级 | 加载前确认 |
|---|---|---|
| `$JADE_HOME/plugins/<name>/`（默认 `~/.jade/plugins`） | 用户层：所有项目都加载 | 不需要，那是你自己装的 |
| `<目录>/.jade/plugins/<name>/`，从仓库根目录到工作目录的每一级 | 项目层：随仓库分发 | **需要**，见[安全](#安全) |

- 项目层里，近的目录覆盖远的同名目录。例如在 `repo/pkg` 下启动时，`repo/pkg/.jade/plugins/lint` 覆盖 `repo/.jade/plugins/lint`。
- 以 `.` 开头的目录不加载。用户层可以放符号链接，方便把开发中的插件链接进来；项目层不行。
- 插件目录里怎么找入口：
  1. 有 `plugin.json` 且写了 `command`：[进程外插件](#进程外插件任何语言)；
  2. `plugin.json` 写了 `entry`：用这个文件；
  3. 否则依次找 `index.ts`、`index.js`、`index.mjs`；
  4. 都没有，但有 `skills/`、`commands/` 或 `mcp.json`：只带内容的插件，见[带上 skills、命令和 MCP 服务](#带上-skills命令和-mcp-服务)。
- 插件在 jade 启动时加载，**改了插件要重启 jade 才生效**。
- 加载或创建失败的插件会被跳过，启动时显示原因，不影响 jade 本身。常见原因有：入口找不到、内核版本不兼容、`needs` 没声明、`id` 或工具名和已有的重复。
- 子 Agent（`task` 工具）只执行第三方插件的 `tool.gate`、`tool.before`、`tool.after` 这三种 hook（拦截、改写参数、给结果脱敏），不带它们的工具、其他 hook、`suggest` 和 `beforeSend`。所以给工具结果脱敏的插件对子 Agent 读到的内容同样生效，而按轮次触发的 observe hook 不会被子 Agent 触发。
- `plugin.json` 还可以写 `name`、`version`、`description`，`jade plugin list` 和 `/plugins` 显示它们。

## 插件对象

入口模块的默认导出是插件对象，或者返回插件对象的函数（见[工厂函数](#工厂函数和上下文)）：

```ts
interface JadePlugin {
  id: string;            // 全局唯一，建议 "作者/名字"
  version: string;       // semver
  kernel: string;        // 兼容的内核版本，现在写 "^0.1"
  needs?: string[];      // 用到的内核能力，见下文
  resume?: "continue" | "ask" | "abort";
  tools?: Tool[];
  hooks?: HookSpec[];
  commands?: PluginCommand[];   // jade 的扩展：斜杠命令
  replaces?: string[];          // jade 的扩展：代替的内置插件，例如 ["jade/web"]
  responder?: Responder;        // jade 的扩展：在终端之外回答审批和 ask_user，见下文
  suggest?: Suggester;          // jade 的扩展：预测下一条消息，输入框里显示成灰字，见下文
  beforeSend?(text, ctx): string | undefined;  // jade 的扩展：用户消息发出前改写，见下文
  providers?: PluginProvider[]; // jade 的扩展：模型服务，用 JADE_PROVIDER 选择，见下文
}
```

- **`kernel`**：按 semver 的 `^` 规则匹配内核版本。0.x 阶段小版本之间不兼容，`^0.1` 只接受 0.1.x。不满足时插件不加载。
- **`needs`**：插件用到的每个扩展点都要写成 `<种类>:<扩展点>`，例如 `"gate:tool.gate"`；用到 `ctx.record`、`ctx.emit` 还要写 `"log:record"`、`"log:emit"`。hook 用了没声明的扩展点，插件不加载；`record`/`emit` 没声明，调用时报错。
- **`resume`**：恢复旧会话时，如果插件版本变了，jade 默认这样处理：补丁版本和小版本直接继续，主版本变化或者新增、删除了插件时询问用户。插件可以用这个字段覆盖对它自己的处理。

手写 `kernel` 和 `needs` 容易漏，用 `definePlugin` 代劳：它把 `kernel` 填成当前内核的范围，把 hooks 用到的扩展点加进 `needs`。`log:record`、`log:emit` 推不出来，用到时仍要自己写。

```ts
definePlugin({
  id: "me/audit",
  version: "1.0.0",
  needs: ["log:emit"],            // 只写推不出来的
  hooks: [{ kind: "observe", point: "model.after", fn: ... }],
});
// → kernel: "^0.1", needs: ["log:emit", "observe:model.after"]
```

工厂函数的上下文里有 `definePlugin`。项目层插件请用它，不要 `import { definePlugin } from "uncarved"`：项目层插件只能导入插件目录内的文件（见[安全](#安全)），而 jade 全局安装时，项目里通常找不到 `uncarved` 这个包。

## 工厂函数和上下文

默认导出函数时，jade 每开始一个会话（包括 `/clear`、`/resume`）就调用一次，得到一套新的实例。插件里按会话记的状态（计数器、缓存）放在函数里，就不会跨会话串掉：

```ts
const factory: JadePluginFactory = (ctx) => {
  let edits = 0;   // 每个会话从 0 开始
  return ctx.definePlugin({ ... });
};
export default factory;
```

`ctx` 的字段：

| 字段 | 说明 |
|---|---|
| `jade` | jade 的版本 |
| `cwd` | 工作目录（已解析符号链接） |
| `root` | 仓库根目录；不在 git 仓库里时等于 `cwd` |
| `home` | jade 的数据目录（`$JADE_HOME`），插件可以在这里存自己的数据 |
| `dir` | 插件自己的目录 |
| `layer` | `"user"` 或 `"project"` |
| `definePlugin` | 见上文 |
| `run` | `(command, { cwd?, timeoutMs, signal? }) => Promise<{ code, output, timedOut }>`：用 jade 的 shell 执行命令，超时或中断时连同子进程一起结束。找不到 shell 时没有这个字段 |
| `complete` | `({ system?, prompt, onText? }, signal) => Promise<{ text, model, usage? }>`：用当前配置的模型发一次请求，见下文 |
| `status` | `(text \| undefined) => void`：设置状态栏上本插件的那一段，见下文 |
| `checkpoints` | 文件快照：写文件的工具写之前记下原内容，`/undo` 据此恢复，见下文 |

默认导出对象时，每个会话用的是它的一份浅拷贝，适合没有状态的插件。

### 调用模型：`ctx.complete`

插件不用自己配 API key，直接用用户在 `/model` 里配好的模型：

```ts
const { text } = await ctx.complete(
  { system: "Summarize in one line.", prompt: diff, onText: (d) => { /* 流式片段 */ } },
  signal,
);
```

- 不带工具，不记进会话；和会话共用限速和重试。用户切换模型后用新的模型。
- `onText` 收到流式输出的片段。拿到需要的内容（例如第一行）后可以用 `signal` 中止，省 token。
- 思考力度、输出上限按用户的模型配置，插件不能单独设置。需要别的模型时请自己调用它的 API。

### 状态栏：`ctx.status`

```ts
ctx.status("CI ✓");     // 状态栏上多一段 "CI ✓"
ctx.status(undefined);  // 去掉
```

- 每个插件一段，只显示一行，超过 40 个字符截断。窗口窄时比快捷键提示晚、比缓存比例早被去掉。
- 什么时候调用都行（工厂函数里、hook 里、定时器里）。换会话时清空，旧会话的实例再调用不会显示。

### 文件快照：`ctx.checkpoints`

插件的工具写文件之前记一份快照，用户的 `/undo` 就会把它和 jade 自己的 `write_file`、`edit_file` 一起撤销：

```ts
async execute(input, toolCtx) {
  const before = existsSync(file) ? await readFile(file, "utf8") : null;   // null：文件原本不存在，撤销时删掉
  const after = render(input);
  await ctx.checkpoints.save(toolCtx.sessionId, {
    toolUseId: toolCtx.toolUseId,
    tool: "my_tool",
    path: file,                                                     // 绝对路径
    before,
    afterHash: createHash("sha256").update(after).digest("hex"),   // 撤销前据此判断文件之后有没有被改过
  });
  await writeFile(file, after);
  return { content: "ok" };
}
```

- `list(sessionId)`、`unchangedSince(cp)`、`restore(cp)` 是 `/undo`（`jade/undo`）用的另一半，见 [`src/plugins/sessions.ts`](../src/plugins/sessions.ts)；想换一种撤销方式可以 `replaces: ["jade/undo"]`。
- 快照按会话存在 `$JADE_HOME/checkpoints/` 下，不进日志。

## 工具

```ts
interface Tool {
  name: string;                       // 不能和已有的工具重名
  description: string;                // 给模型看：做什么、什么时候用
  inputSchema: Record<string, unknown>;   // JSON Schema
  effect: "read" | "write" | "external";
  concurrency: "safe" | "exclusive";
  idempotent: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

**`effect` 决定要不要问用户**，请如实填写：

| `effect` | 含义 | ask 模式 | auto | plan | yolo |
|---|---|---|---|---|---|
| `read` | 只读 | 直接执行* | 直接执行* | 直接执行* | 直接执行 |
| `write` | 修改工作区里的文件 | 问 | 直接执行* | 拒绝 | 直接执行 |
| `external` | 其他副作用：执行命令、调用外部服务、发消息 | 问 | 审查† | 拒绝 | 直接执行 |

\* 参数里的 `path` 指向工作目录之外，或者带了 `url`（会把参数发到网络上）时，仍然要问（auto 模式下先审查）。用户可以对某个工具选"总是允许"。

† auto 模式下，本来要问的调用先交给模型按用户的请求审查：判断为安全的直接执行，有风险或拿不准的照常问用户。

其他字段：

- 调用前，jade 先按 `inputSchema` 检查参数，不合格时直接把错误告诉模型，`execute` 不会被调用。
- 参数里名为 `path` 的字段会被换成绝对路径（相对于工作目录），权限判断按这个路径进行。
- `concurrency: "safe"` 的工具可以和其他 safe 工具并发执行；会修改状态的工具写 `"exclusive"`。
- `idempotent` 表示同样的参数重复执行没有额外影响。崩溃恢复时据此决定能不能重跑。

`execute` 的参数和返回值：

```ts
interface ToolContext {
  sessionId: string;
  toolUseId: string;
  signal: AbortSignal;              // 用户按 esc 时中断，请把它传给 fetch、子进程等
  progress(update: unknown): void;  // 推送进度，不记入日志。传 { text: "..." } 时 jade 把文本显示在这次调用下面，其他格式不显示
}

interface ToolResult {
  content: string | Block[];        // 给模型看的结果
  isError?: boolean;                // 出错时设为 true，模型会据此调整
}
```

- 预期之内的失败（文件不存在、命令返回非零）请返回 `isError: true` 和说明，而不是抛异常。抛出的异常也会作为错误结果交给模型，但说明往往不如自己写的清楚。
- 结果会进入上下文，请控制长度：输出很长时截断，并告诉模型怎么拿到其余部分。

## Hook

hook 挂在扩展点上，分三种：

| 种类 | 能做什么 | 多个插件之间 | 出错或超时 |
|---|---|---|---|
| `observe` | 只看，不能改变流程 | 并发执行 | 记录错误，继续 |
| `transform` | 拿到一个值，返回修改后的值 | 按顺序串成流水线 | 本轮失败；声明 `optional: true` 时跳过这个 hook |
| `gate` | 返回 `deny` / `ask` / `allow` / `abstain` | 全部执行后取最严格的：`deny > ask > allow > abstain` | 当作 `deny` |

扩展点：

| 扩展点 | 种类 | 拿到的值 | 常见用途 |
|---|---|---|---|
| `session.start` / `session.end` | observe | 会话状态 | 初始化、收尾 |
| `context.build` | transform | 模型请求：`{ system, messages, tools, ext }` | 往系统提示词里加内容 |
| `context.project` | transform | 发给模型的消息列表（不改日志） | 压缩、过滤历史，附加信息 |
| `model.before` | transform | 模型请求 | 最后调整请求 |
| `model.after` | observe | 模型回复（含 `usage`） | 统计、审计 |
| `tool.gate` | gate | 工具调用：`{ toolUseId, name, input, tool }`，`tool` 是工具的声明（含 `effect`） | 权限规则 |
| `tool.before` | transform | 工具调用：`{ toolUseId, name, input }` | 改写参数 |
| `tool.after` | transform | 工具结果：`{ call, content, isError }` | 截断、脱敏、附加信息 |
| `turn.continue` | gate | 会话状态 | 决定模型是否可以继续下一步（`deny`/`ask` 都会停止） |
| `event` | observe | 每一个写入日志的事件 | 审计、同步到外部 |

写法：

```ts
{
  kind: "transform",
  point: "tool.after",
  timeoutMs: 5_000,        // 可选，默认 30 秒，不能关闭
  optional: true,          // 可选，只有 transform 有：出错时跳过而不是让本轮失败
  order: 0,                // 可选，见下文
  fn: async (outcome, ctx) => {
    return { ...outcome, content: [...] };   // transform 返回新值；返回 undefined 表示不改
  },
}
```

需要注意：

- **jade 自己的权限策略也是一个 `tool.gate`。** gate 取最严格的结果，所以插件可以让调用变严（`deny`、`ask`），但不能放宽 jade 的决定：插件返回 `allow`，jade 的策略返回 `ask`，结果仍然是 `ask`。没意见时返回 `abstain`。`deny` 时 `reason` 会交给模型，请写清楚为什么、模型应该怎么做。
- **每个 hook 拿到的是一份拷贝。** 直接修改参数对象不会影响别的插件，transform 要把结果返回出去。
- **执行顺序**：先按 `order` 从小到大，相同时 jade 内置的插件在前、用户层其次、项目层最后，再相同时按加载顺序。`/plugins` 的最后列出每个扩展点上的实际顺序。
- **`context.build` 加系统提示词时**，追加到 `system` 的末尾，每段要带 `stability`、`origin`、`trust`：

  ```ts
  fn: (req) => ({
    ...req,
    system: [...req.system, { text: "...", stability: "stable", origin: { by: "plugin", id: "me/x" }, trust: "trusted" }],
  })
  ```

  每次都一样的内容标 `stable`，会变的（日期、git 状态）标 `volatile` 并放在最后。stable 段内容一变，提示缓存就会失效。
- **`context.project` 每次请求模型前都会执行。** 同样的输入要给出同样的输出，否则提示缓存会失效；耗时的工作请把结果用 `ctx.record` 存起来，下次直接用。

### Hook 的上下文

```ts
interface HookContext {
  sessionId: string;
  signal: AbortSignal;                        // 超时或用户中断时触发
  derived: Readonly<Record<string, unknown>>; // 各插件用 record 存下的数据
  record(key: string, value: unknown): Promise<void>;
  emit(type: string, data: unknown): Promise<void>;
}
```

- **`record(key, value)`** 把数据写进会话日志，之后从 `ctx.derived[key]` 读到。恢复会话时这些数据跟着日志恢复，所以插件的决定可以重现。例如"编辑后检查"把每批检查的结果 record 下来，恢复会话时不用重新检查。key 请加上插件 id 做前缀。
- **`emit(type, data)`** 写一个自定义事件，类型会自动加上 `<插件 id>/` 前缀。
  - 类型为 `notice` 且 `data` 是 `{ text, level? }` 时，jade 在界面上显示 `[插件 id] text`；`level: "warning"` 时显示成黄色。
  - 其他类型只记进日志，其他插件可以在 `event` 扩展点上看到。
- `record`、`emit` **一定要 `await`**，而且只能在 hook 执行期间调用。hook 返回或超时之后再调用会被拒绝，没人处理的 rejection 可能让 jade 退出。

## 斜杠命令

```ts
interface PluginCommand {
  name: string;           // 字母、数字、-、_
  description?: string;   // 显示在 / 菜单里
  args?: string;          // 参数提示，例如 "<file>"
  instant?: boolean;      // 见下文
  run(args: string, ctx: PluginCommandContext): Awaitable<string | { prompt: string } | void>;
}

interface PluginCommandContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;    // 用户按 esc 时中断
  derived: Readonly<Record<string, unknown>>;
  ui: {
    interactive: boolean; // jade -p 等非交互运行时为 false，select / input 直接返回 undefined
    log(text: string): void;
    select<T>(title: string, choices: { label: string; value: T; hint?: string }[], opts?: { body?: string }): Promise<T | undefined>;
    input(title: string, opts?: { initial?: string; placeholder?: string; mask?: boolean }): Promise<string | undefined>; // mask：遮住输入（密钥）
  };
  note(text: string): void; // 附在用户下一条消息前面告诉模型，例如"用户删掉了某条记忆"
  session?: SessionControl; // 操作会话，见下文；instant 命令没有
}
```

`run` 的返回值：

| 返回 | 效果 |
|---|---|
| 字符串 | 显示给用户，不发给模型 |
| `{ prompt }` | 作为用户消息发给模型 |
| 不返回 | 什么也不做 |

- `args` 是命令名后面的全部文本。
- 和内置命令、`.jade/commands` 里的自定义命令同名时，插件的命令不生效，启动时会提示。
- 命令和对话轮次一样排队执行，不会和模型同时运行。只查看信息、只改插件自己设置的命令可以设 `instant: true`，模型工作时也立即执行；这种命令返回 `{ prompt }` 无效。
- 取消选择或输入时 `select`/`input` 返回 `undefined`，命令应该直接结束。
- `jade -p "/命令 参数"` 也能用。
- 内置插件的 `/memory`、`/skills`、`/mcp`、`/checks`、`/compact` 也是这样写的，见 [`src/plugins/core.ts`](../src/plugins/core.ts)。

### 操作会话：`ctx.session`

```ts
interface SessionControl {
  messages(): Message[];                              // 当前会话的消息（拷贝）
  record(key: string, value: unknown): Promise<void>; // 写一项派生数据进日志，恢复会话后仍在
  list(): Promise<{ id: string; title: string; at: string }[]>; // 这个目录里的会话，最近的在前
  clear(): Promise<void>;                             // 开始新会话，当前的保留、可以恢复
  resume(id: string): Promise<void>;                  // 换到另一个会话；失败时留在当前会话
  retry(): Promise<boolean>;                          // 上次请求在模型回复前失败时重新请求；没有可重试的返回 false
  reload(): Promise<void>;                            // 用新的插件实例继续当前会话：工具和提示词按现在的配置重新生成
}
```

- jade 自己的 `/clear`、`/resume`、`/retry`（`jade/sessions`）和 `/undo`（`jade/undo`）只用这个接口，见 [`src/plugins/sessions.ts`](../src/plugins/sessions.ts)。用 `replaces: ["jade/sessions"]` 可以换成你自己的实现。
- `/search`（`jade/web`）改了 `$JADE_HOME/.env` 里的搜索服务密钥后调用 `reload()`，新的工具配置在当前会话里立即生效，见 [`src/plugins/core.ts`](../src/plugins/core.ts)。`reload()` 之后调用它的插件实例被换掉，不要再用它的状态。
- 只有排队执行的命令有 `session`；`instant` 的命令在模型工作时执行，不能换会话或写日志，`session` 为 `undefined`。
- `record` 的 key 只能是插件的 id 或以 `"<id>/"` 开头，不能改别的插件（例如权限设置）记下的数据。
- `clear` / `resume` 之后，`session` 指向新的会话；命令返回 `{ prompt }` 时发给新会话。

## 远程应答（responder）

插件可以在终端之外替用户回答 jade 要问的事，例如把审批发到 Telegram、飞书，在手机上点"允许"：

```ts
interface Responder {
  approve?(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; message?: string } | undefined>;
  ask?(questions: { question: string; options: { label: string; description?: string }[] }[], signal: AbortSignal): Promise<string[] | undefined>;
}

interface ApprovalRequest {
  title: string;     // 例如 "bash(npm test)"，子 Agent 的以 "sub-agent " 开头
  tool: string;
  input: unknown;
  preview: string;   // 和终端里一样的 diff 或命令，不带颜色
  reason?: string;   // 为什么要问，例如 auto 模式的审查转给用户的理由
}
```

- 需要用户批准工具调用（主 Agent 和子 Agent 的都算）、或者模型调用 `ask_user` 时，jade 同时等终端和所有插件的 responder，用**最先**给出的回答，然后中止其余的：终端的对话框会关掉，插件收到 `signal` 的 abort，应该把发出去的消息改成"已处理"之类。用户按 esc 中断时也会 abort。
- 返回 `undefined` 表示这次不回答（例如还没配置好），jade 继续等别的；出错时显示警告，也当作不回答。
- `approve` 拒绝时，`message` 是用户说的话，会转告模型。手机上回答时不能选"总是允许"，只有终端能加规则。
- `ask` 要给每个问题一个非空的回答，按问题的顺序。
- 没有终端（`jade -p`、在 tmux 里无人值守）时，只要有 responder，审批照样能做；没有 responder 时照常直接拒绝。
- **只有用户层插件能提供 responder**，项目层插件的会被忽略并提示：随仓库来的代码不能替你批准它自己要做的事。进程外插件暂不支持。
- 进度通知不需要 responder：在 `event` 扩展点上挂 observe hook 就能看到每个事件。

## 预测下一条消息（suggest）

插件可以预测用户接下来想说什么，jade 在输入框里把它显示成灰字：

```ts
suggest: {
  async *next({ sessionId, messages }, signal) {
    // 返回整条文字（Promise<string | undefined>），或者像这样流式返回片段
    yield "run the ";
    yield "tests";
  },
}
```

- 只在终端界面里、一轮**正常结束**之后调用（还有排队的消息时不调用）；出错、中断、子 Agent、`jade -p` 都不调用。
- 只显示第一行。用户提交新输入或按 Esc 时 `signal` 中止，插件应该停下正在进行的请求。出错时显示一条警告。
- 按键由 jade 处理：**→** 或 **Tab** 接受全部，**Ctrl+→**（macOS 上 Option+→）接受一个词，**Esc** 丢弃。用户输入的和建议的开头对得上时只显示剩下的部分；对不上时隐藏，删回对得上时又出现。接受后只是填进输入框，不会直接发送。
- 多个插件都提供 `suggest` 时只用第一个，其余的启动时提示。
- 调用模型可以用 [`ctx.complete`](#调用模型ctxcomplete)。

## 改写用户消息（beforeSend）

```ts
beforeSend(text, { sessionId, signal }) {
  return text.replace(/\bJIRA-(\d+)\b/g, "https://jira.example.com/browse/JIRA-$1");
}
```

- 用户输入的消息发给模型之前调用；斜杠命令、自定义命令、skill 和 jade 自己发的话不经过它。
- 返回新的文字代替原文，返回 `undefined` 不改，返回空字符串不发送。多个插件按加载顺序依次处理。
- 改写过的消息在对话里提示 `[plugin <id> changed the message]`，点开能看到改写后的全文；对话里显示的仍是用户输入的原文。
- 出错或 30 秒内没有返回时，按原文发出并显示警告。

## 模型服务（providers）

插件可以提供新的模型服务，用户在 `$JADE_HOME/.env` 里写 `JADE_PROVIDER=<kind>` 选它：

```ts
interface PluginProvider {
  kind: string;                                   // JADE_PROVIDER 的值；字母、数字、-、_，不能是 openai-compat、openai、anthropic
  model(env): string;                             // 当前的模型名：状态栏、/model 显示，上下文窗口按它推断
  via?(env): string;                              // 系统提示词里"经什么服务运行"，例如 "the Foo API at api.foo.com"
  create(env): Provider | Promise<Provider>;      // uncarved 的 Provider；缺配置时抛错，信息直接显示给用户
  listModels?(env): Promise<string[]>;            // /model 里列出可选的模型
  settings?: ProviderSetting[];                   // /model 添加这个服务时依次询问的配置项
}

interface ProviderSetting {
  env: string;            // 环境变量名，例如 "FOO_API_KEY"；大写字母、数字、_，不能以 JADE_ 开头
  label: string;          // /model 里显示的名字
  secret?: boolean;       // 输入时遮住；留空沿用已有的值
  model?: boolean;        // 这一项是模型名：从 listModels 里选，/model 换模型时只改它；最多一项
  required?: boolean;     // 不能为空
  placeholder?: string;
}
```

```ts
definePlugin({
  id: "me/foo",
  version: "1.0.0",
  providers: [{
    kind: "foo",
    model: (env) => env.FOO_MODEL ?? "foo-large",
    settings: [
      { env: "FOO_API_KEY", label: "Foo API key", secret: true, required: true },
      { env: "FOO_MODEL", label: "Model", model: true },
    ],
    listModels: async (env) => fetchFooModels(env.FOO_API_KEY),
    create: (env) => {
      if (!env.FOO_API_KEY) throw new Error("FOO_API_KEY is required for the foo provider");
      return fooProvider({ apiKey: env.FOO_API_KEY, model: env.FOO_MODEL ?? "foo-large" });
    },
  }],
});
```

- `env` 是 jade 的环境变量，包括 `$JADE_HOME/.env` 里的。服务自己的配置项（地址、密钥）由插件定名字，用户写进 `.env`。
- **只认用户层插件**：服务能看到全部对话和 API key，项目层插件提供的 `providers` 被忽略。
- **只在启动时读一次**：provider 是整个进程共用的（主会话、子 Agent、压缩、auto 模式的审查、`ctx.complete`），换会话不重建，所以 `create` 不要依赖按会话的状态。
- jade 在外面包一层重试和限速（`JADE_RPM`），压缩、子 Agent 也都经过它。要让重试正确工作，请求失败时抛 uncarved 的 `ProviderError`：能重试的设 `retryable: true`，限流时带上 `status: 429`。
- `JADE_EFFORT`、`JADE_MAX_TOKENS` 不检查，插件愿意的话自己从 `env` 里读；`JADE_VISION` 不设时算不能看图片。
- 选了插件的服务时，jade 等插件加载完才创建 provider，启动会比内置服务慢一点。`JADE_PROVIDER` 写的名字没有插件提供时，启动时报错并列出可选的服务。
- **`/model`**：声明了 `settings` 的服务出现在 "Add a model… → Another service…" 的列表里，选中后依次询问各项，再选模型；配置写进 `$JADE_HOME/.env`，并和内置服务一样记进 `models.json`，之后可以在 `/model` 里直接切换回来（类型和模型名以外的配置项都相同的算同一个服务）。没有声明模型名（`model: true`）的服务，`/model` 不能换它的模型。
- 第一次运行、还没配置任何模型时，jade 在加载插件之前就进入配置流程，那时的列表里只有内置服务；可以先手动在 `.env` 里写 `JADE_PROVIDER`，或者先配一个内置服务，再用 `/model` 换。
- 进程外插件不能提供 `providers`。

## 带上 skills、命令和 MCP 服务

插件目录里可以放这些内容，格式和 jade 自己的完全相同，有没有代码都行：

| 目录或文件 | 内容 | 格式 |
|---|---|---|
| `skills/<name>/SKILL.md` | skill | 见 [README 的 Skills](../README.md#skills) |
| `commands/<name>.md` | 用 Markdown 写的斜杠命令 | 见 [README 的自定义命令](../README.md#自定义命令) |
| `mcp.json`（或 `.mcp.json`） | MCP 服务 | 见 [README 的 MCP](../README.md#mcp) |

- MCP 配置里的 `${JADE_PLUGIN_DIR}` 换成插件目录，可以启动插件自带的服务：`{ "command": "node", "args": ["${JADE_PLUGIN_DIR}/server.js"] }`。
- 优先级低于自己放的：同一层里，`~/.jade`、`.jade` 下的同名 skill 和命令覆盖插件带的；任何 `mcp.json` 里的同名 MCP 服务都覆盖插件带的。
- 项目层插件带的内容和仓库里 `.jade/skills`、`.jade/commands` 一样对待：skill 列表标为不可信，MCP 服务启动前要确认。
- 停用插件时，它带的内容一起停用。

**兼容 Claude Code 插件**：有 `.claude-plugin/plugin.json` 的目录也认，它的 `name`、`version`、`description`，以及 `skills`、`commands`（自定义路径）、`mcpServers`（文件路径或者直接写配置）都会用上，`${CLAUDE_PLUGIN_ROOT}` 也会展开。所以只带 skills、命令、MCP 服务的 Claude Code 插件可以直接 `jade plugin add` 安装。它的 `hooks/` 和 `agents/` jade 还不支持，安装和启动时会提示被忽略。

## 内置插件

jade 自己的功能都是插件，和第三方插件用同一套接口（[`src/distro.ts`](../src/distro.ts) 组装它们）：

| id | 提供 |
|---|---|
| `jade/policy` | 权限模式和审批，**不能停用或代替** |
| `jade/prompts` | 系统提示词、环境信息、AGENTS.md / CLAUDE.md |
| `jade/fs` | read_file、write_file、edit_file、multi_edit、list_dir、glob、grep |
| `jade/shell` | bash、bash_output、kill_shell |
| `jade/web` | web_fetch、web_search、`/search` |
| `jade/todo` | todo_write |
| `jade/memory` | memory 工具、提示词里的记忆、`/memory` |
| `jade/task` | task 工具（只读子 Agent） |
| `jade/skills` | skill 工具、提示词里的 skill 列表、`/skills` |
| `jade/mcp` | MCP 服务的工具、`/mcp` |
| `jade/checks` | 编辑后检查、`/checks` |
| `jade/compact` | 接近上下文上限时压缩历史、`/compact` |
| `jade/budget` | 每轮的步数上限 |
| `jade/sessions` | `/clear`、`/resume`、`/retry` |
| `jade/undo` | `/undo`（恢复上一轮改过的文件） |
| `jade/repeats` | 拒绝同一次回复里重复的调用，提醒反复失败的调用 |

用户可以用 `jade plugin disable <id>` 停用其中任何一个（`jade/policy` 除外），停用后它的工具、提示词段落和命令都不再出现。

插件用 `replaces` 代替内置插件：

```ts
definePlugin({
  id: "me/web",
  version: "1.0.0",
  replaces: ["jade/web"],      // jade/web 不再加载
  tools: [myWebFetch],         // 可以用 web_fetch 这个名字
});
```

- 被代替的内置插件不加载，代替者可以提供同名的工具。
- 代替者自己因为别的原因被跳过（例如另一个工具名冲突）时，被代替的内置插件照常加载。
- `jade/policy` 不能代替：审批是安全边界。想让审批更严格，加一个 `tool.gate` hook，多个 gate 的结果取最严格的那个（deny > ask > allow）。
- 代替 `jade/prompts` 时，你的 `context.build` hook 要自己提供基础提示词。其他内置插件（记忆、skill 列表、MCP 说明）的段落是接在已有段落后面的，不受影响。
- `/plugins` 和 `jade plugin list` 显示每个内置插件是开着、停用还是被谁代替了。

## 进程外插件（任何语言）

`plugin.json` 里写了 `command` 时，jade 启动这个进程，经 stdin/stdout 用 JSON-RPC 2.0 通信，一行一条消息。插件可以用任何语言编写。进程外插件**只能提供 hook**，不能提供工具和斜杠命令。

```json
{
  "command": "python",
  "args": ["redact.py"],
  "env": { "LOG_LEVEL": "info" },
  "inheritEnv": true,
  "initTimeoutMs": 10000
}
```

| 字段 | 说明 |
|---|---|
| `command` | 启动命令。`./`、`../` 开头的相对于插件目录 |
| `args` | 参数 |
| `env` | 额外的环境变量 |
| `inheritEnv` | 默认 `true`：继承 jade 的全部环境变量，**包括 API key**。为 `false` 时只有 `env` 里的变量，`PATH` 等需要自己写进 `env` |
| `initTimeoutMs` | 等待插件回复 `initialize` 的时间，默认 10 秒 |

进程的工作目录是插件目录。Windows 上不经过 shell 启动，`npx`、`npm` 这类 `.cmd` 包装命令无法直接启动，请直接写解释器，例如 `"command": "node", "args": ["main.js"]`。

### 协议

jade 发给插件的请求：

| 方法 | 参数 | 回复 |
|---|---|---|
| `initialize` | `{ kernel: "0.1.0" }` | 插件清单，见下文 |
| `hook` | `{ hook, sessionId, payload }` | transform：只含要修改的字段的对象；gate：`{ decision, reason? }`；observe：`{}` |
| `$/cancel`（通知，无需回复） | `{ id }` | — |
| `shutdown` | `{}` | `{}`，然后退出 |

插件清单：

```json
{
  "id": "example/redact-secrets",
  "version": "1.0.0",
  "kernel": "^0.1",
  "needs": ["transform:tool.after"],
  "hooks": [
    { "name": "redact", "kind": "transform", "point": "tool.after", "reads": ["content"], "writes": ["content"], "timeoutMs": 5000 }
  ]
}
```

- `name` 由插件自己起，jade 调用 hook 时原样带回来。
- `reads` 是插件要收到的字段，`writes` 是插件可以修改的字段，都只能是顶层字段。jade 只发送 `reads` 里的字段，回复里出现 `writes` 之外的字段算作出错。各扩展点可读、可写的字段：

| 扩展点 | reads | writes |
|---|---|---|
| `context.project` | `messages` | `messages` |
| `context.build`、`model.before` | `system` `messages` `tools` `ext` | 同左 |
| `tool.before` | `toolUseId` `name` `input` | `input` |
| `tool.after` | `call` `content` `isError` | `content` `isError` |
| `tool.gate` | `toolUseId` `name` `input` `tool` | — |
| `turn.continue` | `phase` `messages` | — |
| `model.after` | `model` `content` `stopReason` `usage` | — |
| `event` | `id` `type` `seq` `at` `data` `origin` | — |
| `session.start`、`session.end` | `sessionId` `phase` `plugins` | — |

  `reads` 里还可以写 `"derived"`，收到派生数据的快照。
- 进程外的 transform 不能声明 `optional`，`timeoutMs` 必填。
- 在处理某次 `hook` 调用期间，插件可以反过来向 jade 发请求：`log/record { call, key, value }`、`log/emit { call, type, data }`，`call` 是那次 `hook` 请求的 id。分别需要 `log:record`、`log:emit` 能力。
- 日志请写到 stderr。stdout 上任何不是 JSON-RPC 的输出（空行除外）都会让 jade 结束插件进程。
- stdin 关闭时请退出。
- 进程意外退出后，jade 会提示，`/plugins` 能看到它最后的 stderr 输出。jade 不会自动重启插件，这之后它的 hook 都会出错：gate 出错按 `deny` 处理，transform 出错会让这一轮失败。重启 jade 即可恢复。

完整设计见 [5.5-out-of-process-hooks.md](../../../docs/design/5.5-out-of-process-hooks.md)，Python 的完整实现见 [`redact-secrets/redact.py`](../examples/plugins/redact-secrets/redact.py)。

## 安全

项目层插件随仓库分发，克隆一个仓库不应该等于运行它带的代码，所以：

- 第一次加载前，jade 列出插件目录里的文件和内容哈希（进程外插件还有启动命令），请你确认。确认记录按哈希保存在 `$JADE_HOME/trust.jsonl`，插件目录里**任何文件**变了都要重新确认。
- 非交互运行（`jade -p`、管道）时没法确认，未确认的项目层插件会被跳过。先在这个目录里交互运行一次 jade，确认之后就可以了。
- 为了让哈希覆盖插件运行的全部代码，项目层的进程内插件只能导入：插件目录里的文件（包括插件自带的 `node_modules`）、Node/Bun 的内置模块和内核本身。`import type` 不受限制。另外：
  - 不能用模块名在运行时才确定的动态 `import()` 和 `createRequire`；
  - 插件目录里不能有符号链接，所以 pnpm 安装的 `node_modules` 不行，请用 npm 或 bun 安装依赖，或者把插件打包成单个文件。
- 用户层插件不做这些检查，也不需要确认。

确认之后，插件就是以你的身份运行的普通代码，能读写文件、访问网络、读取环境变量里的密钥。以上措施只能保证"运行的就是你确认过的内容"，**不是沙箱**。只确认你信任的插件。

## 调试

- `/plugins`：内置插件的状态；已加载的插件、来源，以及各自提供的工具、hook、命令、代替的内置插件、带的内容；进程外插件的运行状态，退出了的还显示最后的 stderr；最后是每个扩展点上 hook 的执行顺序。
- `jade plugin list`：不启动会话也能看装了什么，以及哪些插件读不了（`broken`）。
- hook 出错时，界面上显示 `[hook error] 插件 id at 扩展点: 错误信息`。
- 会话日志在 `$JADE_HOME/sessions/<会话 id>.jsonl`，插件的 `record`、`emit` 都在里面。
- 想在测试里跑插件，可以像 jade 自己的测试那样，用 `loadPlugin` 加载插件目录，传给 `createJade({ extensions })`，再用一个按脚本回复的假 provider 驱动对话。见 [`test/plugins.test.ts`](../test/plugins.test.ts)。

## 发布前检查

- [ ] `id` 全局唯一，带上作者前缀；改了行为就升 `version`，不兼容的改动升主版本。
- [ ] 每个工具的 `effect` 如实填写，`description` 写清楚什么时候该用。
- [ ] 所有 hook 设了合理的 `timeoutMs`；不影响正确性的 transform 声明 `optional: true`。
- [ ] `ctx.record`、`ctx.emit` 都 `await` 了。
- [ ] `context.build`、`context.project` 对同样的输入给出同样的输出。
- [ ] 项目层插件没有导入插件目录之外的文件。
- [ ] 进程外插件只往 stdout 写 JSON-RPC，stdin 关闭时会退出。
- [ ] 用 `jade plugin add <你的仓库或包>` 在一个干净的 `JADE_HOME` 里试装一次（`JADE_HOME=/tmp/jh jade plugin add …`）。
- [ ] 代替内置插件时，被代替的那个提供的东西你都提供了（或者确实不需要）。
