// jade/continue：模型的回复被输出上限截断（这一轮以 max_tokens 结束）时，让模型接着做，而不是把半截任务丢给用户。
//
// 从 turn.ended 事件知道这一轮怎么结束的（observe event），在 session.afterTurn 里用 session.send 发一条 [Note from jade]。
// 每次用户输入之后最多续写 maxContinues 次。从旧 jade 的 plugins/turns.ts 的 continueTurns 移植。
//
// 旧 jade 的"上下文溢出后压缩重试"不在这里：不压缩就重试只会再溢出一次，整件事归 jade/compact。

import type { Block, UserInput } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";

export const DEFAULT_CONTINUES = 3;
export const CONTINUE_NOTE =
  "Your previous reply was cut off because it reached the output token limit. Continue from where you stopped. " +
  "If you were writing a large file or edit, split it into several smaller write_file/edit_file calls.";

export default definePlugin({
  session(ctx) {
    const ui = ctx.service<UI>("ui@1");
    const raw = ctx.config.maxContinues;
    let max = DEFAULT_CONTINUES;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) max = raw;
    else if (raw !== undefined) ui?.notify(`jade/continue: maxContinues must be a non-negative integer, got ${JSON.stringify(raw)}; using ${DEFAULT_CONTINUES}`, "warning");

    /** 这次用户输入之后已经续写了几次 */
    let count = 0;
    /** 我们发出、还没收到的续写；收到它不算用户的新输入 */
    let pending: Block | undefined;

    const note = (): Block => ({ kind: "text", text: `[Note from jade] ${CONTINUE_NOTE}`, origin: { by: "plugin", id: ctx.plugin }, trust: "trusted" });

    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "input.received") {
          const input = e.data as UserInput;
          // 用户（或别的插件替用户）发的新消息：重新计数。/retry、审批不算新输入
          if (input.kind !== "message") return;
          const ours = pending !== undefined && input.content.length === 1 && input.content[0]!.kind === "text" && input.content[0]!.origin.by === "plugin" && input.content[0]!.origin.id === ctx.plugin;
          if (ours) pending = undefined;
          else count = 0;
          return;
        }
        if (e.type !== "turn.ended") return;
        if ((e.data as { reason?: unknown }).reason !== "max_tokens" || count >= max) return;
        count++;
        const n = count;
        // 本轮完全结束之后再发：现在发会排在本轮之后，但 send 要等本轮结束，不能在 hook 里等
        ctx.session.afterTurn(() => {
          ui?.notify(`[asking the model to continue (${n}/${max})]`);
          pending = note();
          // 不能 await：afterTurn 跑完之后会话才处理排队的输入。出错时前端从 turn.ended 显示原因
          ctx.session.send({ kind: "message", content: [pending] }).catch(() => {});
        });
      },
    });
  },
});
