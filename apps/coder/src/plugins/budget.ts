// 预算插件：一轮里模型调用次数超过上限就停下（turn.continue）。

import type { Plugin, State } from "uncarved";

export interface BudgetOptions {
  /** 一轮最多调用模型的次数，默认 100 */
  maxSteps?: number;
  id?: string;
}

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

export function budget(opts: BudgetOptions = {}): Plugin {
  const max = opts.maxSteps ?? 100;
  return {
    id: opts.id ?? "coder/budget",
    version: "0.1.0",
    kernel: "^1",
    needs: ["gate:turn.continue"],
    hooks: [
      {
        kind: "gate",
        point: "turn.continue",
        fn: (s) => (stepsThisTurn(s) >= max ? { decision: "deny" } : { decision: "abstain" }),
      },
    ],
  };
}
