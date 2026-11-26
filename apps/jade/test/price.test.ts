// jade/models 的单价（plugins/models/price.ts）：基础价、按时间的规则、在 /model 里输入的写法。

import { describe, expect, test } from "bun:test";
import { formatRates, formatWhen, parseRates, parseRulePrices, parseWhen, priceAt, readPrice, ruleMatches, type ModelPrice } from "../plugins/models/price.ts";

/** UTC+8 的当地时间 */
const cst = (s: string) => new Date(`${s}+08:00`);

describe("price rules", () => {
  // 例如 DeepSeek 的夜间优惠：北京时间 00:30-08:30 半价
  const offPeak: ModelPrice = { currency: "CNY", input: 2, output: 8, cacheRead: 0.5, rules: [{ times: [{ from: "00:30", to: "08:30" }], tz: "UTC+8", scale: 0.5 }] };

  test("the base price applies outside every rule, a share of it inside one", () => {
    expect(priceAt(offPeak, cst("2026-11-26T12:00:00"))).toEqual({ currency: "CNY", input: 2, output: 8, cacheRead: 0.5 });
    // 打折时缓存写没有单价：按输入价打折
    expect(priceAt(offPeak, cst("2026-11-26T03:00:00"))).toEqual({ currency: "CNY", input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1 });
    // from 算在内，to 不算
    expect(priceAt(offPeak, cst("2026-11-26T00:30:00")).input).toBe(1);
    expect(priceAt(offPeak, cst("2026-11-26T08:30:00")).input).toBe(2);
  });

  test("the first matching rule wins; a rule with its own prices keeps the base for the ones it leaves out", () => {
    const p: ModelPrice = { currency: "USD", input: 3, output: 15, rules: [{ days: [0, 6], tz: "UTC+8", output: 10 }, { tz: "UTC+8", times: [{ from: "00:00", to: "12:00" }], scale: 0.1 }] };
    // 2026-11-28 是周六：第一条
    expect(priceAt(p, cst("2026-11-28T06:00:00"))).toEqual({ currency: "USD", input: 3, output: 10 });
    // 周四上午：第二条
    expect(priceAt(p, cst("2026-11-26T06:00:00")).input).toBeCloseTo(0.3, 9);
  });

  test("a time range across midnight counts the day it started", () => {
    const rule = parseWhen("fri 22:00-06:00 UTC+8");
    // 周五 23 点、周六 5 点（周五晚上开始的那段）算；周五 5 点（周四晚上开始的）不算
    expect(ruleMatches(rule, cst("2026-11-27T23:00:00"))).toBe(true);
    expect(ruleMatches(rule, cst("2026-11-28T05:00:00"))).toBe(true);
    expect(ruleMatches(rule, cst("2026-11-27T05:00:00"))).toBe(false);
    expect(ruleMatches(rule, cst("2026-11-27T12:00:00"))).toBe(false);
  });

  test("a rule can have several time ranges: working hours on weekdays", () => {
    const rule = parseWhen("mon-fri 09:00-12:00 14:00-18:00 UTC+8");
    expect(rule).toEqual({ days: [1, 2, 3, 4, 5], times: [{ from: "09:00", to: "12:00" }, { from: "14:00", to: "18:00" }], tz: "UTC+8" });
    // 逗号连着写是一样的
    expect(parseWhen("mon-fri 09:00-12:00,14:00-18:00 UTC+8")).toEqual(rule);
    expect(formatWhen(rule)).toBe("mon-fri 09:00-12:00,14:00-18:00 UTC+8");
    const p: ModelPrice = { currency: "CNY", input: 1, output: 4, rules: [{ ...rule, ...parseRulePrices("2 8 0.04") }] };
    // 2026-11-26 是周四
    expect(priceAt(p, cst("2026-11-26T10:00:00"))).toEqual({ currency: "CNY", input: 2, output: 8, cacheRead: 0.04 });
    expect(priceAt(p, cst("2026-11-26T15:00:00")).input).toBe(2);
    expect(priceAt(p, cst("2026-11-26T13:00:00")).input).toBe(1);
    expect(priceAt(p, cst("2026-11-26T18:00:00")).input).toBe(1);
    // 周六
    expect(priceAt(p, cst("2026-11-28T10:00:00")).input).toBe(1);
  });

  test("models.json written with a single from/to on the rule still reads", () => {
    expect(readPrice({ input: 1, output: 2, rules: [{ from: "22:00", to: "06:00", scale: 0.5 }] })!.rules).toEqual([{ times: [{ from: "22:00", to: "06:00" }], scale: 0.5 }]);
  });

  test("dates limit a rule to a promotion, both ends included", () => {
    const rule = parseWhen("2026-12-01..2026-12-31 UTC+8");
    expect(ruleMatches(rule, cst("2026-11-30T23:59:00"))).toBe(false);
    expect(ruleMatches(rule, cst("2026-12-01T00:00:00"))).toBe(true);
    expect(ruleMatches(rule, cst("2026-12-31T23:59:00"))).toBe(true);
    expect(ruleMatches(rule, cst("2027-01-01T00:00:00"))).toBe(false);
  });

  test("named time zones follow daylight saving time", () => {
    const rule = parseWhen("09:00-17:00 America/New_York");
    // 1 月是 UTC-5，7 月是 UTC-4
    expect(ruleMatches(rule, new Date("2026-01-15T14:30:00Z"))).toBe(true);
    expect(ruleMatches(rule, new Date("2026-01-15T13:30:00Z"))).toBe(false);
    expect(ruleMatches(rule, new Date("2026-07-15T13:30:00Z"))).toBe(true);
  });

  test("models.json: a broken price is dropped, broken rules are skipped", () => {
    expect(readPrice({ input: "x", output: 1 })).toBeUndefined();
    expect(readPrice({ input: 1, output: 2, currency: "JPY", rules: [{ from: "25:00", scale: 0.9 }, { days: [9], scale: 0.5 }, "x"] })).toEqual({
      currency: "USD",
      input: 1,
      output: 2,
      rules: [{ scale: 0.9 }, { scale: 0.5 }],
    });
  });
});

