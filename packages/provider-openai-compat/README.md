# @uncarved/provider-openai-compat

[uncarved](https://www.npmjs.com/package/uncarved) 的 OpenAI 兼容格式（`/chat/completions`）provider。零依赖，基于 `fetch` 和 SSE。

适用于任何提供兼容 `/chat/completions` 接口的服务，例如 DeepSeek、OpenRouter、Ollama、vLLM 等。

## 安装

```sh
npm install uncarved @uncarved/provider-openai-compat
```

## 用法

```ts
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";

const provider = openaiCompatProvider({
  baseURL: "http://localhost:11434/v1",
  model: "qwen3",
});
```

## 选项

| 选项 | 说明 |
|---|---|
| `baseURL` | 必填，例如 `https://api.deepseek.com/v1` |
| `model` | 必填 |
| `apiKey` | |
| `maxTokens` | |
| `extraBody` / `headers` | 每次请求合并进请求体 / 请求头 |
| `fetch` | 替换 `fetch` 实现，便于测试或走代理 |

单次请求可以通过 `ModelRequest.ext["openai-compat"]` 覆盖：`{ body?, headers? }`。

## 行为

- 支持流式工具调用，兼容不返回 `index` 的服务端。
- 服务端返回 `reasoning_content` 时作为思考块保留。
- 出错（包括流中途的错误块）时抛出内核的 `ProviderError`，带 `retryable`、`status`、`retryAfterMs`。

## 许可证

MIT
