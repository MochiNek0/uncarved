// jade/cost：按配置的单价把用量换算成钱。

import { afterEach, describe, expect, test } from "bun:test";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, LogEvent, Message, ModelRequest } from "uncarved";
import { cacheReport, prefixWatcher } from "../plugins/cost/cache.ts";
import { costOf, money, parsePrices, priceOf } from "../plugins/cost/index.ts";
import { cleanup, say, scriptedHost, use } from "./scripted-ui.ts";

afterEach(cleanup);

describe("jade/cost", () => {
  test("prices: bad entries are dropped, the longest prefix wins, cached input has its own price", () => {
    const prices = parsePrices({ claude: { input: 3, output: 15 }, "claude-opus": { input: 15, output: 75, cacheRead: 1.5 }, broken: { input: "x" } });
    expect(Object.keys(prices)).toEqual(["claude", "claude-opus"]);
    expect(priceOf(prices, "claude-opus-5-5")!.input).toBe(15);
    expect(priceOf(prices, "claude-haiku")!.input).toBe(3);
    expect(priceOf(prices, "gpt-x")).toBeUndefined();
    // 100 万输入里 40 万命中缓存、10 万写入缓存（没有单价，按输入算）；10 万输出
    const u = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 };
    expect(costOf(u, prices["claude-opus"]!)).toBeCloseTo(0.5 * 15 + 0.4 * 1.5 + 0.1 * 15 + 0.1 * 75, 6);
  });

  test("/cost adds up the session's usage per model; the running total is kept in the log", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/cost": { prices: { s1: { input: 10, output: 20 } } } } });
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const cost = () => host.service<Commands>("commands@1")!.get("cost")!.command.run("", c);
    const s = await host.sessions.open();
    expect(await cost()).toBe("No model usage in this session yet.");
    shared.script.push(say("one", { inputTokens: 100_000, outputTokens: 10_000 }), say("two", { inputTokens: 200_000, outputTokens: 20_000 }));
    await send(s, "first");
    await send(s, "second");
    // 30 万输入 × $10 + 3 万输出 × $20，每百万
    expect(await cost()).toBe("s1: 300.0k in, 30.0k out · $3.60\nTotal: $3.60");
    expect(s.state.derived["jade/cost/spent"]).toEqual({ USD: expect.closeTo(3.6, 6) });
  });

  test("a price set on the model wins over the configured one and is taken at the time of each reply", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/cost": { prices: { s1: { input: 10, output: 20 } } } } });
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const cost = () => host.service<Commands>("commands@1")!.get("cost")!.command.run("", c);
    // 第一个回复按 ¥2/¥8，之后的按 ¥1/¥4（例如进了低谷时段）
    const times: Date[] = [];
    shared.price = (_model, at) => {
      times.push(at);
      return times.length <= 1 ? { input: 2, output: 8, currency: "CNY" } : { input: 1, output: 4, currency: "CNY" };
    };
    const s = await host.sessions.open();
    shared.script.push(say("one", { inputTokens: 1_000_000, outputTokens: 0 }), say("two", { inputTokens: 1_000_000, outputTokens: 0 }));
    await send(s, "first");
    await send(s, "second");
    expect(s.state.derived["jade/cost/spent"]).toEqual({ CNY: 3 });
    // /cost 从日志重算，按每个事件自己的时间取单价
    times.length = 0;
    expect(await cost()).toEndWith("Total: ¥3.00");
    expect(times.every((t) => t instanceof Date && !Number.isNaN(t.getTime()))).toBe(true);
  });

  test("different currencies are added up separately", () => {
    expect(money({ USD: 0.12, CNY: 0.8 })).toBe("$0.12 + ¥0.80");
    expect(money({ EUR: 1 })).toBe("1.00 EUR");
    expect(parsePrices({ deepseek: { input: 2, output: 8, currency: "cny" } }).deepseek).toEqual({ input: 2, output: 8, currency: "CNY" });
  });

  test("without a price /cost shows tokens and says how to configure one", async () => {
    const { host, shared, send } = await scriptedHost();
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const s = await host.sessions.open();
    shared.script.push(say("one", { inputTokens: 1500, outputTokens: 10 }));
    await send(s, "first");
    const out = String(await host.service<Commands>("commands@1")!.get("cost")!.command.run("", c));
    expect(out).toStartWith("s1: 1.5k in, 10 out\nNo price is set for these models: set one in /model");
  });
});

