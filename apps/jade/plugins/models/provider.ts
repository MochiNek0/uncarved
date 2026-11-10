// Provider：按环境变量选择，外面包一层重试（4.7：重试是包装 Provider 的事）。

import { ProviderError, type ModelResponse, type Provider } from "uncarved";
import { parseTokens } from "./config.ts";

/** 默认的重试等待：一次比一次久，最长 3 分钟 */
export const RETRY_DELAYS_MS = [2, 5, 10, 20, 30, 45, 60, 120, 180].map((s) => s * 1000);
const MAX_RETRY_DELAY_MS = 180_000;

export interface RetryOptions {
  /** 最多重试几次，默认 RETRY_DELAYS_MS 的长度（9 次） */
  retries?: number;
  /** 第 n 次重试前等多久；次数超过数组长度时用最后一项。上游给的 retryAfterMs 更长时以它为准 */
  delaysMs?: number[];
  /** 任何一次等待的上限，默认 3 分钟 */
  maxDelayMs?: number;
  /** 退避时间的随机数，默认 Math.random；测试用 */
  random?: () => number;
  /** 所有请求共用的限速：每次请求前排队，遇到 429 时一起暂停 */
  gate?: RateGate;
  /** 每次真正发出请求前（排完队、等完重试之后）通知宿主 */
  onRequest?: (attempt: number) => void;
  /** 每次重试前通知宿主（显示用） */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: ProviderError }) => void;
}

/** 是不是被限流了（429，或者错误信息里这么说） */
export const isRateLimit = (err: ProviderError) => err.status === 429 || /\b429\b|rate.?limit|too many requests/i.test(err.message);

/**
 * 是不是同时进行的请求太多（"concurrency limit"），而不是每分钟的请求太多。
 * 这种限流也要一起等，但不能拿来推每分钟的上限：等前面的请求结束就好了，推出来的上限只会让之后一直变慢
 */
export const isConcurrencyLimit = (err: ProviderError) => /concurren/i.test(err.message);

/** 重试过的请求里每次失败的记录 */
export interface RetryRecord {
  attempt: number;
  delayMs: number;
  error: string;
  status?: number;
  /** 失败前已经输出了一部分（界面上标了作废） */
  discarded?: true;
}

/**
 * withRetry 的回复：重试过时带上失败的记录。核心写日志时只取回复的 content、stopReason、usage，
 * 这一项进不了上下文；jade/models 在 model.after 里把它写成插件事件
 */
export type RetriedResponse = ModelResponse & { retries?: RetryRecord[] };

export function withRetry(inner: Provider, opts: RetryOptions = {}): Provider {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const retries = opts.retries ?? delays.length;
  const max = opts.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  const random = opts.random ?? Math.random;
  return {
    id: `retry(${inner.id})`,
    async complete(request, options): Promise<RetriedResponse> {
      const failures: RetryRecord[] = [];
      for (let attempt = 1; ; attempt++) {
        let streamed = false;
        await opts.gate?.acquire(options.signal);
        opts.onRequest?.(attempt);
        try {
          const res = await inner.complete(request, {
            ...options,
            onDelta: (d) => {
              streamed = true;
              options.onDelta?.(d);
            },
          });
          // 实际回复的是被包装者（4.7 第 3 款）
          return { ...res, provider: res.provider ?? inner.id, ...(failures.length > 0 ? { retries: failures } : {}) };
        } catch (err) {
          if (!(err instanceof ProviderError) || !err.retryable || attempt > retries || options.signal.aborted) throw err;
          // 在计划的时间上随机缩短最多 20%，并行的子 Agent 同时遇到 429 时不会同时重试。
          // 上游给的 retryAfterMs 只当下限：有的服务（尤其是并发数限流）每次都回 Retry-After: 1，
          // 拿它代替退避计划会每秒撞一次，十几秒就把重试次数用完
          const planned = delays[Math.min(attempt, delays.length) - 1] ?? 1000;
          const delayMs = Math.round(Math.min(Math.max(err.retryAfterMs ?? 0, planned * (0.8 + 0.2 * random())), max));
          // 限流时所有共用这个 gate 的请求（子 Agent、压缩）一起等，不再各自去撞
          if (isRateLimit(err)) opts.gate?.limited(delayMs, { learn: !isConcurrencyLimit(err) });
          // 失败的这次已经推送过增量的，先让订阅者作废它们（4.7）
          if (streamed) options.onDelta?.({ kind: "reset" });
          failures.push({ attempt, delayMs, error: err.message, ...(err.status !== undefined ? { status: err.status } : {}), ...(streamed ? { discarded: true as const } : {}) });
          opts.onRetry?.({ attempt, retries, delayMs, error: err });
          await sleep(delayMs, options.signal);
        }
      }
    },
  };
}

