// jade/repeats：模型常常把同一个调用原样再发一遍。
//
// 同一次回复里参数完全相同的调用直接拒绝，不用让用户再批准一次；
// 同一个调用连续失败、其间什么都没变时，在结果后面提醒模型它已经失败过几次，别再原样重试
// （改了文件再跑同一条测试命令是正常的"修了再验证"，从头计数）；
// 同一个调用已经成功执行过，之后什么都没变（没有执行过只读之外的调用，用户也没有发新消息），
// 再执行一遍结果也完全一样时，在结果后面提醒模型这是重复的（反复读同一个文件、反复打开同一个网页）。
// 不拒绝：也可能是在等外面的东西变化，只提醒。压缩插件清理或总结了历史后，之前的结果可能已经不在上下文里，都不算重复。
// 打开文件给用户看（start、xdg-open……）会弹出新窗口：这一轮里打开过、之后什么都没改，再打开就直接拒绝。
// write_file 之后什么都没改又读回同一个文件，提醒模型内容就是它写的那些。
// 这些记录只在本会话的作用域里：恢复会话后从零开始，最多多重试一轮。
//
// 从旧 jade 的 plugins/repeats.ts 移植。

import { createHash } from "node:crypto";
import path from "node:path";
import type { Block, GateResult, LocalHookSpec, LogEvent } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";

const ID = "jade/repeats";
/** jade/compact 记录压缩结果用的派生数据键（旧 jade 的约定）：记一次就说明历史被压缩过 */
export const COMPACT_KEY = "jade/compact";

/** 只打开一个文件或网址的命令：start "" x、start x、xdg-open x、open x、explorer x */
const OPEN = /^\s*(?:start\s+""|start|xdg-open|open|explorer(?:\.exe)?)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'&|;<>]+))\s*$/i;

