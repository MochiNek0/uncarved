# @uncarved/provider-anthropic

[uncarved](https://www.npmjs.com/package/uncarved) 的 Claude provider，基于 `@anthropic-ai/sdk` 调用 Messages API。

## 安装

```sh
npm install uncarved @uncarved/provider-anthropic
```

## 用法

```ts
import { MemoryLogStore, Runtime } from "uncarved";
import { anthropicProvider } from "@uncarved/provider-anthropic";

const rt = await Runtime.create({
  store: new MemoryLogStore(),
  provider: anthropicProvider({ effort: "medium" }), // 默认读取 ANTHROPIC_API_KEY
});
```

## 选项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `client` | `new Anthropic()` | 自定义 SDK 客户端（API key、base URL、代理等） |
| `model` | `claude-opus-5-5` | |
| `maxTokens` | `64000` | |
| `effort` | `high` | `low` / `medium` / `high` / `xhigh` / `max` |
| `thinkingDisplay` | `summarized` | 流式输出时是否显示思考摘要，`omitted` 关闭 |
| `fallbacks` | `true` | 模型因安全策略拒绝时由服务端换模型重试 |
| `extraBody` | | 每次请求合并进请求参数 |
| `headers` | | 每次请求合并进请求头 |

单次请求可以通过 `ModelRequest.ext["anthropic"]` 覆盖：`{ body?, headers? }`，通常由 `model.before` 插件写入。

出错时抛出内核的 `ProviderError`，带 `retryable`、`status`、`retryAfterMs`，便于外层包装 Provider 做重试。

## 许可证

MIT