describe("typing prices in /model", () => {
  test("base prices: input output [cache read] [cache write]", () => {
    expect(parseRates("3 15 0.3 3.75", false)).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(parseRates("¥2, ¥8", false)).toEqual({ input: 2, output: 8 });
    expect(() => parseRates("3", false)).toThrow("2 to 4 prices");
    expect(() => parseRates("3 -1", false)).toThrow("at least 0");
    expect(formatRates({ input: 3, output: 15, cacheWrite: 3.75 })).toBe("3 15  3.75");
  });

  test("rule prices: a percentage, or prices where - keeps the base", () => {
    expect(parseRulePrices("50%")).toEqual({ scale: 0.5 });
    expect(parseRulePrices("- 0.55")).toEqual({ output: 0.55 });
    expect(() => parseRulePrices("- -")).toThrow("at least one price");
  });

  test("when: times, days, dates and a time zone in any order, written back the same way", () => {
    const rule = parseWhen("UTC+8 sat,sun 2026-12-01.. 00:30-08:30");
    expect(rule).toEqual({ tz: "UTC+8", days: [0, 6], since: "2026-12-01", times: [{ from: "00:30", to: "08:30" }] });
    expect(formatWhen(rule)).toBe("sun,sat 00:30-08:30 2026-12-01.. UTC+8");
    expect(parseWhen("mon-fri").days).toEqual([1, 2, 3, 4, 5]);
    // 跨过周末
    expect(parseWhen("fri-mon").days).toEqual([0, 1, 5, 6]);
    expect(formatWhen(parseWhen("mon-fri 2026-12-25"))).toBe("mon-fri 2026-12-25");
    expect(() => parseWhen("25:00-26:00")).toThrow("Not a time of day");
    expect(() => parseWhen("soon")).toThrow("Not understood");
  });
});
