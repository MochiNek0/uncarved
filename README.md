# Uncarved

> 未经雕琢的原木。内核只提供循环这块木料，不预设形状，由每个发行版去雕刻。

Uncarved 是一个极简、完全可定制的 Agent 内核。它只提供**一个可中断、可恢复、可重放的 Agent 循环**，以及让外部改变这个循环的扩展点。提示词、工具、权限策略都不在内核里，全部由插件提供。

设计约束见 [CONSTITUTION.md](./CONSTITUTION.md)。

## 包

| 包 | 说明 |
|---|---|
| [`uncarved`](./packages/kernel) | 内核：Runtime、事件日志、插件与 hook、信任模型 |
| [`@uncarved/store-jsonl`](./packages/store-jsonl) | 基于 JSONL 文件的日志存储和信任存储，带文件锁 |
| [`@uncarved/plugin-stdio`](./packages/plugin-stdio) | 进程外插件：通过 stdio（JSON-RPC 2.0）运行任意语言写的插件 |
| [`@uncarved/provider-anthropic`](./packages/provider-anthropic) | Claude Messages API |
| [`@uncarved/provider-openai-responses`](./packages/provider-openai-responses) | OpenAI Responses API |
| [`@uncarved/provider-openai-compat`](./packages/provider-openai-compat) | 任意兼容 `/chat/completions` 的服务 |

运行环境：Node.js ≥ 22 或 Bun。

## 安装

```sh
npm install uncarved @uncarved/provider-anthropic
```

## 快速开始

```ts
import { MemoryLogStore, Runtime, type Plugin } from "uncarved";
import { anthropicProvider } from "@uncarved/provider-anthropic";

// 工具由插件提供，内核不内置任何工具
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
  provider: anthropicProvider(), // 读取 ANTHROPIC_API_KEY
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

更完整的例子（从 `.md` 文件加载系统提示词、文件读写工具）见 [examples/](./examples)。

## 持久化与恢复

内核状态完全由事件日志重建。换成 JSONL 存储后，会话可以在进程重启后继续：

```ts
import { Runtime } from "uncarved";
import { JsonlLogStore } from "@uncarved/store-jsonl";

const store = new JsonlLogStore(".sessions");

const rt = await Runtime.create({ store, provider, plugins, sessionId: "demo" });
// ……进程退出后：
const resumed = await Runtime.resume({ store, provider, plugins, sessionId: "demo" });
```

同一个会话同时只能有一个写入者，冲突时抛出 `ConcurrentWrite`。

## Provider

```ts
import { anthropicProvider } from "@uncarved/provider-anthropic";
import { openaiResponsesProvider } from "@uncarved/provider-openai-responses";
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";

anthropicProvider({ model: "claude-opus-5-5", effort: "high" });
openaiResponsesProvider({ baseURL: "https://api.openai.com/v1", apiKey, model: "gpt-5" });
openaiCompatProvider({ baseURL: "http://localhost:11434/v1", model: "qwen3" });
```

三者都支持 `extraBody` 和 `headers`，单次请求还可以通过 `ModelRequest.ext[PROVIDER_ID]` 覆盖。Provider 需要满足的约定见 [docs/design/provider-contract.md](./docs/design/provider-contract.md)。

## 插件

插件是一个普通对象，声明它需要的内核能力（`needs`），并提供工具（`tools`）和 hook（`hooks`）。可用能力：

| 类型 | 挂载点 |
|---|---|
| `observe` | `session.start`、`session.end`、`model.after`、`event` |
| `transform` | `context.build`、`context.project`、`model.before`、`tool.before`、`tool.after` |
| `gate` | `tool.gate`、`turn.continue` |
| `log` | `record`、`emit` |

权限类决策遵循**拒绝优先**：任何一个插件的拒绝都不能被其他插件的允许推翻。

### 进程外插件

```ts
import { spawnPlugin } from "@uncarved/plugin-stdio";

const plugin = await spawnPlugin({ command: "python", args: ["my_plugin.py"] });
const rt = await Runtime.create({ store, provider, plugins: [plugin] });
// ……
await plugin.close();
```

项目层（`layer: "project"`）的插件来自代码仓库，启动前必须经过信任确认（传入 `trust`）。协议见 [docs/design/5.5-out-of-process-hooks.md](./docs/design/5.5-out-of-process-hooks.md)。

## 开发

```sh
bun install
bun test           # 运行测试
bun run typecheck  # 类型检查
bun run build      # 编译各包到 dist/
```

## 许可证

[MIT](./LICENSE)