describe("jade/cost prompt cache", () => {
  const blk = (text: string, trust: "trusted" | "untrusted" = "trusted"): Block => ({ kind: "text", text, origin: { by: "user" }, trust });
  const req = (system: string, messages: Message[], tools: ModelRequest["tools"] = []): ModelRequest => ({
    system: [{ text: system, stability: "stable", origin: { by: "plugin", id: "t" }, trust: "trusted" }],
    messages,
    tools,
  });

  test("a request that only appends to the previous one keeps the prefix; any earlier change is reported where it starts", () => {
    const watch = prefixWatcher();
    const a: Message = { role: "user", content: [blk("a")] };
    const b: Message = { role: "assistant", content: [blk("b")] };
    expect(watch(req("s", [a]))).toBeUndefined();
    expect(watch(req("s", [a, b, { role: "user", content: [blk("c")] }]))).toBeUndefined();
    // 往最后一条消息里追加块、只改了不发给模型的 trust：都算沿用
    expect(watch(req("s", [a, b, { role: "user", content: [blk("c"), blk("d")] }]))).toBeUndefined();
    expect(watch(req("s", [{ role: "user", content: [blk("a", "untrusted")] }, b, { role: "user", content: [blk("c"), blk("d")] }]))).toBeUndefined();
    expect(watch(req("s", [a, { role: "assistant", content: [blk("B")] }]))).toEqual({ part: "messages", message: 1 });
    expect(watch(req("s2", [a]))).toEqual({ part: "system" });
    expect(watch(req("s2", [a], [{ name: "x", description: "", inputSchema: {} }]))).toEqual({ part: "tools" });
  });

  test("/cost tells cache misses jade caused from those where the prefix did not change", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 26, 0, min)).toISOString();
    const responded = (min: number, input: number, read: number) =>
      ({ type: "model.responded", at: at(min), origin: { by: "model", provider: "p", model: "m" }, data: { content: [], usage: { inputTokens: input, cacheReadTokens: read } } }) as unknown as LogEvent;
    const ev = (type: string, data: unknown = {}) => ({ type, at: at(0), origin: { by: "runtime" }, data }) as unknown as LogEvent;
    const history = [
      responded(0, 10_000, 0),
      responded(1, 20_000, 10_000),
      // 压缩之后整段重写：算 jade 的
      ev("jade/compact/trimmed"),
      ev("jade/cost/prefix", { part: "messages", message: 2 }),
      ev("model.requested"),
      responded(2, 15_000, 0),
      // 前缀没变却没命中
      responded(3, 25_000, 0),
      // 隔了 10 分钟
      responded(13, 30_000, 0),
      ev("jade/cost/prefix", { part: "system" }),
      responded(14, 31_000, 0),
    ];
    expect(cacheReport(history, "jade/cost/prefix")).toEqual([
      "Prompt cache: 8% of input read from cache",
      "Prefix changed by jade: compaction ×1, system prompt ×1",
      "Cache missed with the prefix unchanged: 2× (~40k tokens, 1 after more than 5 minutes idle)",
    ]);
    // 从来没报告过命中的：不显示
    expect(cacheReport([responded(0, 10_000, 0), responded(1, 20_000, 0)], "jade/cost/prefix")).toEqual([]);
  });

  test("clearing old tool output shows up in /cost as a prefix change made by compaction", async () => {
    const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/compact": { thresholdTokens: 12_000 } } });
    await writeFile(path.join(cwd, "big.txt"), Array.from({ length: 800 }, () => "a".repeat(40)).join("\n"));
    shared.script.push(use("u1", "read_file", { path: "big.txt" }), say("read", { inputTokens: 15_000, outputTokens: 10, cacheReadTokens: 5000 }), say("ok"));
    const s = await host.sessions.open();
    await send(s, "read it");
    await send(s, "next");
    const prefix = (await s.history()).filter((e) => e.type === "jade/cost/prefix").map((e) => e.data);
    expect(prefix).toEqual([{ part: "messages", message: 2 }]);
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    expect(String(await host.service<Commands>("commands@1")!.get("cost")!.command.run("", c))).toContain("Prefix changed by jade: compaction ×1");
  });
});
