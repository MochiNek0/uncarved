// jade/budget：一轮里模型回复的次数达到上限就停下（turn.continue 关卡拒绝，这一轮以 stopped 结束）。
// 从旧 jade 的 plugins/budget.ts 移植；上限来自配置 maxSteps。

import type { State } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";

const DEFAULT_STEPS = 100;

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

    ctx.kernel.hook({
      kind: "gate",
      point: "turn.continue",
      fn: async (s, hook) => {
        if (stepsThisTurn(s) < max) return { decision: "abstain" };
        // 告诉用户为什么停下（前端把 <插件 id>/notice 显示成一行）
        await hook.emit("notice", { text: `stopped after ${max} model responses in this turn (config maxSteps); send a message to continue`, level: "warning" });
        return { decision: "deny" };
      },
    });
  },
});
