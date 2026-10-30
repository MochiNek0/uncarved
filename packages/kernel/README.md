# uncarved

极简、完全可定制的 Agent 内核。它只提供**一个可中断、可恢复、可重放的 Agent 循环**，以及让外部改变这个循环的扩展点。提示词、工具、权限策略都不在内核里，全部由插件提供。

设计约束见 [CONSTITUTION.md](https://github.com/MochiNek0/uncarved/blob/main/CONSTITUTION.md)。

## 安装

```sh
npm install uncarved
```

内核不包含模型调用，还需要一个 provider，例如 [`@uncarved/provider-anthropic`](https://www.npmjs.com/package/@uncarved/provider-anthropic)。运行环境：Node.js ≥ 22.18 或 Bun（`loadProjectPlugin` 直接导入 `.ts` 入口，依赖 Node 22.18 起默认开启的类型剥离）。

## 快速开始

```ts
import { MemoryLogStore, Runtime, type Plugin } from "uncarved";
import { anthropicProvider } from "@uncarved/provider-anthropic";

const clock: Plugin = {
  id: "example/clock",
  version: "0.1.0",
  kernel: "^0.1",
  tools: [
    {
      name: "now",
      description: "Return the current time in ISO 8601.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      concurrency: "safe",
      idempotent: false,
      async execute() {
        return { content: new Date().toISOString() };
      },
    },
  ],
};

const rt = await Runtime.create({
  store: new MemoryLogStore(),
  provider: anthropicProvider(),
  plugins: [clock],
});

rt.subscribe((n) => {
  if (n.type === "delta" && n.delta.kind === "text") process.stdout.write(n.delta.text);
});

await rt.send({
  kind: "message",
  content: [{ kind: "text", text: "现在几点？", origin: { by: "user" }, trust: "trusted" }],
});
```

## Runtime

| 方法 | 说明 |
|---|---|
| `Runtime.create(opts)` | 新建会话。`opts`：`store`、`provider`、`plugins`，可选 `sessionId`、`parent` |
| `Runtime.resume(opts)` | 从日志重建并继续已有会话，`sessionId` 必填 |
| `rt.send(input)` | 发送用户输入，跑完这一轮后 resolve |
| `rt.subscribe(fn)` | 订阅通知：`event`、`delta`、`tool-progress`、`awaiting`、`warning`、`hook-error`。返回取消订阅函数 |
| `rt.abort(reason?)` | 中断当前操作 |
| `rt.recover()` | 崩溃或重启后，继续执行日志里尚未完成的工作 |
| `rt.close()` | 结束会话，之后日志不再接受事件 |
| `rt.detach()` | 宿主离开会话，会话保持可恢复，之后本实例不再可用 |

**取消是协作式的**：`abort()` 之后不再开始新的步骤，正在运行的 hook、Provider、工具通过 `signal` 得知中断。忽略 `signal` 的 hook 最多运行到自己的超时；忽略 `signal` 的 Provider 或工具会让这一轮一直等到它们自己返回。内置的 Provider 都不设请求超时，需要时用 `AbortSignal.timeout()` 之类的方式在外层中断。

内核状态完全由事件日志重建。`MemoryLogStore` 只在内存里；要持久化可以用 [`@uncarved/store-jsonl`](https://www.npmjs.com/package/@uncarved/store-jsonl)，或自己实现 `LogStore` 接口。

## 插件

插件是一个普通对象：

```ts
interface Plugin {
  id: string;
  version: string;
  kernel: string;         // 兼容的内核版本，semver ^ 范围，如 "^0.1"
  needs?: string[];       // 用到的内核能力，见下表
  resume?: "continue" | "ask" | "abort";
  layer?: Layer;
  tools?: Tool[];
  hooks?: HookSpec[];
}
```

hook 用到的能力必须在 `needs` 里声明，否则拒绝加载。可用能力（`<种类>:<挂载点>`）：

| 种类 | 挂载点 |
|---|---|
| `observe` | `session.start`、`session.end`、`model.after`、`event` |
| `transform` | `context.build`、`context.project`、`model.before`、`tool.before`、`tool.after` |
| `gate` | `tool.gate`、`turn.continue` |
| `log` | `record`、`emit` |

权限类决策遵循**拒绝优先**：任何一个插件的拒绝都不能被其他插件的允许推翻。所有 hook 都有超时，不能关闭。

> **注意：没有任何 `tool.gate` 插件表态时，工具调用默认放行。** 内核不内置权限策略：所有 gate 都返回 `abstain`（或根本没有 gate）时，任何工具都会直接执行，包括 `effect` 为 `write`、`external` 的工具。需要审批或限制时，请加载一个 `tool.gate` 插件，例如对 `effect !== "read"` 的调用返回 `ask`。gate 出错、超时或返回值不合法时按 `deny` 处理。

`kernel` 字段按 semver 的 `^` 规则匹配内核版本：在 0.x 阶段，小版本之间视为不兼容，`^0.1` 只接受 0.1.x。

编写插件时注意：

- **`ctx.record`、`ctx.emit` 一定要 `await`。** hook 已经结束、能力没有声明、会话已经关闭时它们会 reject；没人处理的 rejection 在 Node 下默认会让整个进程退出。
- **项目层插件目录里不能有符号链接**（链接可能指向确认范围之外的文件）。pnpm 安装的 `node_modules` 由符号链接组成，这样的插件无法加载：请用 npm 安装依赖，或把插件打包成单个文件。

## TypeScript

类型声明用到了 `AbortSignal` 等全局类型。项目的 `lib` 里没有 `DOM`、也没有安装 `@types/node` 时，请开启 `skipLibCheck` 或安装 `@types/node`。

## Provider

模型调用通过 `Provider` 接口接入：

```ts
interface Provider {
  id: string;
  complete(
    request: ModelRequest,
    options: { signal: AbortSignal; onDelta?: (delta: Delta) => void },
  ): Promise<ModelResponse>;
}
```

一个 Provider 可以包装另一个 Provider 来做路由、重试、限流。约定见 [provider-contract.md](https://github.com/MochiNek0/uncarved/blob/main/docs/design/provider-contract.md)。

现成实现：

- [`@uncarved/provider-anthropic`](https://www.npmjs.com/package/@uncarved/provider-anthropic)
- [`@uncarved/provider-openai-responses`](https://www.npmjs.com/package/@uncarved/provider-openai-responses)
- [`@uncarved/provider-openai-compat`](https://www.npmjs.com/package/@uncarved/provider-openai-compat)

## 许可证

MIT
