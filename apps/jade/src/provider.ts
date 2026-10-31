// Provider：按环境变量选择，外面包一层重试（4.7：重试是包装 Provider 的事）。

import { ProviderError, type Provider } from "uncarved";

export interface RetryOptions {
  /** 最多重试几次，默认 4 */
  retries?: number;
  /** 首次等待，之后每次翻倍，默认 1000ms；上游给了 retryAfterMs 时以它为准 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 退避时间的随机数，默认 Math.random；测试用 */
  random?: () => number;
  /** 每次重试前通知宿主（显示用） */
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export function withRetry(inner: Provider, opts: RetryOptions = {}): Provider {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  const random = opts.random ?? Math.random;
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
          // 没有 retryAfterMs 时随机取后一半，并行的子 Agent 同时遇到 429 时不会同时重试
          const delayMs = Math.min(err.retryAfterMs ?? base * 2 ** (attempt - 1) * (0.5 + 0.5 * random()), max);
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

export type ProviderKind = "openai-compat" | "openai" | "anthropic";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["openai-compat", "openai", "anthropic"];

type Env = Record<string, string | undefined>;

/** JADE_EFFORT 可取的值；openai-compat 没有统一的字段，用 OPENAI_COMPAT_EXTRA_BODY 自己设 */
export const EFFORTS: Record<ProviderKind, readonly string[] | undefined> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["minimal", "low", "medium", "high"],
  "openai-compat": undefined,
};

/** JADE_EFFORT；不设时 Claude 用 high，OpenAI 用服务端默认值 */
export function effortFromEnv(env: Env = process.env): string | undefined {
  const effort = env.JADE_EFFORT;
  if (!effort) return undefined;
  const kind = providerKind(env);
  const allowed = EFFORTS[kind];
  if (!allowed) throw new Error(`JADE_EFFORT is not supported for the ${kind} provider; set it in OPENAI_COMPAT_EXTRA_BODY instead`);
  if (!allowed.includes(effort)) throw new Error(`JADE_EFFORT must be one of ${allowed.join(", ")} for the ${kind} provider, got ${JSON.stringify(effort)}`);
  return effort;
}

/** JADE_PROVIDER 指定时用它；否则按 OPENAI_API_KEY、OPENAI_COMPAT_BASE_URL、ANTHROPIC_API_KEY 的顺序 */
export function providerKind(env: Env = process.env): ProviderKind {
  const named = env.JADE_PROVIDER;
  if (named) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(named)) {
      throw new Error(`JADE_PROVIDER must be one of ${PROVIDER_KINDS.join(", ")}, got ${JSON.stringify(named)}`);
    }
    return named as ProviderKind;
  }
  if (env.OPENAI_API_KEY) return "openai";
  if (env.OPENAI_COMPAT_BASE_URL) return "openai-compat";
  return "anthropic";
}

export interface ProviderInfo {
  kind: ProviderKind;
  model: string;
  baseURL?: string;
}

/** 当前配置会用哪个服务、哪个模型（状态栏和 /model 显示用） */
export function providerInfo(env: Env = process.env): ProviderInfo {
  const kind = providerKind(env);
  if (kind === "openai") return { kind, model: env.OPENAI_MODEL ?? "gpt-5", baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" };
  if (kind === "openai-compat") return { kind, model: env.OPENAI_COMPAT_MODEL ?? "", baseURL: env.OPENAI_COMPAT_BASE_URL };
  return { kind, model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5", baseURL: env.ANTHROPIC_BASE_URL };
}

/**
 * 按环境变量创建，服务由 providerKind 决定：
 * - openai：OpenAI Responses API，OPENAI_API_KEY，可选 OPENAI_BASE_URL、OPENAI_MODEL
 * - openai-compat：兼容 /chat/completions 的服务，OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_MODEL（+ OPENAI_COMPAT_API_KEY），
 *   可选 OPENAI_COMPAT_EXTRA_BODY（JSON 对象，合并进每次请求体，例如开启思考的 {"enable_thinking":true}）
 * - anthropic：Claude，ANTHROPIC_API_KEY，可选 ANTHROPIC_MODEL
 * JADE_MAX_TOKENS 是每次回复的输出上限。不设时 Claude 用 64000，其他服务用服务端默认值（有的只有 4096，思考很容易用完）
 * JADE_EFFORT 是思考的力度，见 effortFromEnv
 * 只导入用到的那个服务的包：Anthropic 的 SDK 加载要一百多毫秒，拖慢启动
 */
export async function providerFromEnv(env: Env = process.env): Promise<Provider> {
  const kind = providerKind(env);
  const maxTokens = env.JADE_MAX_TOKENS ? positiveInt("JADE_MAX_TOKENS", env.JADE_MAX_TOKENS) : undefined;
  const effort = effortFromEnv(env);
  if (kind === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for the openai provider");
    const { openaiResponsesProvider } = await import("@uncarved/provider-openai-responses");
    return openaiResponsesProvider({
      baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-5",
      maxTokens,
      reasoning: effort ? { effort: effort as "minimal" | "low" | "medium" | "high" } : undefined,
    });
  }
  if (kind === "openai-compat") {
    if (!env.OPENAI_COMPAT_BASE_URL) throw new Error("OPENAI_COMPAT_BASE_URL is required for the openai-compat provider");
    if (!env.OPENAI_COMPAT_MODEL) throw new Error("OPENAI_COMPAT_MODEL is required when OPENAI_COMPAT_BASE_URL is set");
    const { openaiCompatProvider } = await import("@uncarved/provider-openai-compat");
    return openaiCompatProvider({
      baseURL: env.OPENAI_COMPAT_BASE_URL,
      apiKey: env.OPENAI_COMPAT_API_KEY,
      model: env.OPENAI_COMPAT_MODEL,
      maxTokens,
      extraBody: env.OPENAI_COMPAT_EXTRA_BODY ? jsonObject("OPENAI_COMPAT_EXTRA_BODY", env.OPENAI_COMPAT_EXTRA_BODY) : undefined,
    });
  }
  const { anthropicProvider } = await import("@uncarved/provider-anthropic");
  return anthropicProvider({ model: env.ANTHROPIC_MODEL, effort: (effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max", maxTokens });
}

/** 可以在会话中途换掉的 provider：/model 改配置后，压缩、子 Agent 等持有它的地方都跟着换 */
export interface SwitchableProvider extends Provider {
  set(next: Provider): void;
}

export function switchable(initial: Provider): SwitchableProvider {
  let current = initial;
  return {
    id: "switchable",
    set: (next) => {
      current = next;
    },
    complete: (request, options) => current.complete(request, options),
  };
}

/** 服务提供的模型列表；不支持或出错时返回空数组 */
export async function listModels(env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const kind = providerKind(env);
  const info = providerInfo(env);
  const base = (info.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "x-api-key": env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" }
      : (kind === "openai" ? env.OPENAI_API_KEY : env.OPENAI_COMPAT_API_KEY)
        ? { authorization: `Bearer ${kind === "openai" ? env.OPENAI_API_KEY : env.OPENAI_COMPAT_API_KEY}` }
        : {};
  try {
    const res = await fetchImpl(kind === "anthropic" ? `${base}/v1/models?limit=100` : `${base}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  } catch {
    return [];
  }
}

function positiveInt(name: string, text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(text)}`);
  return n;
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
