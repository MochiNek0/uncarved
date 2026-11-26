// jade/cost：按单价把会话的 token 用量换算成钱，显示在状态栏上；/cost 列出每个模型用了多少。
//
// 单价不内置（价格会变，兼容服务上的模型名也各不相同）。两个来源，前一个优先：
// - /model 里给模型填的（存在 models.json，可以分时段、用美元或人民币），经 models@1.price 取；
// - $JADE_HOME/config.json，单位是每百万 token（下面的数字只是示例），currency 不写时是美元：
//
//   { "jade/cost": { "prices": { "claude-opus": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 } } } }
//
//   键是模型名或它的前缀（最长的前缀算数）；cacheRead、cacheWrite 不写时按 input 算。
//
// 每个回复按它的时间（事件的 at）取单价，所以峰谷价按请求发生的时段算。不同货币分开合计，不换算。
// 没有单价的模型只计 token，不计钱。用量来自日志：模型的每次回复，以及插件自己发的请求（压缩的总结、auto 模式的审查、子 Agent），
// 后者不知道用的是哪个模型，按会话当前的模型算。状态栏的合计每轮结束时记进 derived，恢复会话后接着算；/cost 每次从整份日志重算。

import type { LogEvent, Usage } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";
import type { Commands, Cost, Models, Price } from "@uncarved/jade-api/services";

export type { Price };
type Totals = Record<string, Required<Usage>>;
/** 货币 → 金额 */
type Money = Record<string, number>;

/** 以前的版本在 derived 里记的是 token 合计（Totals），恢复这样的会话时按现在的单价折算 */
const OLD_KEY = "jade/cost/usage";
/** 状态栏的合计：货币 → 金额 */
const KEY = "jade/cost/spent";
/** 插件自己发的请求没有记模型名时记在这个名字下，算钱时按当前模型 */
const UNKNOWN = "";

/** 配置里的 prices；写错的条目忽略 */
export function parsePrices(value: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [model, raw] of Object.entries(value)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const input = num(p.input);
    const output = num(p.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = num(p.cacheRead);
    const cacheWrite = num(p.cacheWrite);
    const currency = typeof p.currency === "string" && p.currency.trim() ? p.currency.trim().toUpperCase() : undefined;
    out[model] = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), ...(currency ? { currency } : {}) };
  }
  return out;
}

/** 模型的单价：名字完全相同的，否则最长的前缀 */
export function priceOf(prices: Record<string, Price>, model: string): Price | undefined {
  let best: string | undefined;
  for (const key of Object.keys(prices)) if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  return best === undefined ? undefined : prices[best];
}

/** 一份用量按单价是多少钱。inputTokens 含缓存命中和写入的部分（Usage 的约定） */
export function costOf(u: Usage, p: Price): number {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const read = n(u.cacheReadTokens);
  const write = n(u.cacheWriteTokens);
  const plain = Math.max(0, n(u.inputTokens) - read - write);
  return (plain * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + n(u.outputTokens) * p.output) / 1_000_000;
}

/** 一个事件带来的用量和它的模型；不带用量的事件 undefined */
function usageIn(e: LogEvent): { model: string; usage: Usage } | undefined {
  const usage = (e.data as { usage?: Usage } | null)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  if (e.type === "model.responded") return { model: e.origin.by === "model" ? e.origin.model : UNKNOWN, usage };
  return e.origin.by === "plugin" ? { model: UNKNOWN, usage } : undefined;
}

function add(totals: Totals, model: string, u: Usage): void {
  const t = (totals[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  for (const k of Object.keys(t) as (keyof Usage)[]) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) t[k] += v;
  }
}

function addMoney(to: Money, p: Price, amount: number): void {
  const c = p.currency ?? "USD";
  to[c] = (to[c] ?? 0) + amount;
}

const SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };
const amount = (n: number) => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
/** "$0.12 + ¥0.80"；没有符号的货币写成 "0.12 EUR" */
export const money = (m: Money) =>
  Object.entries(m)
    .map(([c, n]) => (SYMBOLS[c] ? `${SYMBOLS[c]}${amount(n)}` : `${amount(n)} ${c}`))
    .join(" + ");
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 取单价：先 models@1.price（/model 里填的），再配置里的。可选服务用的时候再取（设计 3.3） */
function pricer(config: Record<string, unknown>, models: () => Models | undefined) {
  const prices = parsePrices(config.prices);
  const price = (model: string, at: Date = new Date()): Price | undefined => {
    try {
      const p = models()?.price?.(model, at);
      if (p) return p;
    } catch {
      // 模型插件出错时退回配置里的
    }
    return priceOf(prices, model);
  };
  /** 日志里的模型名；插件自己发的请求按当前模型 */
  const forLogged = (model: string, at: Date) => price(model === UNKNOWN ? (models()?.current()?.model ?? "") : model, at);
  return { price, forLogged };
}

export default definePlugin({
  process(ctx) {
    const { price, forLogged } = pricer(ctx.config, () => ctx.service<Models>("models@1"));
    // jade/compact 按缓存价和原价的比例判断提前清理划不划算
    ctx.provide("cost@1", { price } satisfies Cost);
    ctx.service<Commands>("commands@1")?.register({
      name: "cost",
      description: "show this session's token usage per model, and what it cost at the configured prices",
      instant: true,
      async run(_args, { sessions }) {
        const s = sessions.current;
        if (!s) return "No session is open.";
        const totals: Totals = {};
        const spent: Record<string, Money> = {};
        for (const e of await s.history()) {
          const u = usageIn(e);
          if (!u) continue;
          add(totals, u.model, u.usage);
          const p = forLogged(u.model, new Date(e.at));
          if (p) addMoney((spent[u.model] ??= {}), p, costOf(u.usage, p));
        }
        const rows = Object.entries(totals).map(([model, u]) => {
          const cached = u.cacheReadTokens ? `, ${tokens(u.cacheReadTokens)} from cache` : "";
          return `${model === UNKNOWN ? "plugin requests (compaction, review, sub-agents)" : model}: ${tokens(u.inputTokens)} in${cached}, ${tokens(u.outputTokens)} out${spent[model] ? ` · ${money(spent[model])}` : ""}`;
        });
        if (rows.length === 0) return "No model usage in this session yet.";
        const sum: Money = {};
        for (const m of Object.values(spent)) for (const [c, n] of Object.entries(m)) sum[c] = (sum[c] ?? 0) + n;
        const priced = Object.keys(sum).length > 0;
        const hint = `No price is set for ${priced ? "some of these models" : "these models"}: set one in /model (Manage models… → the model → Settings… → Price), or add {"jade/cost": {"prices": {"<model name or prefix>": {"input": <per million tokens>, "output": <…>, "currency": "USD"}}}} to ${ctx.home}/config.json`;
        const unpriced = Object.keys(totals).some((m) => !spent[m]);
        return [...rows, ...(priced ? [`Total: ${money(sum)}`] : []), ...(unpriced ? [hint] : [])].join("\n");
      },
    });
  },

  session(ctx) {
    // 前端没有状态栏：不用算
    if (!ctx.status) return;
    const { forLogged } = pricer(ctx.config, () => ctx.service<Models>("models@1"));
    let spent: Money | undefined;
    /** 上次记进 derived 之后又算了钱：没有单价时不往日志里写空的合计 */
    let dirty = false;
    const show = () => ctx.status?.(spent && Object.keys(spent).length ? money(spent) : undefined);
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e, hook) => {
        // 恢复的会话：从上次记下的合计接着算
        if (!spent) {
          const saved = hook.derived[KEY] as Money | undefined;
          spent = saved ? { ...saved } : {};
          if (!saved) {
            for (const [model, u] of Object.entries((hook.derived[OLD_KEY] as Totals | undefined) ?? {})) {
              const p = forLogged(model, new Date());
              if (p) addMoney(spent, p, costOf(u, p));
            }
          }
          show();
        }
        const u = usageIn(e);
        if (u) {
          const p = forLogged(u.model, new Date(e.at));
          if (p) {
            addMoney(spent, p, costOf(u.usage, p));
            dirty = true;
            show();
          }
        } else if (e.type === "turn.ended" && dirty) {
          dirty = false;
          await hook.record(KEY, spent);
        }
      },
    });
  },
});
