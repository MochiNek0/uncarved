// jade/cost：按配置的单价把会话的 token 用量换算成钱，显示在状态栏上；/cost 列出每个模型用了多少。
//
// 单价不内置（价格会变，兼容服务上的模型名也各不相同），写在 $JADE_HOME/config.json，单位是每百万 token（下面的数字只是示例）：
//
//   { "jade/cost": { "prices": { "claude-opus": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 } } } }
//
// 键是模型名或它的前缀（最长的前缀算数）；cacheRead、cacheWrite 不写时按 input 算。没有配置单价的模型只计 token，不计钱。
// 用量来自日志：模型的每次回复，以及插件自己发的请求（压缩的总结、auto 模式的审查、子 Agent），后者不知道用的是哪个模型，
// 按会话当前的模型算。状态栏的合计每轮结束时记进 derived，恢复会话后接着算；/cost 每次从整份日志重算。

import type { LogEvent, Usage } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";
import type { Commands, Models } from "@uncarved/jade-api/services";

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
type Totals = Record<string, Required<Usage>>;

const KEY = "jade/cost/usage";
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
    out[model] = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
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
export function costOf(u: Required<Usage>, p: Price): number {
  const plain = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
  return (plain * p.input + u.cacheReadTokens * (p.cacheRead ?? p.input) + u.cacheWriteTokens * (p.cacheWrite ?? p.input) + u.outputTokens * p.output) / 1_000_000;
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

/** 合计的钱；一个有单价的模型都没有时 undefined */
function total(totals: Totals, prices: Record<string, Price>, current: string | undefined): number | undefined {
  let sum: number | undefined;
  for (const [model, u] of Object.entries(totals)) {
    const p = priceOf(prices, model === UNKNOWN ? (current ?? "") : model);
    if (p) sum = (sum ?? 0) + costOf(u, p);
  }
  return sum;
}

const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default definePlugin({
  process(ctx) {
    const prices = parsePrices(ctx.config.prices);
    ctx.service<Commands>("commands@1")?.register({
      name: "cost",
      description: "show this session's token usage per model, and what it cost at the configured prices",
      instant: true,
      async run(_args, { sessions }) {
        const s = sessions.current;
        if (!s) return "No session is open.";
        const totals: Totals = {};
        for (const e of await s.history()) {
          const u = usageIn(e);
          if (u) add(totals, u.model, u.usage);
        }
        const current = ctx.service<Models>("models@1")?.current()?.model;
        const rows = Object.entries(totals).map(([model, u]) => {
          const p = priceOf(prices, model === UNKNOWN ? (current ?? "") : model);
          const cached = u.cacheReadTokens ? `, ${tokens(u.cacheReadTokens)} from cache` : "";
          return `${model === UNKNOWN ? "plugin requests (compaction, review, sub-agents)" : model}: ${tokens(u.inputTokens)} in${cached}, ${tokens(u.outputTokens)} out${p ? ` · ${money(costOf(u, p))}` : ""}`;
        });
        if (rows.length === 0) return "No model usage in this session yet.";
        const sum = total(totals, prices, current);
        const hint = `No price is configured for ${sum === undefined ? "these models" : "some of these models"}: add {"jade/cost": {"prices": {"<model name or prefix>": {"input": <$ per million tokens>, "output": <$>}}}} to ${ctx.home}/config.json`;
        const unpriced = Object.keys(totals).some((m) => !priceOf(prices, m === UNKNOWN ? (current ?? "") : m));
        return [...rows, ...(sum !== undefined ? [`Total: ${money(sum)}`] : []), ...(unpriced ? [hint] : [])].join("\n");
      },
    });
  },

  session(ctx) {
    const prices = parsePrices(ctx.config.prices);
    // 没有配置单价、或者前端没有状态栏：不用算
    if (Object.keys(prices).length === 0 || !ctx.status) return;
    const models = ctx.service<Models>("models@1");
    let totals: Totals | undefined;
    const show = () => {
      const sum = total(totals ?? {}, prices, models?.current()?.model);
      ctx.status?.(sum === undefined ? undefined : money(sum));
    };
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e, hook) => {
        // 恢复的会话：从上次记下的合计接着算
        totals ??= structuredClone((hook.derived[KEY] as Totals | undefined) ?? {});
        const u = usageIn(e);
        if (u) {
          add(totals, u.model, u.usage);
          show();
        } else if (e.type === "turn.ended") {
          show();
          await hook.record(KEY, totals);
        }
      },
    });
  },
});
