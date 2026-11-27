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
  fallbacksFromEnv,
  thinkingFromEnv,
  withRetry,
  type RetriedResponse,
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

  test("tells the caller when the request waits (queue, retry) and when it is actually sent", async () => {
    let calls = 0;
    const seen: string[] = [];
    const inner: Provider = {
      id: "inner",
      async complete() {
        seen.push("inner");
        if (++calls === 1) throw new ProviderError("HTTP 429", { retryable: true, status: 429 });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const options = { signal: new AbortController().signal, onWait: () => seen.push("wait"), onSend: () => seen.push("send") };
    await withRetry(inner, { delaysMs: [1], gate: new RateGate() }).complete(request, options);
    expect(seen).toEqual(["wait", "send", "inner", "wait", "wait", "send", "inner"]);
  });

  test("a response after retries carries the failed attempts; a first-try response carries none", async () => {
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete(_req, { onDelta }) {
        calls++;
        if (calls === 1) throw new ProviderError("HTTP 503", { retryable: true, status: 503 });
        if (calls === 2) {
          onDelta?.({ kind: "text", text: "hal" });
          throw new ProviderError("stream failed", { retryable: true });
        }
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const p = withRetry(inner, { delaysMs: [1, 2], random: () => 1 });
    const res = (await p.complete(request, { signal: new AbortController().signal })) as RetriedResponse;
    expect(res.retries).toEqual([
      { attempt: 1, delayMs: 1, error: "HTTP 503", status: 503 },
      { attempt: 2, delayMs: 2, error: "stream failed", discarded: true },
    ]);
    const again = (await p.complete(request, { signal: new AbortController().signal })) as RetriedResponse;
    expect(again.retries).toBeUndefined();
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
    ).rejects.toThrow("HTTP 429 (after 9 retries, 0s of waiting)");
    // 第一次和最后一次都不超过上限；中间按计划递增
    expect(calls).toBe(10);
    expect(delays).toEqual([15, ...scaled.slice(1).map((d) => Math.round(Math.min(d, 15)))]);
  });

  test("tells the caller how long its own request waits in the rate limit queue", async () => {
    const inner: Provider = { id: "inner", complete: async () => ({ model: "m", content: [], stopReason: "end" }) };
    const gate = new RateGate();
    gate.limited(30);
    const waits: { delayMs: number; request: unknown }[] = [];
    await withRetry(inner, { gate, onWait: (w) => waits.push(w) }).complete(request, { signal: new AbortController().signal });
    expect(waits).toHaveLength(1);
    expect(waits[0]!.delayMs).toBeGreaterThan(0);
    expect(waits[0]!.request).toBe(request);
  });
});

// ---------- 限速 ----------

