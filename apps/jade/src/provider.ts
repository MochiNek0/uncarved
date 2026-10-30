// Provider：按环境变量选择，外面包一层重试（4.7：重试是包装 Provider 的事）。

import { anthropicProvider } from "@uncarved/provider-anthropic";
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";
import { openaiResponsesProvider } from "@uncarved/provider-openai-responses";
import { ProviderError, type Provider } from "uncarved";

export interface RetryOptions {
  /** 最多重试几次，默认 4 */
  retries?: number;
  /** 首次等待，之后每次翻倍，默认 1000ms；上游给了 retryAfterMs 时以它为准 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 每次重试前通知宿主（显示用） */
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export function withRetry(inner: Provider, opts: RetryOptions = {}): Provider {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  return {
    id: `retry(${inner.id})`,
    async complete(request, options) {
      for (let attempt = 1; ; attempt++) {
        let streamed = false;
        try {
          const res = await inner.complete(request, {
            ...options,
            onDelta: (d) => {
              streamed = true;
              options.onDelta?.(d);
            },
          });
          // 实际回复的是被包装者（4.7 第 3 款）
          return { ...res, provider: res.provider ?? inner.id };
        } catch (err) {
          if (!(err instanceof ProviderError) || !err.retryable || attempt > retries || options.signal.aborted) throw err;
          const delayMs = Math.min(err.retryAfterMs ?? base * 2 ** (attempt - 1), max);
          // 失败的这次已经推送过增量的，先让订阅者作废它们（4.7）
          if (streamed) options.onDelta?.({ kind: "reset" });
          opts.onRetry?.({ attempt, delayMs, error: err });
          await sleep(delayMs, options.signal);
        }
      }
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * 按环境变量选择：
 * - OPENAI_API_KEY：OpenAI Responses API，可选 OPENAI_BASE_URL、OPENAI_MODEL
 * - OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_MODEL（+ OPENAI_COMPAT_API_KEY）：兼容 /chat/completions 的服务，
 *   可选 OPENAI_COMPAT_EXTRA_BODY（JSON 对象，合并进每次请求体，例如开启思考的 {"enable_thinking":true}）
 * - 否则 Claude（ANTHROPIC_API_KEY），可选 ANTHROPIC_MODEL
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): Provider {
  if (env.OPENAI_API_KEY) {
    return openaiResponsesProvider({
      baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-5",
    });
  }
  if (env.OPENAI_COMPAT_BASE_URL) {
    if (!env.OPENAI_COMPAT_MODEL) throw new Error("OPENAI_COMPAT_MODEL is required when OPENAI_COMPAT_BASE_URL is set");
    return openaiCompatProvider({
      baseURL: env.OPENAI_COMPAT_BASE_URL,
      apiKey: env.OPENAI_COMPAT_API_KEY,
      model: env.OPENAI_COMPAT_MODEL,
      extraBody: env.OPENAI_COMPAT_EXTRA_BODY ? jsonObject("OPENAI_COMPAT_EXTRA_BODY", env.OPENAI_COMPAT_EXTRA_BODY) : undefined,
    });
  }
  return anthropicProvider({ model: env.ANTHROPIC_MODEL, effort: "high" });
}

function jsonObject(name: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} must be a JSON object, got ${JSON.stringify(text)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be a JSON object, got ${text}`);
  return value as Record<string, unknown>;
}
