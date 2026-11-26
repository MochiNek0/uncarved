// 模型的单价：/model 里填，存在 models.json 那个模型上（saved.ts），jade/cost 经 models@1.price 按请求的时间取。
//
// 基础价之外可以有按时间的规则（峰谷价、周末价、限时折扣）：从上往下第一条符合的算数，都不符合时用基础价。
// 一条规则可以限定星期几、每天的时段（可以跨零点）、起止日期和时区，价格写成基础价的百分比，或者逐项写（没写的项用基础价）。

import type { Price } from "@uncarved/jade-api/services";

export type Currency = "USD" | "CNY";
export const CURRENCIES: Currency[] = ["USD", "CNY"];
const SYMBOL: Record<Currency, string> = { USD: "$", CNY: "¥" };

interface Rates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 一天里的一段 HH:MM：from 算在内、to 不算；from 比 to 晚时跨零点。只写一头时另一头是零点 */
export interface TimeRange {
  from?: string;
  to?: string;
}

export interface PriceRule extends Rates {
  /** 星期几，0 是周日 */
  days?: number[];
  /** 每天的时段，在其中任一段里就算 */
  times?: TimeRange[];
  /** 起止日期 YYYY-MM-DD，两头都算在内 */
  since?: string;
  until?: string;
  /** IANA 时区或 UTC+8 这种写法；没有时用本机时区 */
  tz?: string;
  /** 基础价的倍数（50% 是 0.5）；有它时不看逐项的价格 */
  scale?: number;
}

