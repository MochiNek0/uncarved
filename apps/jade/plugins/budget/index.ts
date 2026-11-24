// jade/budget：一轮里模型回复的次数达到上限就停下（turn.continue 关卡拒绝，这一轮以 stopped 结束）。
// 从旧 jade 的 plugins/budget.ts 移植；上限来自配置 maxSteps。
//
// 停下时最后一条回复通常只有工具调用，用户什么都没收到。所以停下之后再发一条 [Note from jade]，
// 要模型不调用工具、总结做了什么和还剩什么（同 jade/continue，在 session.afterTurn 里 send）。
// 收尾这一轮拒绝所有工具调用；模型仍然调用了工具时还能再回复一次，之后一定停下。

import type { Block, State, UserInput } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";

const DEFAULT_STEPS = 100;
/** 收尾这一轮最多几次回复：调了工具被拒之后还有一次写总结 */
const WRAP_UP_STEPS = 2;

export const WRAP_UP_NOTE =
  "You have reached the step limit for this turn. Do not call any more tools. " +
  "Reply to the user now: summarize what you did, the current state of any files you changed (including anything left half-done), and what remains.";
export const WRAP_UP_TOOL_REASON = "The step limit for this turn has been reached; tools are disabled. Reply to the user with your summary instead.";

/** 本轮（最近一条用户输入之后）模型已经回复了几次 */
export function stepsThisTurn(s: State): number {
  let steps = 0;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    if (m.role === "assistant") steps++;
    else if (m.content.some((b) => b.kind !== "tool_result")) break;
  }
  return steps;
}

export default definePlugin({
  session(ctx) {
    const raw = ctx.config.maxSteps;
    let max = DEFAULT_STEPS;
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) max = raw;
    else if (raw !== undefined) ctx.service<UI>("ui@1")?.notify(`jade/budget: maxSteps must be a positive integer, got ${JSON.stringify(raw)}; using ${DEFAULT_STEPS}`, "warning");

    /** 这一轮是我们拒绝继续才停下的 */
    let stopped = false;
    /** 我们发出、还没收到的收尾消息 */
    let pending: Block | undefined;
    /** 正在收尾：收到收尾消息之后、这一轮结束之前 */
    let wrappingUp = false;

    ctx.kernel.hook({
      kind: "gate",
      point: "turn.continue",
      fn: async (s, hook) => {
        if (stepsThisTurn(s) < (wrappingUp ? WRAP_UP_STEPS : max)) return { decision: "abstain" };
        if (!wrappingUp) {
          stopped = true;
          // 告诉用户为什么停下（前端把 <插件 id>/notice 显示成一行）
          await hook.emit("notice", { text: `stopped after ${max} model responses in this turn (config maxSteps); asking the model to summarize. Send a message to continue`, level: "warning" });
        }
        return { decision: "deny" };
      },
    });
    ctx.kernel.hook({
      kind: "gate",
      point: "tool.gate",
      fn: () => (wrappingUp ? { decision: "deny", reason: WRAP_UP_TOOL_REASON } : { decision: "abstain" }),
    });
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "input.received") {
          const input = e.data as UserInput;
          if (input.kind !== "message") return;
          const b = input.content[0];
          wrappingUp = pending !== undefined && input.content.length === 1 && b!.origin.by === "plugin" && b!.origin.id === ctx.plugin;
          if (wrappingUp) pending = undefined;
          return;
        }
        if (e.type !== "turn.ended") return;
        const ask = stopped && (e.data as { reason?: unknown }).reason === "stopped";
        stopped = false;
        wrappingUp = false;
        if (!ask) return;
        // 本轮完全结束之后再发（同 jade/continue）
        ctx.session.afterTurn(() => {
          pending = { kind: "text", text: `[Note from jade] ${WRAP_UP_NOTE}`, origin: { by: "plugin", id: ctx.plugin }, trust: "trusted" };
          ctx.session.send({ kind: "message", content: [pending] }).catch(() => {});
        });
      },
    });
  },
});
