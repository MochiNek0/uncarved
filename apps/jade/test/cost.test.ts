// jade/cost：按配置的单价把用量换算成钱。

import { afterEach, describe, expect, test } from "bun:test";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { costOf, money, parsePrices, priceOf } from "../plugins/cost/index.ts";
import { cleanup, say, scriptedHost } from "./scripted-ui.ts";

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