test("RateGate keeps at most the limit in any minute, counted from when requests end, and pauses everyone after a 429", async () => {
  let now = 0;
  const waits: number[] = [];
  const learned: number[] = [];
  const gate = new RateGate({ now: () => now, onWait: (ms) => waits.push(ms), onLearn: (n) => learned.push(n) });
  const signal = new AbortController().signal;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  // 没有上限时不等
  for (let i = 0; i < 4; i++) (await gate.acquire(signal))();
  expect(waits).toEqual([]);
  // 一分钟里发了 4 个后被限流：推出每分钟 3 个，暂停期间谁都不发
  gate.limited(1);
  expect(learned).toEqual([3]);
  expect(gate.rpm).toBe(3);
  // 窗口空了：3 个接连发出，不用等；每个用 10 秒
  now = 61_000;
  for (let i = 0; i < 3; i++) {
    const done = await gate.acquire(signal);
    now += 10_000;
    done();
  }
  expect(waits).toEqual([]);
  // 第 4 个等最早那个结束（71s）满一分钟再加余量，而不是从发出时算平均间隔（那样正好卡在服务端窗口的边上）
  const slow = new AbortController();
  const next = gate.acquire(slow.signal);
  await tick();
  expect(waits).toEqual([71_000 + 61_000 - now]);
  // 排在它后面的被取消时立即返回
  const ac = new AbortController();
  const queued = gate.acquire(ac.signal);
  ac.abort(new Error("stop"));
  await expect(queued).rejects.toThrow("stop");
  slow.abort(new Error("slow"));
  await expect(next).rejects.toThrow("slow");
  // 还没结束的请求占着窗口：等它结束，再从结束时算
  const single = new RateGate({ rpm: 1, now: () => now, onWait: (ms) => waits.push(ms) });
  waits.length = 0;
  const first = await single.acquire(signal);
  const stopSecond = new AbortController();
  const second = single.acquire(stopSecond.signal);
  await tick();
  expect(waits).toEqual([]);
  first();
  await tick();
  expect(waits).toEqual([61_000]);
  stopSecond.abort(new Error("second"));
  await expect(second).rejects.toThrow("second");
  // 设了 JADE_RPM 时也按请求数降下来
  const fixed = new RateGate({ rpm: 30, now: () => now });
  for (let i = 0; i < 4; i++) {
    (await fixed.acquire(signal))();
    now += 2_000;
  }
  fixed.limited(1);
  expect(fixed.rpm).toBe(3);
  expect(isRateLimit(new ProviderError("stream error: Rate limit exceeded: free-models-per-min", { retryable: true }))).toBe(true);
  expect(isRateLimit(new ProviderError("HTTP 429: slow down", { retryable: true }))).toBe(true);
  expect(isRateLimit(new ProviderError("HTTP 500: oops (id 14290)", { retryable: true, status: 500 }))).toBe(false);
  // 并发数限流：一起暂停，但不推每分钟的上限
  const busyWaits: number[] = [];
  const busy = new RateGate({ now: () => now, onWait: (ms) => busyWaits.push(ms) });
  for (let i = 0; i < 10; i++) (await busy.acquire(signal))();
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

test("RateGate raises a lowered limit by one after that many requests fill the window without a 429, up to JADE_RPM", async () => {
  let now = 0;
  const signal = new AbortController().signal;
  // 每个请求立即结束；窗口满了就把时钟拨到最早那个出窗口，不真的等
  const send = async (gate: RateGate, ends: number[], n: number, gap = 1_000) => {
    for (let i = 0; i < n; i++) {
      for (let live = ends.filter((at) => now - at < 61_000); gate.rpm !== undefined && live.length >= gate.rpm; live = ends.filter((at) => now - at < 61_000)) {
        now = live[0]! + 61_000;
      }
      (await gate.acquire(signal))();
      ends.push(now);
      now += gap;
    }
  };
  const gate = new RateGate({ now: () => now });
  const ends: number[] = [];
  await send(gate, ends, 5);
  gate.limited(1);
  expect(gate.rpm).toBe(4);
  // 每个都把窗口发满：4 个后上限 5，再 5 个后 6
  await send(gate, ends, 3);
  expect(gate.rpm).toBe(4);
  await send(gate, ends, 1);
  expect(gate.rpm).toBe(5);
  await send(gate, ends, 5);
  expect(gate.rpm).toBe(6);
  // 发得稀（窗口不满）不算，上限不会比实际用量高出去
  await send(gate, ends, 20, 20_000);
  expect(gate.rpm).toBe(6);
  // 再被限流：攒的数清零，按窗口里的请求数重新推
  now += 120_000;
  await send(gate, ends, 3);
  gate.limited(1);
  expect(gate.rpm).toBe(2);
  // 设了 JADE_RPM：降下来后最多回到它
  const capped = new RateGate({ rpm: 4, now: () => now });
  const cappedEnds: number[] = [];
  await send(capped, cappedEnds, 4);
  capped.limited(1);
  expect(capped.rpm).toBe(3);
  await send(capped, cappedEnds, 30);
  expect(capped.rpm).toBe(4);
});

// ---------- 按环境变量选择服务 ----------

describe("model configuration", () => {
  test("JADE_FALLBACKS: on by default only for the official API", () => {
    expect(fallbacksFromEnv({})).toBe(true);
    expect(fallbacksFromEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(true);
    expect(fallbacksFromEnv({ ANTHROPIC_BASE_URL: "https://relay.example" })).toBe(false);
    expect(fallbacksFromEnv({ ANTHROPIC_BASE_URL: "https://relay.example", JADE_FALLBACKS: " ON " })).toBe(true);
    expect(fallbacksFromEnv({ JADE_FALLBACKS: "off" })).toBe(false);
    expect(() => fallbacksFromEnv({ JADE_FALLBACKS: "maybe" })).toThrow("JADE_FALLBACKS");
  });

  test("JADE_THINKING: on by default, off leaves thinking out of the request", () => {
    expect(thinkingFromEnv({})).toBe(true);
    expect(thinkingFromEnv({ JADE_THINKING: " OFF " })).toBe(false);
    expect(thinkingFromEnv({ JADE_THINKING: "on" })).toBe(true);
    expect(() => thinkingFromEnv({ JADE_THINKING: "maybe" })).toThrow("JADE_THINKING");
  });

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

test("providerFromEnv sends the given User-Agent to every built-in service, replacing the SDK's own", async () => {
  const seen: Record<string, string | null> = {};
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen[new URL(req.url).pathname] = req.headers.get("user-agent");
      return new Response("no", { status: 400 });
    },
  });
  try {
    const base = `http://localhost:${server.port}`;
    const req = { system: [], messages: [{ role: "user", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }] }], tools: [] } as never;
    for (const env of [
      { ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: "m" },
      { OPENAI_COMPAT_BASE_URL: `${base}/compat`, OPENAI_COMPAT_MODEL: "m", OPENAI_COMPAT_API_KEY: "x" },
      { JADE_PROVIDER: "openai", OPENAI_API_KEY: "x", OPENAI_BASE_URL: `${base}/oai` },
    ]) {
      const p = await providerFromEnv(env, { "user-agent": "jade/9.9.9" });
      await p.complete(req, { signal: AbortSignal.timeout(5000), onDelta: () => {} }).catch(() => {});
    }
    expect(seen).toEqual({ "/v1/messages": "jade/9.9.9", "/compat/chat/completions": "jade/9.9.9", "/oai/responses": "jade/9.9.9" });
  } finally {
    server.stop(true);
  }
});
