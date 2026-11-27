// jade/withdraw：用户中断一轮时模型还没有回复（例如消息发错了、马上按了 esc），撤回这条消息，文字放回输入框，会话还是这一个。
//
// 日志只追加，内核状态里这条消息还在：撤回记进 derived（消息的下标），context.project 把它从投影里去掉，模型不会再看到它。
// 只有最后一条消息会被撤回，去掉它不改变前面消息的下标，所以按下标记东西的插件不受影响：
// 排在这里之前的（jade/mentions）按内核里的下标记，撤回的消息带着它的附件一起去掉；
// 排在这里之后的（prompts@1 的 note、jade/steer、压缩）按去掉之后的下标记，附在撤回的消息上的说明落到下一条消息上，不会丢。
//
// 要不要撤回由前端决定（arm，在中止之前调用）：插件、退出中止的一轮不撤回。
// 最后一条消息撤回了却还要请求模型（/retry）时这一轮出错：没有用户的消息可以交给模型。

import type { Message } from "uncarved";
import { definePlugin, type Span } from "@uncarved/jade-api";
import type { Renderers, Withdraw } from "@uncarved/jade-api/services";

const ID = "jade/withdraw";
/** derived 里：撤回的消息在内核状态里的下标 */
const KEY = `${ID}/withdrawn`;

interface Entry {
  /** 前端要中断这一轮 */
  armed: boolean;
  running(): boolean;
}

/** 打开着的会话。模块每个进程只加载一次，进程级和会话级共用 */
const sessions = new Map<string, Entry>();

const dim = (text: string): Span => ({ text, style: "dim" });

/** 用户自己写的文字；插件附上的内容不算 */
const userText = (m: Message) => m.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join("\n");

export default definePlugin({
  process(ctx) {
    ctx.provide("withdraw@1", (caller): Withdraw => ({
      arm(session) {
        if (caller.layer === "project") throw new Error("withdraw.arm: project plugins cannot withdraw the user's messages");
        const s = sessions.get(session);
        if (!s?.running()) return false;
        s.armed = true;
        return true;
      },
    }));

    // 恢复的会话重新显示时也在原来的位置
    ctx.service<Renderers>("renderers@1")?.event({
      event: "withdrawn",
      render: () => ({ line: dim("[withdrawn: the model will not see this message]") }),
    });
  },

  async session(ctx) {
    // 子会话（子 Agent）没有用户按 esc
    if (ctx.session.parent) return;
    const id = ctx.session.id;
    const entry: Entry = {
      armed: false,
      running() {
        try {
          const phase = ctx.session.phase();
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
    });

    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e, hook) => {
        if (e.type !== "turn.ended") return;
        const armed = entry.armed;
        entry.armed = false;
        if (!armed || (e.data as { reason?: unknown }).reason !== "aborted") return;
        const messages = ctx.session.state().messages;
        const at = messages.length - 1;
        const last = messages[at];
        // 模型回复过（最后一条是它的回复，或者工具的结果）就不撤回：那时已经做了事
        if (!last || last.role !== "user" || last.content.some((b) => b.kind === "tool_result")) return;
        const done = (hook.derived[KEY] as number[] | undefined) ?? [];
        if (done.includes(at)) return;
        const text = userText(last);
        await hook.record(KEY, [...done, at]);
        await hook.emit("withdrawn", { text });
        // 放在已经输入的内容前面（中断时取回的排队消息也在那里）
        const typed = ctx.input?.text() ?? "";
        if (text) ctx.input?.set(typed.trim() ? `${text}\n${typed}` : text);
      },
    });

    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // jade/mentions（-50）之后、prompts@1 的 note（-40）和 jade/steer（-39）之前，见文件开头
      order: -45,
      fn: (messages, hook) => {
        const done = hook.derived[KEY] as number[] | undefined;
        if (!done?.length) return messages;
        const drop = new Set(done);
        if (drop.has(messages.length - 1)) throw new Error("nothing to send: your last message was withdrawn");
        return messages.filter((_, i) => !drop.has(i));
      },
    });
  },
});
