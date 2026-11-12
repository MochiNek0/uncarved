// jade/steer：在一轮的中途对模型说话。内核只在空闲时接受用户消息（一轮没完时不能再发一条），
// 所以不走输入：前端经 steer@1 把话交过来，下一次请求模型时在 context.project 里附在最后一条消息
// （这时是刚执行完的工具的结果）后面，并写进日志（derived），之后的投影、恢复的会话里它都在同一个位置。
// 和 prompts@1 的 note 是同一个办法，区别是这里是用户自己说的话，所以项目层插件不能用。
//
// 这一轮没有再请求模型就结束了的（模型正在写最后一条回复时说的），话还留在这里：前端在一轮结束后用 take 取回，
// 当作普通消息发出去。

import type { Block, Message } from "uncarved";
import { definePlugin, type Span } from "@uncarved/jade-api";
import type { Renderers, Steer } from "@uncarved/jade-api/services";

const ID = "jade/steer";
/** derived 里：消息的下标 → 附在它后面的话 */
const KEY = `${ID}/said`;
type Said = Record<string, string[]>;

/** 附在用户的话前面，告诉模型这是中途说的 */
export const MARKER = "[The user sent the following while you were working. Take it into account from here on.]";

interface Entry {
  /** 还没交给模型的话 */
  pending: string[];
  /** 这个会话有没有一轮正在跑 */
  running(): boolean;
}

/** 打开着的会话。模块每个进程只加载一次，进程级和会话级共用 */
const sessions = new Map<string, Entry>();
const watchers = new Set<() => void>();

function changed(): void {
  for (const fn of [...watchers]) {
    try {
      fn();
    } catch {
      // 订阅者的错不连累这里
    }
  }
}

// 带语义样式的文字（jade-api 的 Text）：怎么画由前端决定
const bold = (text: string): Span => ({ text, style: "bold" });
const dim = (text: string): Span => ({ text, style: "dim" });

export default definePlugin({
  process(ctx) {
    ctx.provide("steer@1", (caller): Steer => {
      const user = (method: string) => {
        if (caller.layer === "project") throw new Error(`steer.${method}: project plugins cannot speak for the user`);
      };
      return {
        push(session, text) {
          user("push");
          if (typeof text !== "string" || !text.trim()) throw new Error("steer.push: text must be a non-empty string");
          const s = sessions.get(session);
          if (!s?.running()) return false;
          s.pending.push(text);
          changed();
          return true;
        },
        pending: (session) => [...(sessions.get(session)?.pending ?? [])],
        take(session) {
          user("take");
          const taken = sessions.get(session)?.pending.splice(0) ?? [];
          if (taken.length > 0) changed();
          return taken;
        },
        subscribe(fn) {
          if (typeof fn !== "function") throw new Error("steer.subscribe: fn must be a function");
          watchers.add(fn);
          const off = () => void watchers.delete(fn);
          caller.onDispose(off);
          return off;
        },
      };
    });

    // 交给模型的那一刻在对话里显示出来，和用户发的消息一个样子；恢复的会话重新显示时也在原来的位置
    ctx.service<Renderers>("renderers@1")?.event({
      event: "said",
      render(data) {
        const text = (data as { text?: unknown } | null)?.text;
        if (typeof text !== "string") return undefined;
        return { line: ["\n", bold(`› ${text.replace(/\n/g, "\n  ")}`), " ", dim("(sent while working)")] };
      },
    });
  },

  async session(ctx) {
    const id = ctx.session.id;
    const entry: Entry = {
      pending: [],
      running() {
        try {
          const phase = ctx.session.state().phase;
          return phase !== "new" && phase !== "idle" && phase !== "ended";
        } catch {
          // 会话还没建好，或者已经关了
          return false;
        }
      },
    };
    sessions.set(id, entry);
    await ctx.effect(() => () => {
      if (sessions.get(id) === entry) sessions.delete(id);
      if (entry.pending.length > 0) changed();
    });

    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // 排在压缩之类改动消息列表的 hook 前面：下标按日志里的消息算
      order: -39,
      fn: async (messages, hook) => {
        let said = (hook.derived[KEY] as Said | undefined) ?? {};
        if (entry.pending.length > 0 && messages.at(-1)?.role === "user") {
          const texts = entry.pending.splice(0);
          const at = String(messages.length - 1);
          said = { ...said, [at]: [...(said[at] ?? []), ...texts] };
          try {
            // 先落盘再用（I-5）；事件给前端显示
            await hook.record(KEY, said);
            for (const text of texts) await hook.emit("said", { text });
          } catch (e) {
            entry.pending.unshift(...texts);
            throw e;
          }
          changed();
        }
        return messages.map((m, i): Message => {
          const texts = said[i];
          if (!texts?.length || m.role !== "user") return m;
          const blocks: Block[] = [
            { kind: "text", text: MARKER, origin: { by: "plugin", id: ID }, trust: "trusted" },
            ...texts.map((text): Block => ({ kind: "text", text, origin: { by: "user" }, trust: "trusted" })),
          ];
          return { ...m, content: [...m.content, ...blocks] };
        });
      },
    });
  },
});