export interface RateGateOptions {
  /** 每分钟最多发几个请求（JADE_RPM）；不设时不主动限速，被限流后按当时的请求数推一个 */
  rpm?: number;
  now?: () => number;
  /** 要等一段时间才能发下一个请求时通知宿主（显示用） */
  onWait?: (ms: number) => void;
  /** 被限流后推出了每分钟的请求数上限时通知宿主 */
  onLearn?: (rpm: number) => void;
}

/**
 * 同一个服务的所有请求共用的限速。免费模型常常按每分钟请求数限流，主 Agent、并行的子 Agent、压缩各自重试会一起撞上去。
 * - 有上限（JADE_RPM，或者被限流后推出来的）时，相邻两个请求至少间隔 60s / 上限，平均分布在一分钟里
 * - 收到 429 后，所有请求都等到重试时间之后再发
 */
export class RateGate {
  #rpm: number | undefined;
  readonly #explicit: boolean;
  #sent: number[] = [];
  #until = 0;
  #queue: Promise<void> = Promise.resolve();
  readonly #now: () => number;
  readonly #opts: RateGateOptions;

  constructor(opts: RateGateOptions = {}) {
    this.#opts = opts;
    this.#rpm = opts.rpm;
    this.#explicit = opts.rpm !== undefined;
    this.#now = opts.now ?? Date.now;
  }

  /** 当前的每分钟请求数上限；undefined 表示不限 */
  get rpm(): number | undefined {
    return this.#rpm;
  }

  /** 等到可以发下一个请求，并记下这个请求。排队的请求按先来后到 */
  acquire(signal: AbortSignal): Promise<void> {
    const turn = this.#queue.then(async () => {
      signal.throwIfAborted();
      for (let wait = this.#delay(); wait > 0; wait = this.#delay()) {
        this.#opts.onWait?.(wait);
        await sleep(wait, signal);
      }
      this.#sent.push(this.#now());
    });
    this.#queue = turn.catch(() => {});
    // 排队时被取消的也要立即返回（I-9）；轮到它时看到已取消，不会记成发出了请求
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  /**
   * 被限流了：ms 内不再发请求。没设上限时，按最近一分钟发出的请求数推一个上限（比它少一个）；
   * 一分钟里只发了一两个请求就被限流，多半是服务端繁忙，不是请求太多，不推；learn 为 false（并发数限流）时也不推
   */
  limited(ms: number, { learn = true }: { learn?: boolean } = {}) {
    const now = this.#now();
    this.#until = Math.max(this.#until, now + ms);
    if (this.#explicit || !learn) return;
    const recent = this.#recent(now);
    if (recent < 3) return;
    const next = recent - 1;
    if (this.#rpm === undefined || next < this.#rpm) {
      this.#rpm = next;
      this.#opts.onLearn?.(next);
    }
  }

  #recent(now: number): number {
    this.#sent = this.#sent.filter((t) => now - t < 60_000);
    return this.#sent.length;
  }

  #delay(): number {
    const now = this.#now();
    this.#recent(now);
    let wait = this.#until - now;
    const last = this.#sent.at(-1);
    if (this.#rpm !== undefined && last !== undefined) wait = Math.max(wait, last + 60_000 / this.#rpm - now);
    return Math.ceil(wait);
  }
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

export const isBuiltinKind = (kind: string): kind is ProviderKind => (PROVIDER_KINDS as readonly string[]).includes(kind);

/** 每种内置服务的模型名、密钥、地址各放在哪个环境变量里 */
export const MODEL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_MODEL", openai: "OPENAI_MODEL", anthropic: "ANTHROPIC_MODEL" };
export const KEY_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
export const URL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_BASE_URL", openai: "OPENAI_BASE_URL", anthropic: "ANTHROPIC_BASE_URL" };

/** JADE_EFFORT 可取的值；openai-compat 没有统一的字段，用 OPENAI_COMPAT_EXTRA_BODY 自己设 */
export const EFFORTS: Record<ProviderKind, readonly string[] | undefined> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["minimal", "low", "medium", "high"],
  "openai-compat": undefined,
};

/** JADE_RPM：每分钟最多发几个模型请求（免费模型常按这个限流）；不设时不主动限速 */
export function rpmFromEnv(env: Env = process.env): number | undefined {
  const text = env.JADE_RPM?.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`JADE_RPM must be a positive number of requests per minute, got ${JSON.stringify(text)}`);
  return n;
}

/**
 * JADE_IDLE_TIMEOUT：多少秒没收到模型服务的任何数据（等响应头、流中两段数据之间）就中断并重试；0 表示不限。
 * 不设时用 provider 的默认值（90 秒）。只对 OpenAI 和 OpenAI 兼容服务生效，Claude 由 SDK 自己处理超时
 */
