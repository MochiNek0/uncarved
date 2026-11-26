// 提示缓存的健康状况：每次请求前看它是不是沿用了上一次请求的前缀（只在后面追加），没沿用就记一条 jade/cost/prefix 事件；
// /cost 据此把没命中缓存的输入分成两类：Jade 自己改了前缀（压缩、系统提示词变了……），还是前缀没变、服务端却没命中。
//
// 只比较 Jade 发出的请求，不管 provider 怎么转换；比较时去掉不发给模型的字段（origin、trust），
// 块按对象缓存哈希（投影里没变的块是同一个对象），每次请求只给新块算哈希。

import { createHash } from "node:crypto";
import type { Block, LogEvent, ModelRequest } from "uncarved";

export type PrefixPart = "system" | "tools" | "messages";

/** 这次请求从哪里开始和上一次不一样；message 是第一条不一样的消息的下标 */
export interface PrefixChange {
  part: PrefixPart;
  message?: number;
}

const sha = (s: string) => createHash("sha1").update(s).digest("base64");
const sent = (key: string, value: unknown) => (key === "origin" || key === "trust" ? undefined : value);

/** 返回一个函数：每次请求调用一次，前缀和上一次请求的不一致时返回从哪里开始变了 */
export function prefixWatcher(): (req: ModelRequest) => PrefixChange | undefined {
  const hashes = new WeakMap<Block, string>();
  const blockHash = (b: Block) => {
    let h = hashes.get(b);
    if (h === undefined) hashes.set(b, (h = sha(JSON.stringify(b, sent))));
    return h;
  };
  let prev: { system: string; tools: string; flat: string[]; at: number[] } | undefined;
  return (req) => {
    // 消息摊平成一串：消息的角色、它的每个块。往最后一条消息里追加块也算沿用前缀
    const flat: string[] = [];
    const at: number[] = [];
    req.messages.forEach((m, i) => {
      flat.push(m.role);
      at.push(i);
      for (const b of m.content) {
        flat.push(blockHash(b));
        at.push(i);
      }
    });
    const cur = { system: sha(JSON.stringify(req.system.map((s) => s.text))), tools: sha(JSON.stringify(req.tools)), flat, at };
    const before = prev;
    prev = cur;
    if (!before) return undefined;
    if (cur.system !== before.system) return { part: "system" };
    if (cur.tools !== before.tools) return { part: "tools" };
    const n = Math.min(flat.length, before.flat.length);
    let i = 0;
    while (i < n && flat[i] === before.flat[i]) i++;
    if (i === before.flat.length) return undefined;
    return { part: "messages", message: at[i] ?? req.messages.length };
  };
}

/** 服务端的缓存大概多久过期：超过这么久没请求，没命中不算异常（Anthropic 默认 5 分钟） */
const IDLE_MS = 5 * 60_000;
/** 少于这么多 token 的差额不算没命中（各家按块缓存，最后不满一块的部分本来就读不到） */
const NOISE_TOKENS = 2000;

/** /cost 里关于提示缓存的几行；没有缓存命中时为空 */
export function cacheReport(history: LogEvent[], prefixEvent: string): string[] {
  let input = 0;
  let read = 0;
  const cached = new Set<string>();
  for (const e of history) {
    if (e.type !== "model.responded") continue;
    const u = (e as LogEvent<"model.responded">).data.usage;
    input += u?.inputTokens ?? 0;
    read += u?.cacheReadTokens ?? 0;
    if (u?.cacheReadTokens && e.origin.by === "model") cached.add(e.origin.model);
  }
  // 没报告过缓存命中（不支持缓存或不报告）：前缀变没变都无所谓
  if (read === 0) return [];

  const changes: Record<string, number> = {};
  let compacting = false;
  let changed = false;
  const misses = { n: 0, tokens: 0, idle: 0 };
  let prev: { at: number; input: number; model: string } | undefined;
  for (const e of history) {
    if (e.type === "jade/compact/trimmed" || e.type === "jade/compact/compacted") compacting = true;
    else if (e.type === "model.requested") compacting = false;
    else if (e.type === prefixEvent) {
      const c = e.data as PrefixChange;
      const why = c.part === "messages" ? (compacting ? "compaction" : "earlier messages") : c.part === "system" ? "system prompt" : "tools";
      changes[why] = (changes[why] ?? 0) + 1;
      changed = true;
    } else if (e.type === "model.responded" && e.origin.by === "model") {
      const u = (e as LogEvent<"model.responded">).data.usage;
      if (!u?.inputTokens) continue;
      const cur = { at: Date.parse(e.at), input: u.inputTokens, model: e.origin.model };
      // 从来没报告过缓存命中的模型（不支持缓存，或者不报告）不算
      const r = u.cacheReadTokens ?? 0;
      if (prev && !changed && prev.model === cur.model && cached.has(cur.model) && prev.input - r > NOISE_TOKENS && r < prev.input * 0.9) {
        misses.n++;
        misses.tokens += prev.input - r;
        if (cur.at - prev.at > IDLE_MS) misses.idle++;
      }
      prev = cur;
      changed = false;
    }
  }

  const pct = Math.round((100 * read) / input);
  const lines = [`Prompt cache: ${pct}% of input read from cache`];
  const list = Object.entries(changes).map(([why, n]) => `${why} ×${n}`);
  if (list.length) lines.push(`Prefix changed by jade: ${list.join(", ")}`);
  if (misses.n) {
    const idle = misses.idle ? `, ${misses.idle} after more than 5 minutes idle` : "";
    lines.push(`Cache missed with the prefix unchanged: ${misses.n}× (~${Math.round(misses.tokens / 1000)}k tokens${idle})`);
  }
  return lines;
}