/** 每百万 token 的单价；cacheRead、cacheWrite 没有时按 input 算 */
export interface ModelPrice extends Required<Pick<Rates, "input" | "output">> {
  currency: Currency;
  cacheRead?: number;
  cacheWrite?: number;
  rules?: PriceRule[];
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const hhmm = (t: string) => {
  const m = TIME.exec(t)!;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
};

function validTz(tz: string): boolean {
  if (OFFSET.test(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** models.json 里的单价；写错的整个不要，写错的规则跳过 */
export function readPrice(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const input = num(r.input);
  const output = num(r.output);
  if (input === undefined || output === undefined) return undefined;
  const currency: Currency = r.currency === "CNY" ? "CNY" : "USD";
  const out: ModelPrice = { currency, input, output };
  if (num(r.cacheRead) !== undefined) out.cacheRead = num(r.cacheRead);
  if (num(r.cacheWrite) !== undefined) out.cacheWrite = num(r.cacheWrite);
  const rules = Array.isArray(r.rules) ? r.rules.flatMap((x) => readRule(x) ?? []) : [];
  if (rules.length) out.rules = rules;
  return out;
}

function readRule(raw: unknown): PriceRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PriceRule = {};
  if (Array.isArray(r.days)) {
    const days = r.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length) out.days = [...new Set(days)].sort();
  }
  // 早先的写法是规则上直接一个 from、to
  const times = (Array.isArray(r.times) ? r.times : r.from !== undefined || r.to !== undefined ? [{ from: r.from, to: r.to }] : []).flatMap((x: unknown) => readRange(x) ?? []);
  if (times.length) out.times = times;
  for (const k of ["since", "until"] as const) if (typeof r[k] === "string" && DATE.test(r[k])) out[k] = r[k];
  if (typeof r.tz === "string" && validTz(r.tz)) out.tz = r.tz;
  if (num(r.scale) !== undefined) out.scale = num(r.scale);
  else for (const k of RATE_KEYS) if (num(r[k]) !== undefined) out[k] = num(r[k]);
  return out;
}

/** 一个时段；两头都没写或写错时 undefined */
function readRange(raw: unknown): TimeRange | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: TimeRange = {};
  for (const k of ["from", "to"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "string" || !TIME.test(r[k])) return undefined;
    out[k] = hhmm(r[k]);
  }
  return out.from !== undefined || out.to !== undefined ? out : undefined;
}

/** 在 tz 的当地时间：日期 YYYY-MM-DD、星期几、从零点起的分钟数 */
function localTime(at: Date, tz: string | undefined): { date: string; day: number; minutes: number } {
  const offset = tz ? OFFSET.exec(tz) : null;
  if (!tz || offset) {
    // 本机时区，或者固定的偏移：挪到 UTC 上读
    const shift = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) : -at.getTimezoneOffset();
    const d = new Date(at.getTime() + shift * 60_000);
    return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const prevDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * 规则在 at 这一刻算不算数：在任一个时段里（没写时段时整天都算），并且星期、日期也符合。
 * 跨零点的时段，零点之后那段的星期几和日期按开始的那天算
 */
export function ruleMatches(rule: PriceRule, at: Date): boolean {
  const t = localTime(at, rule.tz);
  /** 现在落在时段里时，这一段从哪天开始 */
  const startDays: { date: string; day: number }[] = [];
  if (!rule.times?.length) startDays.push(t);
  for (const r of rule.times ?? []) {
    const from = r.from === undefined ? 0 : minutesOf(r.from);
    const to = r.to === undefined ? 24 * 60 : minutesOf(r.to);
    if (from < to) {
      if (t.minutes >= from && t.minutes < to) startDays.push(t);
    } else if (t.minutes >= from) startDays.push(t);
    else if (t.minutes < to) startDays.push({ date: prevDate(t.date), day: (t.day + 6) % 7 });
  }
  return startDays.some(
    ({ date, day }) => (!rule.days || rule.days.includes(day)) && (!rule.since || date >= rule.since) && (!rule.until || date <= rule.until),
  );
}

/** at 这一刻的单价 */
export function priceAt(p: ModelPrice, at: Date): Price {
  const base: Price = { input: p.input, output: p.output, currency: p.currency };
  if (p.cacheRead !== undefined) base.cacheRead = p.cacheRead;
  if (p.cacheWrite !== undefined) base.cacheWrite = p.cacheWrite;
  const rule = p.rules?.find((r) => ruleMatches(r, at));
  if (!rule) return base;
  const out: Price = { ...base };
  for (const k of RATE_KEYS) {
    // 打折时缓存价没写的按输入价打；逐项写的规则没写的项留基础价（缓存价没写时 jade/cost 按这条规则的输入价算）
    if (rule.scale !== undefined) out[k] = (base[k] ?? base.input) * rule.scale;
    else if (rule[k] !== undefined) out[k] = rule[k];
  }
  return out;
}

// ---------- 在 /model 里输入和显示 ----------

const n = (v: number) => String(Number(v.toFixed(6)));

/** 一行价格："3 15 0.3 3.75"（输入 输出 [缓存读 [缓存写]]）；allowKeep 时 "-" 表示用基础价。写错时抛出 */
export function parseRates(text: string, allowKeep: boolean): Rates {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < (allowKeep ? 1 : 2) || parts.length > 4) throw new Error(`Write ${allowKeep ? "1 to 4" : "2 to 4"} prices: input output [cache read] [cache write], got ${JSON.stringify(text)}`);
  const out: Rates = {};
  parts.forEach((p, i) => {
    if (allowKeep && p === "-") return;
    const v = Number(p.replace(/^[$¥]/, ""));
    if (!Number.isFinite(v) || v < 0) throw new Error(`Prices must be numbers of at least 0, got ${JSON.stringify(p)}`);
    out[RATE_KEYS[i]!] = v;
  });
  return out;
}

export function formatRates(r: Rates, keep = false): string {
  const vals = RATE_KEYS.map((k) => (r[k] === undefined ? undefined : n(r[k]!)));
  while (vals.length && vals.at(-1) === undefined) vals.pop();
  return vals.map((v) => v ?? (keep ? "-" : "")).join(" ");
}

/** 规则的价格那一行："50%"，或者逐项的价格（"-" 用基础价） */
export function parseRulePrices(text: string): Pick<PriceRule, "scale" | keyof Rates> {
  const pct = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(text);
  if (pct) return { scale: Number(pct[1]) / 100 };
  const r = parseRates(text, true);
  if (Object.keys(r).length === 0) throw new Error("Write a percentage such as 50%, or at least one price");
  return r;
}

export function formatRulePrices(rule: PriceRule): string {
  return rule.scale !== undefined ? `${n(rule.scale * 100)}%` : formatRates(rule, true);
}

/**
 * 规则的时间那一行：空格分开的几项，顺序不限，都可以不写：
 * 时段 "00:30-08:30"（可以有几段，"09:00-12:00,14:00-18:00" 或者分开写）、星期 "mon-fri" 或 "sat,sun"、日期 "2026-12-01..2026-12-31"（一头可以空着）、时区 "UTC+8" 或 "Asia/Shanghai"。
 * 写错时抛出
 */
export function parseWhen(text: string): Omit<PriceRule, "scale" | keyof Rates> {
  const out: Omit<PriceRule, "scale" | keyof Rates> = {};
  for (const part of text.trim().split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    const dates = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/.exec(part);
    // 一项里可以用逗号写几个时段：09:00-12:00,14:00-18:00；也可以分开写成几项
    const ranges = part.split(",").map((x) => /^(\d{1,2}:\d{2})?-(\d{1,2}:\d{2})?$/.exec(x));
    if (ranges.every((m) => m && (m[1] || m[2]))) {
      for (const m of ranges) {
        for (const t of [m![1], m![2]]) if (t && !TIME.test(t)) throw new Error(`Not a time of day: ${t}`);
        (out.times ??= []).push({ ...(m![1] ? { from: hhmm(m![1]) } : {}), ...(m![2] ? { to: hhmm(m![2]) } : {}) });
      }
    } else if (dates && (dates[1] || dates[2])) {
      for (const d of [dates[1], dates[2]]) if (d && Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new Error(`Not a date: ${d}`);
      if (dates[1]) out.since = dates[1];
      if (dates[2]) out.until = dates[2];
    } else if (DATE.test(part)) {
      out.since = out.until = part;
    } else if (/^[a-z]{3}(?:[-,][a-z]{3})*$/.test(lower) && DAYS.includes(lower.slice(0, 3))) {
      const days = new Set<number>(out.days);
      for (const piece of lower.split(",")) {
        const [a, b] = piece.split("-").map((d) => DAYS.indexOf(d));
        if (a === undefined || a < 0 || (b !== undefined && b < 0)) throw new Error(`Days are written like mon-fri or sat,sun, got ${JSON.stringify(part)}`);
        // mon-fri；fri-mon 跨过周末
        for (let d = a; ; d = (d + 1) % 7) {
          days.add(d);
          if (b === undefined || d === b) break;
        }
      }
      out.days = [...days].sort();
    } else if (validTz(part)) {
      out.tz = part;
    } else {
      throw new Error(`Not understood: ${JSON.stringify(part)}. Write times like 00:30-08:30, days like mon-fri, dates like 2026-12-01..2026-12-31, and a time zone like UTC+8 or Asia/Shanghai`);
    }
  }
  return out;
}

/** parseWhen 的反过来：编辑时预填，菜单里显示 */
export function formatWhen(rule: PriceRule): string {
  const parts: string[] = [];
  if (rule.days) parts.push(formatDays(rule.days));
  if (rule.times?.length) parts.push(rule.times.map((r) => `${r.from ?? ""}-${r.to ?? ""}`).join(","));
  if (rule.since !== undefined && rule.since === rule.until) parts.push(rule.since);
  else if (rule.since !== undefined || rule.until !== undefined) parts.push(`${rule.since ?? ""}..${rule.until ?? ""}`);
  if (rule.tz) parts.push(rule.tz);
  return parts.join(" ");
}

/** 连着的几天写成 mon-fri */
function formatDays(days: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
    out.push(j - i >= 2 ? `${DAYS[days[i]!]}-${DAYS[days[j]!]}` : days.slice(i, j + 1).map((d) => DAYS[d]).join(","));
    i = j + 1;
  }
  return out.join(",");
}

export const symbol = (c: string | undefined) => SYMBOL[c as Currency] ?? "$";

/** 菜单里的简要说明，例如 "$3 in · $15 out · 2 time rules" */
export function priceSummary(p: ModelPrice | undefined): string {
  if (!p) return "not set";
  const s = symbol(p.currency);
  const rules = p.rules?.length ? ` · ${p.rules.length} time rule${p.rules.length > 1 ? "s" : ""}` : "";
  return `${s}${n(p.input)} in · ${s}${n(p.output)} out${rules}`;
}