export function idleTimeoutFromEnv(env: Env = process.env): number | undefined {
  const text = env.JADE_IDLE_TIMEOUT?.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`JADE_IDLE_TIMEOUT must be a number of seconds (0 for no limit), got ${JSON.stringify(text)}`);
  return Math.round(n * 1000);
}

/**
 * JADE_VISION：模型能不能看图片（工具读到的图片、截图）。不设时 Claude 和 OpenAI 算能看；
 * OpenAI 兼容服务的模型五花八门，算不能看：不支持图片的模型收到图片会拒绝整个请求，而图片会一直留在历史里
 */
export function visionFromEnv(env: Env = process.env): boolean {
  const text = env.JADE_VISION?.trim().toLowerCase();
  if (!text) return providerKind(env) === "openai" || providerKind(env) === "anthropic";
  if (["1", "true", "on", "yes"].includes(text)) return true;
  if (["0", "false", "off", "no"].includes(text)) return false;
  throw new Error(`JADE_VISION must be on or off, got ${JSON.stringify(env.JADE_VISION)}`);
}

/** JADE_EFFORT；不设时 Claude 用 high，OpenAI 用服务端默认值 */
export function effortFromEnv(env: Env = process.env): string | undefined {
  const effort = env.JADE_EFFORT;
  if (!effort) return undefined;
  const kind = providerKind(env);
  if (!isBuiltinKind(kind)) return effort;
  const allowed = EFFORTS[kind];
  if (!allowed) throw new Error(`JADE_EFFORT is not supported for the ${kind} provider; set it in OPENAI_COMPAT_EXTRA_BODY instead`);
  if (!allowed.includes(effort)) throw new Error(`JADE_EFFORT must be one of ${allowed.join(", ")} for the ${kind} provider, got ${JSON.stringify(effort)}`);
  return effort;
}

/** JADE_PROVIDER 指定时用它；否则按 OPENAI_API_KEY、OPENAI_COMPAT_BASE_URL、ANTHROPIC_API_KEY 的顺序。不认识的名字原样返回，创建时报错 */
export function providerKind(env: Env = process.env): string {
  const named = env.JADE_PROVIDER;
  if (named) return named;
  if (env.OPENAI_API_KEY) return "openai";
  if (env.OPENAI_COMPAT_BASE_URL) return "openai-compat";
  return "anthropic";
}

export interface ProviderInfo {
  kind: string;
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
 * JADE_RPM 是每分钟最多发几个请求，见 rpmFromEnv（限速在 withRetry 的 gate 里做）
 * JADE_IDLE_TIMEOUT 是等模型服务回数据的时限，见 idleTimeoutFromEnv
 * JADE_VISION 是模型能不能看图片，见 visionFromEnv
 * 只导入用到的那个服务的包：Anthropic 的 SDK 加载要一百多毫秒，拖慢启动
 */
export async function providerFromEnv(env: Env = process.env): Promise<Provider> {
  const kind = providerKind(env);
  if (!isBuiltinKind(kind)) throw new Error(`JADE_PROVIDER must be one of ${PROVIDER_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
  const maxTokens = env.JADE_MAX_TOKENS ? parseTokens("JADE_MAX_TOKENS", env.JADE_MAX_TOKENS) : undefined;
  const effort = effortFromEnv(env);
  // 写错时在这里就报错，不等到第一次请求
  rpmFromEnv(env);
  const idleTimeoutMs = idleTimeoutFromEnv(env);
  const toolResultImages = visionFromEnv(env);
  if (kind === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for the openai provider");
    const { openaiResponsesProvider } = await import("@uncarved/provider-openai-responses");
    return openaiResponsesProvider({
      baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-5",
      maxTokens,
      // 设了思考力度说明是会思考的模型，顺带要思考摘要，否则服务端只思考不返回内容。
      // 没设时不发 reasoning：不知道模型会不会思考，发给不支持的模型会被拒绝
      reasoning: effort ? { effort: effort as "minimal" | "low" | "medium" | "high", summary: "auto" } : undefined,
      idleTimeoutMs,
      toolResultImages,
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
      idleTimeoutMs,
      toolResultImages,
    });
  }
  const { anthropicProvider } = await import("@uncarved/provider-anthropic");
  // 地址和密钥从 env 取，不让 SDK 自己读 process.env：ctx.complete 指定的保存过的模型，env 不是 process.env
  return anthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    model: env.ANTHROPIC_MODEL,
    effort: (effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
    maxTokens,
  });
}

/** 服务提供的模型列表；不支持或出错时返回空数组 */
export async function listModels(env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const kind = providerKind(env);
  if (!isBuiltinKind(kind)) return [];
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

export function jsonObject(name: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} must be a JSON object, got ${JSON.stringify(text)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be a JSON object, got ${text}`);
  return value as Record<string, unknown>;
}
