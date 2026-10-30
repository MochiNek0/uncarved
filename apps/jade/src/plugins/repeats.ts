// 重复调用插件：模型常常把同一个调用原样再发一遍。
//
// 同一次回复里参数完全相同的调用直接拒绝，不用让用户再批准一次；
// 同一个调用连续失败时，在结果后面提醒模型它已经失败过几次，别再原样重试。
// 失败次数只记在本进程内：恢复会话后从零开始，最多多重试一轮。

import type { Plugin } from "uncarved";

export interface RepeatsOptions {
  /** 模型调用的次数，每次调用模型前加一（见 distro） */
  responses: { readonly calls: number };
  id?: string;
}

/** 提醒模型的失败次数 */
const WARN_AFTER = 2;

export function repeats(opts: RepeatsOptions): Plugin {
  const id = opts.id ?? "jade/repeats";
  /** 本次回复里已经出现的调用 */
  let current = { calls: -1, keys: new Set<string>() };
  /** 调用 → 连续失败的次数；成功一次就清掉 */
  const failures = new Map<string, number>();
  const key = (call: { name: string; input: unknown }) => `${call.name}\0${JSON.stringify(call.input)}`;
  return {
    id,
    version: "0.1.0",
    kernel: "^0.1",
    needs: ["gate:tool.gate", "transform:tool.after"],
    hooks: [
      {
        kind: "gate",
        point: "tool.gate",
        fn: (call) => {
          if (current.calls !== opts.responses.calls) current = { calls: opts.responses.calls, keys: new Set() };
          const k = key(call);
          if (current.keys.has(k)) {
            return { decision: "deny", reason: "This call is identical to an earlier call in the same response and was not run; use that call's result." };
          }
          current.keys.add(k);
          return { decision: "abstain" };
        },
      },
      {
        kind: "transform",
        point: "tool.after",
        fn: (outcome) => {
          const k = key(outcome.call);
          if (!outcome.isError) {
            failures.delete(k);
            return;
          }
          const n = (failures.get(k) ?? 0) + 1;
          failures.set(k, n);
          if (n < WARN_AFTER) return;
          const text = `[Note from jade] This exact call has now failed ${n} times. Do not repeat it unchanged: change the approach, or tell the user what is blocking you.`;
          return { ...outcome, content: [...outcome.content, { kind: "text", text, origin: { by: "plugin", id }, trust: "trusted" }] };
        },
      },
    ],
  };
}
