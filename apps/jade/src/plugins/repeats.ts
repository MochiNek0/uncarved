// 重复调用插件：模型常常把同一个调用原样再发一遍。
//
// 同一次回复里参数完全相同的调用直接拒绝，不用让用户再批准一次；
// 同一个调用连续失败时，在结果后面提醒模型它已经失败过几次，别再原样重试；
// 同一个调用已经成功执行过，之后什么都没变（没有执行过只读之外的调用，用户也没有发新消息），
// 再执行一遍结果也完全一样时，在结果后面提醒模型这是重复的（反复读同一个文件、反复打开同一个网页）。
// 不拒绝：结果可能已经被压缩掉了，也可能是在等外面的东西变化，只提醒。
// 这些记录只在本进程内：恢复会话后从零开始，最多多重试一轮。

import { createHash } from "node:crypto";
import type { Block, LogEvent, Plugin } from "uncarved";

export interface RepeatsOptions {
  /** 模型调用的次数，每次调用模型前加一（见 distro） */
  responses: { readonly calls: number };
  id?: string;
}

/** 提醒模型的失败次数 */
const WARN_AFTER = 2;

const hash = (content: Block[]) => createHash("sha1").update(JSON.stringify(content.map((b) => (b.kind === "text" ? b.text : b)))).digest("hex");

export function repeats(opts: RepeatsOptions): Plugin {
  const id = opts.id ?? "jade/repeats";
  /** 本次回复里已经出现的调用 */
  let current = { calls: -1, keys: new Set<string>() };
  /** 调用 → 连续失败的次数；成功一次就清掉 */
  const failures = new Map<string, number>();
  /** 每执行成功一个只读之外的调用、用户每发一条消息就加一 */
  let version = 0;
  /** 调用 → 上次成功执行后的 version 和结果 */
  const succeeded = new Map<string, { version: number; result: string }>();
  /** 已放行、还没执行完的调用是不是只读的（tool.after 里拿不到工具的声明） */
  const readOnly = new Map<string, boolean>();
  const key = (call: { name: string; input: unknown }) => `${call.name}\0${JSON.stringify(call.input)}`;
  const note = (text: string): Block => ({ kind: "text", text: `[Note from jade] ${text}`, origin: { by: "plugin", id }, trust: "trusted" });
  return {
    id,
    version: "0.2.0",
    kernel: "^0.1",
    needs: ["gate:tool.gate", "transform:tool.after", "observe:event"],
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
          readOnly.set(call.toolUseId, call.tool.effect === "read");
          return { decision: "abstain" };
        },
      },
      {
        kind: "transform",
        point: "tool.after",
        fn: (outcome) => {
          const k = key(outcome.call);
          const read = readOnly.get(outcome.call.toolUseId) ?? false;
          readOnly.delete(outcome.call.toolUseId);
          if (!outcome.isError) {
            failures.delete(k);
            const before = succeeded.get(k);
            // 只读之外的调用（包括这一个）可能改了东西，之后的调用都不算"什么都没变"
            if (!read) version++;
            const result = hash(outcome.content);
            const repeated = before !== undefined && before.version === (read ? version : version - 1) && before.result === result;
            succeeded.set(k, { version, result });
            if (!repeated) return;
            const text =
              "This exact call already ran earlier with the same result, and nothing has changed since (no edits, no other commands, no new message from the user). " +
              "Do not repeat it: use what you already have, or end your turn and tell the user where things stand.";
            return { ...outcome, content: [...outcome.content, note(text)] };
          }
          const n = (failures.get(k) ?? 0) + 1;
          failures.set(k, n);
          if (n < WARN_AFTER) return;
          const text = `This exact call has now failed ${n} times. Do not repeat it unchanged: change the approach, or tell the user what is blocking you.`;
          return { ...outcome, content: [...outcome.content, note(text)] };
        },
      },
      {
        kind: "observe",
        point: "event",
        // 用户发了新消息，可能就是要再来一遍（"再打开看看"），之前的记录都不算了
        fn: (e: LogEvent) => {
          if (e.type === "input.received" && (e as LogEvent<"input.received">).data.kind === "message") version++;
        },
      },
    ],
  };
}
