// jade/mentions：用户消息里 @ 引用的文件和目录，内容随消息交给模型，模型不用再读一遍。
//
// 内核没有改写用户输入的扩展点：input.received 原样进日志。所以在 context.project 里把附件加到引用它的那条用户消息后面。
// 附件在消息之后第一次投影时读取，先用 ctx.record 写进日志（derived）再使用（I-5）：之后每次投影都从 derived 里取，
// 文件之后变了也不影响已经发出的消息（提示缓存不失效），恢复会话后也一样。
// 每条消息的附件单独记一个 key（attachedKey）：derived.recorded 是整值替换，记成一张表的话，
// 每次有新的 @ 都要把之前附过的全部内容再写一遍，日志按平方增长。
// 输入框里 @ 的补全：经 completions@1 交给前端候选（candidates.ts），前端只管排序和插入。

import type { Block, Message } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";
import type { Completions, Renderers } from "@uncarved/jade-api/services";
import { attachMentions } from "./attach.ts";
import { mentionCandidates } from "./candidates.ts";
import { clip, dim, lines as joinLines, warn } from "./style.ts";

export interface MentionsState {
  /** state.messages 的前 upTo 条已经处理过 */
  upTo: number;
  /** 旧格式：消息的下标 → 附在它后面的内容。现在每条消息单独记在 attachedKey 下，这里只为读旧会话的日志 */
  attached?: Record<string, Block[]>;
}

/** 附在第 i 条消息后面的内容记在这个 key 下 */
export const attachedKey = (plugin: string, i: number) => `${plugin}/${i}`;

/** 读文件的时限 */
const READ_TIMEOUT_MS = 30_000;

/** 用户自己写的文字；工具结果、插件加的说明不算 */
const userText = (m: Message) => (m.role === "user" ? m.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join("\n") : "");

export default definePlugin({
  process(ctx) {
    ctx.service<Completions>("completions@1")?.register({
      trigger: "@",
      label: "files",
      hint: "the file's content is sent with the message",
      candidates: () => mentionCandidates(ctx.cwd),
    });
    const renderers = ctx.service<Renderers>("renderers@1");
    renderers?.event({
      event: "attached",
      render: (data) => {
        const d = data as { attached: string[]; failed: { path: string; reason: string }[] };
        const lines = [
          ...d.failed.map((f) => warn(`[@${f.path} not attached: ${clip(f.reason, 200)}]`)),
          ...(d.attached.length ? [dim(`[attached ${d.attached.map((p) => `@${p}`).join(", ")}]`)] : []),
        ];
        return lines.length ? { line: joinLines(lines) } : undefined;
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
        const state = hook.derived[key] as MentionsState | undefined;
        const start = Math.max(state?.upTo ?? 0, scanned);
        /** 这次记下的；hook.derived 是调用时的快照，刚记下的不在里面 */
        const fresh = new Map<number, Block[]>();
        if (state?.attached) {
          // 旧格式的会话：先拆成每条消息一个 key，进度里去掉整表，之后不再随新的 @ 重写
          for (const [i, blocks] of Object.entries(state.attached)) {
            await hook.record(attachedKey(key, Number(i)), blocks);
            fresh.set(Number(i), blocks);
          }
          await hook.record(key, { upTo: state.upTo } satisfies MentionsState);
        }
        if (messages.length > start) {
          let changed = false;
          const signal = AbortSignal.any([hook.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
          for (let i = start; i < messages.length; i++) {
            const text = userText(messages[i]!);
            if (!text.includes("@")) continue;
            changed = true;
            const refs = await attachMentions(text, { cwd: ctx.cwd, plugin: ctx.plugin, signal });
            if (refs.blocks.length) {
              await hook.record(attachedKey(key, i), refs.blocks);
              fresh.set(i, refs.blocks);
            }
            if (refs.attached.length || refs.failed.length) await hook.emit("attached", { attached: refs.attached, failed: refs.failed });
          }
          // 处理过带 @ 的消息才记：恢复的会话不再重新读这些消息引用的文件（文件可能已经变了）
          // 附件先于进度记下：两次记录之间崩溃时请求还没发出，恢复后重新处理这条消息即可
          if (changed) await hook.record(key, { upTo: messages.length } satisfies MentionsState);
          scanned = messages.length;
        }
        return messages.map((m, i) => {
          const extra = fresh.get(i) ?? (hook.derived[attachedKey(key, i)] as Block[] | undefined);
          return extra ? { ...m, content: [...m.content, ...extra] } : m;
        });
      },
    });
  },
});
