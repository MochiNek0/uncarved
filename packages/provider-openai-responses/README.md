# @uncarved/provider-openai-responses

[uncarved](https://www.npmjs.com/package/uncarved) 的 OpenAI Responses API（`/responses`）provider。零依赖，基于 `fetch` 和 SSE。

## 安装

```sh
npm install uncarved @uncarved/provider-openai-responses
```

## 用法

```ts
import { openaiResponsesProvider } from "@uncarved/provider-openai-responses";

const provider = openaiResponsesProvider({
  baseURL: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5",
  reasoning: { effort: "medium", summary: "auto" },
});
```

## 选项

| 选项 | 说明 |
|---|---|
| `baseURL` | 必填，例如 `https://api.openai.com/v1` |
| `model` | 必填 |
| `apiKey` | |
| `maxTokens` | |
| `reasoning` | `{ effort?, summary? }` |
| `store` | 默认 `false`。为 `true` 时服务端保存响应 |
| `extraBody` / `headers` | 每次请求合并进请求体 / 请求头 |
| `fetch` | 替换 `fetch` 实现，便于测试或走代理 |

单次请求可以通过 `ModelRequest.ext["openai-responses"]` 覆盖：`{ body?, headers? }`。

## 行为

- **无状态**：默认 `store: false`，每次发送完整历史，不依赖服务端保存的会话。
- **原样回传**：模型输出的每个 item 原样存进内容块的 `ext`，下一轮原样发回，所以推理模型的 `encrypted_content` 能跨轮保留。
- 出错时抛出内核的 `ProviderError`，带 `retryable`、`status`、`retryAfterMs`。

## 许可证

MIT
