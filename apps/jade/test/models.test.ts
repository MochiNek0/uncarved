// 模型服务（plugins/models）：重试、限速和按环境变量选择服务。
// 从旧 jade 的 test/jade.test.ts、test/tools.test.ts、test/tui.test.ts 移植；插件提供的服务、保存的服务已经去掉，相关测试没有移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderError, type Delta, type Provider } from "uncarved";
import { envWithFile, hasProvider, parseEnv, parseTokens } from "../plugins/models/config.ts";
import {
  effortFromEnv,
  isConcurrencyLimit,
  isRateLimit,
  providerFromEnv,
  providerInfo,
  providerKind,
  RateGate,
  RETRY_DELAYS_MS,
  rpmFromEnv,
  visionFromEnv,
  withRetry,
} from "../plugins/models/provider.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

const request = { system: [], messages: [], tools: [] };

// ---------- 重试 ----------

describe("withRetry", () => {
  test("retries retryable errors and reports the inner provider", async () => {
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete() {
        if (++calls === 1) throw new ProviderError("overloaded", { retryable: true, status: 529 });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const res = await withRetry(inner, { delaysMs: [1] }).complete(request, { signal: new AbortController().signal });
    expect(calls).toBe(2);
    expect(res.provider).toBe("inner");
  });

  test("discards streamed deltas of a failed attempt before retrying", async () => {
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete(_req, { onDelta }) {
        onDelta?.({ kind: "text", text: calls === 0 ? "hal" : "whole" });
        if (++calls === 1) throw new ProviderError("dropped", { retryable: true });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const deltas: Delta[] = [];
    await withRetry(inner, { delaysMs: [1] }).complete(request, { signal: new AbortController().signal, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual([{ kind: "text", text: "hal" }, { kind: "reset" }, { kind: "text", text: "whole" }]);
  });

  test("does not retry non-retryable errors", async () => {
    const inner: Provider = {
      id: "inner",
      async complete() {
        throw new ProviderError("bad request", { retryable: false, status: 400 });
      },
    };
    await expect(withRetry(inner, { delaysMs: [1] }).complete(request, { signal: new AbortController().signal })).rejects.toThrow("bad request");
  });

  test("adds jitter to the backoff and treats the server's Retry-After as a lower bound", async () => {
    const delays: number[] = [];
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete() {
        calls++;
        if (calls === 1) throw new ProviderError("overloaded", { retryable: true });
        // 比计划短的 Retry-After（例如并发限流每次都回 1 秒）不缩短退避；比计划长的照它等
        if (calls === 2) throw new ProviderError("rate limited", { retryable: true, retryAfterMs: 7 });
        if (calls === 3) throw new ProviderError("rate limited", { retryable: true, retryAfterMs: 50 });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    await withRetry(inner, { delaysMs: [10, 20, 30], random: () => 0, onRetry: (i) => delays.push(i.delayMs) }).complete(request, {
      signal: new AbortController().signal,
    });
    expect(delays).toEqual([8, 16, 50]);
  });

  test("waits longer each time, up to 9 retries and at most 3 minutes", async () => {
    expect(RETRY_DELAYS_MS.length).toBe(9);
    expect(Math.max(...RETRY_DELAYS_MS)).toBe(180_000);
    expect(RETRY_DELAYS_MS.every((d, i) => i === 0 || d > RETRY_DELAYS_MS[i - 1]!)).toBe(true);
    const delays: number[] = [];
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete() {
        calls++;
        throw new ProviderError("HTTP 429", { retryable: true, status: 429, retryAfterMs: calls === 1 ? 600_000 : undefined });
      },
    };
    const scaled = RETRY_DELAYS_MS.map((d) => d / 10_000);
    await expect(
      withRetry(inner, { delaysMs: scaled, maxDelayMs: 15, random: () => 1, onRetry: (i) => delays.push(i.delayMs) }).complete(request, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("429");
    // 第一次和最后一次都不超过上限；中间按计划递增
    expect(calls).toBe(10);
    expect(delays).toEqual([15, ...scaled.slice(1).map((d) => Math.round(Math.min(d, 15)))]);
  });
});

// ---------- 限速 ----------

test("RateGate spaces requests by the limit and pauses everyone after a 429", async () => {
  let now = 0;
  const waits: number[] = [];
  const learned: number[] = [];
  const gate = new RateGate({ now: () => now, onWait: (ms) => waits.push(ms), onLearn: (n) => learned.push(n) });
  const signal = new AbortController().signal;
  // 没有上限时不等
  for (let i = 0; i < 4; i++) await gate.acquire(signal);
  expect(waits).toEqual([]);
  // 一分钟里发了 4 个后被限流：推出每分钟 3 个，暂停期间谁都不发
  gate.limited(1);
  expect(learned).toEqual([3]);
  expect(gate.rpm).toBe(3);
  now = 60_000;
  await gate.acquire(signal);
  expect(waits).toEqual([]);
  // 下一个要隔 20 秒；排在它后面的被取消时立即返回
  const slow = new AbortController();
  const next = gate.acquire(slow.signal);
  await new Promise((r) => setTimeout(r, 5));
  expect(waits[0]).toBe(20_000);
  const ac = new AbortController();
  const queued = gate.acquire(ac.signal);
  ac.abort(new Error("stop"));
  await expect(queued).rejects.toThrow("stop");
  slow.abort(new Error("slow"));
  await expect(next).rejects.toThrow("slow");
  // 设了 JADE_RPM 时不改
  const fixed = new RateGate({ rpm: 30, now: () => now });
  for (let i = 0; i < 4; i++) {
    await fixed.acquire(signal);
    now += 2_000;
  }
  fixed.limited(1);
  expect(fixed.rpm).toBe(30);
  expect(isRateLimit(new ProviderError("stream error: Rate limit exceeded: free-models-per-min", { retryable: true }))).toBe(true);
  expect(isRateLimit(new ProviderError("HTTP 429: slow down", { retryable: true }))).toBe(true);
  expect(isRateLimit(new ProviderError("HTTP 500: oops (id 14290)", { retryable: true, status: 500 }))).toBe(false);
  // 并发数限流：一起暂停，但不推每分钟的上限
  const busyWaits: number[] = [];
  const busy = new RateGate({ now: () => now, onWait: (ms) => busyWaits.push(ms) });
  for (let i = 0; i < 10; i++) await busy.acquire(signal);
  const concurrency = new ProviderError("HTTP 429: Model is at its concurrency limit (32); please retry later", { retryable: true, status: 429 });
  expect(isConcurrencyLimit(concurrency)).toBe(true);
  busy.limited(5_000, { learn: !isConcurrencyLimit(concurrency) });
  expect(busy.rpm).toBeUndefined();
  const stopBusy = new AbortController();
  const paused = busy.acquire(stopBusy.signal);
  await new Promise((r) => setTimeout(r, 5));
  expect(busyWaits).toEqual([5_000]);
  stopBusy.abort(new Error("done"));
  await expect(paused).rejects.toThrow("done");
  expect(rpmFromEnv({ JADE_RPM: "20" })).toBe(20);
  expect(() => rpmFromEnv({ JADE_RPM: "fast" })).toThrow("JADE_RPM");
});

// ---------- 按环境变量选择服务 ----------

describe("model configuration", () => {
  test("JADE_VISION: on by default for Claude and OpenAI, off for compatible services", () => {
    expect(visionFromEnv({})).toBe(true);
    expect(visionFromEnv({ OPENAI_API_KEY: "k" })).toBe(true);
    expect(visionFromEnv({ OPENAI_COMPAT_BASE_URL: "http://x" })).toBe(false);
    expect(visionFromEnv({ OPENAI_COMPAT_BASE_URL: "http://x", JADE_VISION: "on" })).toBe(true);
    expect(visionFromEnv({ JADE_VISION: "0" })).toBe(false);
    expect(() => visionFromEnv({ JADE_VISION: "maybe" })).toThrow("JADE_VISION");
  });

  test("JADE_PROVIDER overrides the default order", async () => {
    const env = { OPENAI_API_KEY: "k", OPENAI_COMPAT_BASE_URL: "http://x", OPENAI_COMPAT_MODEL: "m" };
    expect(providerKind(env)).toBe("openai");
    expect(providerKind({ ...env, JADE_PROVIDER: "openai-compat" })).toBe("openai-compat");
    expect(providerInfo({ ...env, JADE_PROVIDER: "openai-compat" })).toEqual({ kind: "openai-compat", model: "m", baseURL: "http://x" });
    await expect(providerFromEnv({ JADE_PROVIDER: "gemini" })).rejects.toThrow("JADE_PROVIDER");
    await expect(providerFromEnv({ ...env, JADE_MAX_TOKENS: "lots" })).rejects.toThrow("JADE_MAX_TOKENS");
  });

  test("JADE_EFFORT is checked against the provider", async () => {
    expect(effortFromEnv({ ANTHROPIC_API_KEY: "k", JADE_EFFORT: "max" })).toBe("max");
    expect(effortFromEnv({ OPENAI_API_KEY: "k", JADE_EFFORT: "minimal" })).toBe("minimal");
    expect(effortFromEnv({ ANTHROPIC_API_KEY: "k" })).toBeUndefined();
    expect(() => effortFromEnv({ ANTHROPIC_API_KEY: "k", JADE_EFFORT: "minimal" })).toThrow("JADE_EFFORT must be one of");
    expect(() => effortFromEnv({ OPENAI_COMPAT_BASE_URL: "http://x", JADE_EFFORT: "high" })).toThrow("not supported");
    await expect(providerFromEnv({ OPENAI_API_KEY: "k", JADE_EFFORT: "turbo" })).rejects.toThrow("JADE_EFFORT");
  });

  test("OpenAI asks for a reasoning summary only when JADE_EFFORT is set", async () => {
    const bodies: Record<string, unknown>[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    try {
      for (const env of [{ OPENAI_API_KEY: "k", JADE_EFFORT: "low" }, { OPENAI_API_KEY: "k" }]) {
        const provider = await providerFromEnv(env);
        await provider.complete(request, { signal: new AbortController().signal }).catch(() => {});
      }
    } finally {
      globalThis.fetch = real;
    }
    expect(bodies[0]!.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(bodies[1]).not.toHaveProperty("reasoning");
  });

  test("OPENAI_COMPAT_EXTRA_BODY must be a JSON object", async () => {
    const env = { OPENAI_COMPAT_BASE_URL: "http://x", OPENAI_COMPAT_MODEL: "m" };
    expect((await providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: '{"enable_thinking":true}' })).id).toBe("openai-compat");
    await expect(providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: "enable_thinking" })).rejects.toThrow("must be a JSON object");
    await expect(providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: "[1]" })).rejects.toThrow("must be a JSON object");
  });

  test("token counts accept K and M", () => {
    expect(parseTokens("X", "32000")).toBe(32_000);
    expect(parseTokens("X", "512K")).toBe(512_000);
    expect(parseTokens("X", "1m")).toBe(1_000_000);
    expect(parseTokens("X", "1.5M")).toBe(1_500_000);
    expect(parseTokens("X", "128_000")).toBe(128_000);
    expect(() => parseTokens("X", "lots")).toThrow("X must be");
    expect(() => parseTokens("X", "0")).toThrow("X must be");
    expect(() => parseTokens("X", "1.5")).toThrow("X must be");
  });

  // 旧版本的 loadEnvFile 把文件里的变量写进 env；现在 envWithFile 返回合并后的新对象
  test("the user's .env fills in only variables the shell has not set", async () => {
    expect(parseEnv('# c\nexport A=1\nB = "two words"\nC=x # note\nD=\'$raw\'\nnot a line')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "$raw",
    });
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-home-"));
    tmp.push(home);
    await writeFile(path.join(home, ".env"), "A=file\nB=file\n");
    const env: Record<string, string | undefined> = { A: "shell", U: undefined };
    expect(await envWithFile(path.join(home, ".env"), env)).toEqual({ A: "shell", B: "file" });
    expect(env).toEqual({ A: "shell", U: undefined });
    expect(await envWithFile(path.join(home, "missing"), { A: "shell" })).toEqual({ A: "shell" });
    expect(hasProvider({ OPENAI_COMPAT_BASE_URL: "http://x" })).toBe(true);
    expect(hasProvider({})).toBe(false);
  });
});
