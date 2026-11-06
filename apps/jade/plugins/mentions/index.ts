// jade/mentions：用户消息里 @ 引用的文件和目录，内容随消息交给模型，模型不用再读一遍。
//
// 内核没有改写用户输入的扩展点：input.received 原样进日志。所以在 context.project 里把附件加到引用它的那条用户消息后面。
// 附件在消息之后第一次投影时读取，先用 ctx.record 写进日志（derived）再使用（I-5）：之后每次投影都从 derived 里取，
// 文件之后变了也不影响已经发出的消息（提示缓存不失效），恢复会话后也一样。
// 输入框里 @ 的补全不在这里，在 jade/tui。

import type { Block, Message } from "uncarved";
import { definePlugin } from "../../src/api.ts";
import type { Renderers } from "../renderers/index.ts";
import { attachMentions } from "./attach.ts";
import { clip, dim, yellow } from "./style.ts";

export interface MentionsState {
  /** state.messages 的前 upTo 条已经处理过 */
  upTo: number;
  /** 消息的下标 → 附在它后面的内容 */
  attached: Record<string, Block[]>;
}

/** 读文件的时限 */
const READ_TIMEOUT_MS = 30_000;

/** 用户自己写的文字；工具结果、插件加的说明不算 */
const userText = (m: Message) => (m.role === "user" ? m.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join("\n") : "");

export default definePlugin({
  process(ctx) {
    const renderers = ctx.service<Renderers>("renderers@1");
    renderers?.event({
      event: "attached",
      render: (data) => {
        const d = data as { attached: string[]; failed: { path: string; reason: string }[] };
        const lines = [
          ...d.failed.map((f) => yellow(`[@${f.path} not attached: ${clip(f.reason, 200)}]`)),
          ...(d.attached.length ? [dim(`[attached ${d.attached.map((p) => `@${p}`).join(", ")}]`)] : []),
        ];
        return lines.length ? { line: lines.join("\n") } : undefined;
      },
    });
  },

  session(ctx) {
    const key = ctx.plugin;
    /** 本进程里已经扫过的消息条数：没有 @ 的消息不用记进日志 */
    let scanned = 0;
    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // 排在压缩之前：压缩估算的是带着附件的投影
      order: -50,
      // 出错时跳过（不附上），不让这一轮失败
      optional: true,
      timeoutMs: READ_TIMEOUT_MS + 5_000,
      fn: async (messages, hook) => {
        let state = (hook.derived[key] as MentionsState | undefined) ?? { upTo: 0, attached: {} };
        const start = Math.max(state.upTo, scanned);
        let changed = false;
        if (messages.length > start) {
          const attached = { ...state.attached };
          const signal = AbortSignal.any([hook.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
          for (let i = start; i < messages.length; i++) {
            const text = userText(messages[i]!);
            if (!text.includes("@")) continue;
            changed = true;
            const refs = await attachMentions(text, { cwd: ctx.cwd, plugin: ctx.plugin, signal });
            if (refs.blocks.length) attached[i] = refs.blocks;
            if (refs.attached.length || refs.failed.length) await hook.emit("attached", { attached: refs.attached, failed: refs.failed });
          }
          state = { upTo: messages.length, attached };
          // 处理过带 @ 的消息才记：之后的投影、恢复的会话都用这次读到的内容
          if (changed) await hook.record(key, state);
          scanned = messages.length;
        }
        return messages.map((m, i) => (state.attached[i] ? { ...m, content: [...m.content, ...state.attached[i]!] } : m));
      },
    });
  },
});