/** bash 调用打开的目标（规范化后），不是打开命令时是 undefined */
export function openTarget(call: { name: string; input: unknown }, cwd: string): string | undefined {
  if (call.name !== "bash") return undefined;
  const command = (call.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return undefined;
  const m = OPEN.exec(command);
  const target = m && (m[1] ?? m[2] ?? m[3]);
  if (!target) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : normalize(cwd, target);
}

function normalize(cwd: string, p: string): string {
  const full = path.resolve(cwd, p);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/** 提醒模型的失败次数 */
const WARN_AFTER = 2;

const hash = (content: Block[]) => createHash("sha1").update(JSON.stringify(content.map((b) => (b.kind === "text" ? b.text : b)))).digest("hex");

/** 会话里的 hook：model.before 数回复次数，tool.gate 拒绝重复，tool.after 加提醒，event 在用户发消息、压缩后重新计 */
export function repeatsHooks(opts: { cwd: string; id?: string }): LocalHookSpec[] {
  const id = opts.id ?? ID;
  const cwd = opts.cwd;
  /** 模型调用的次数，每次调用模型前加一 */
  let calls = 0;
  /** 本次回复里已经出现的调用；mutates：其中有只读之外、也不是打开文件的调用 */
  let current = { calls: -1, keys: new Set<string>(), mutates: false };
  /** 调用 → 连续失败的次数和最近一次失败时的 version；成功一次就清掉 */
  const failures = new Map<string, { n: number; version: number }>();
  /** 每执行成功一个只读之外的调用、用户每发一条消息、历史每压缩一次就加一 */
  let version = 0;
  /** 调用 → 上次成功执行后的 version 和结果 */
  const succeeded = new Map<string, { version: number; result: string }>();
  /** 已放行、还没执行完的调用是不是只读的（tool.after 里拿不到工具的声明） */
  const readOnly = new Map<string, boolean>();
  /** 每执行成功一个只读之外、也不是打开文件的调用就加一（可能改了文件） */
  let changes = 0;
  /** 本轮打开过的目标 → 打开时的 changes；用户发消息时清空 */
  const opened = new Map<string, number>();
  /** 本轮用 write_file 写过的文件 → 写完时的 changes；用户发消息时清空 */
  const written = new Map<string, number>();
  const key = (call: { name: string; input: unknown }) => `${call.name}\0${JSON.stringify(call.input)}`;
  const note = (text: string): Block => ({ kind: "text", text: `[Note from jade] ${text}`, origin: { by: "plugin", id }, trust: "trusted" });
  return [
    {
      kind: "transform",
      point: "model.before",
      fn: () => {
        calls++;
      },
    },
    {
      kind: "gate",
      point: "tool.gate",
      fn: (call): GateResult => {
        if (current.calls !== calls) current = { calls, keys: new Set(), mutates: false };
        const k = key(call);
        if (current.keys.has(k)) {
          return { decision: "deny", reason: "This call is identical to an earlier call in the same response and was not run; use that call's result." };
        }
        current.keys.add(k);
        const target = openTarget(call, cwd);
        // 同一次回复里排在前面的调用可能改了它，还没执行，不拒绝
        if (target !== undefined && opened.get(target) === changes && !current.mutates) {
          return {
            decision: "deny",
            reason:
              "This was already opened for the user earlier in this turn and nothing has changed since, so it was not opened again (it is still open). " +
              "End your turn and tell the user what you changed.",
          };
        }
        if (target === undefined && call.tool.effect !== "read") current.mutates = true;
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
          const target = openTarget(outcome.call, cwd);
          if (target !== undefined) opened.set(target, changes);
          else if (!read) changes++;
          const file = (outcome.call.input as { path?: unknown } | null)?.path;
          if (outcome.call.name === "write_file" && typeof file === "string") written.set(normalize(cwd, file), changes);
          const readBack =
            outcome.call.name === "read_file" && typeof file === "string" && written.get(normalize(cwd, file)) === changes
              ? note("You wrote this file with write_file earlier and nothing has changed since: its content is exactly what you gave. Do not read files back to check them.")
              : undefined;
          const before = succeeded.get(k);
          // 只读之外的调用（包括这一个）可能改了东西，之后的调用都不算"什么都没变"
          if (!read) version++;
          const result = hash(outcome.content);
          const repeated = before !== undefined && before.version === (read ? version : version - 1) && before.result === result;
          succeeded.set(k, { version, result });
          if (!repeated) return readBack ? { ...outcome, content: [...outcome.content, readBack] } : undefined;
          const text =
            "This exact call already ran earlier with the same result, and nothing has changed since (no edits, no other commands, no new message from the user). " +
            "Do not repeat it: use what you already have, or end your turn and tell the user where things stand.";
          return { ...outcome, content: [...outcome.content, note(text)] };
        }
        const prev = failures.get(k);
        // 上次失败之后改过东西（修了代码再跑测试），重新计数
        const n = prev && prev.version === version ? prev.n + 1 : 1;
        failures.set(k, { n, version });
        if (n < WARN_AFTER) return;
        const text = `This exact call has now failed ${n} times. Do not repeat it unchanged: change the approach, or tell the user what is blocking you.`;
        return { ...outcome, content: [...outcome.content, note(text)] };
      },
    },
    {
      kind: "observe",
      point: "event",
      // 用户发了新消息，可能就是要再来一遍（"再打开看看"），之前的记录都不算了；
      // 压缩之后模型可能已经看不到之前的结果，重新执行不算重复
      fn: (e: LogEvent) => {
        if (e.type === "derived.recorded" && (e as LogEvent<"derived.recorded">).data.key === COMPACT_KEY) version++;
        if (e.type === "input.received" && (e as LogEvent<"input.received">).data.kind === "message") {
          version++;
          opened.clear();
          written.clear();
        }
      },
    },
  ];
}

export default definePlugin({
  session(ctx) {
    for (const h of repeatsHooks({ cwd: ctx.cwd, id: ctx.plugin })) ctx.kernel.hook(h);
  },
});
