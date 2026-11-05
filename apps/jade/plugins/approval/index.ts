// jade/approval：审批。tool.before 把路径统一成绝对路径，tool.gate 按模式和规则决定，要问时经 ui@1 问用户。
//
// 没有这个插件（停用、坏掉、被隔离）时，核心的兜底关卡拒绝所有非只读工具（第 7 节），所以这里出错不会放行。
// 用户选的"总是允许"记进日志（derived），恢复会话后仍然有效；模式是进程级的，来自配置，可以经 approval@1 改。

import type { GatedToolCall } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import { describeRule, MODES, policy, type AllowRule, type Mode } from "./policy.ts";

/** approval@1 */
export interface Approval {
  mode(): Mode;
  setMode(mode: Mode): void;
}

/** derived 里保存"总是允许"规则的键 */
const RULES_KEY = "jade/approval/rules";
/** 等用户回答的时限：内核要求 hook 有有限的超时，超时按拒绝处理 */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_CHARS = 2000;

let mode: Mode = "ask";

export default definePlugin({
  process(ctx) {
    const configured = ctx.config.mode;
    if (typeof configured === "string" && (MODES as readonly string[]).includes(configured)) mode = configured as Mode;
    else if (configured !== undefined) {
      ctx.service<UI>("ui@1")?.notify(`jade/approval: mode must be one of ${MODES.join(", ")}, got ${JSON.stringify(configured)}; using ask`, "warning");
    }
    ctx.provide("approval@1", {
      mode: () => mode,
      setMode(next: Mode) {
        if (!(MODES as readonly string[]).includes(next)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
        mode = next;
      },
    } satisfies Approval);
  },

  session(ctx) {
    const rules = policy({ cwd: ctx.cwd });
    const ui = ctx.service<UI>("ui@1");
    let warned = false;
    /** 本进程里刚选的"总是允许"：并发的关卡拿到的 derived 是各自开始时的快照，可能还没有它 */
    const added: AllowRule[] = [];
    /** 一次只问一个问题；排在后面的问之前重新判断，前面刚选的"总是允许"可能已经覆盖它 */
    let asking: Promise<unknown> = Promise.resolve();

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      fn: (call) => ({ ...call, input: rules.absolutePath(call.input) }),
    });
    ctx.kernel.hook({
      kind: "gate",
      point: "tool.gate",
      timeoutMs: ASK_TIMEOUT_MS,
      fn: async (call, hook) => {
        const saved = () => {
          const logged = (hook.derived[RULES_KEY] as AllowRule[] | undefined) ?? [];
          return [...logged, ...added.filter((r) => !logged.some((l) => JSON.stringify(l) === JSON.stringify(r)))];
        };
        const result = rules.decide(call, { mode, rules: saved() });
        if (result.decision !== "ask") return result;
        if (!ui?.interactive) {
          if (!warned) {
            warned = true;
            ui?.notify(
              `${call.name} needs approval, but this jade cannot ask. To let it make changes in the working directory, ` +
                `set {"jade/approval": {"mode": "auto"}} in ${ctx.home}/config.json`,
              "warning",
            );
          }
          return { decision: "deny", reason: `${call.name} needs the user's approval, but nobody can approve it in this non-interactive run. Do not retry it; tell the user what you wanted to do.` };
        }
        const turn = asking.then(async () => {
          const again = rules.decide(call, { mode, rules: saved() });
          if (again.decision !== "ask") return again;
          const rule = rules.ruleFor(call);
          const answer = await ui.select(
            {
              title: `Allow ${call.name}?`,
              detail: detail(call),
              options: [
                { label: "Allow once", value: "once" },
                { label: `Always allow ${describeRule(rule)} in this session`, value: "always" },
                { label: "Deny", value: "deny" },
              ],
            },
            hook.signal,
          );
          if (answer === "always") {
            added.push(rule);
            await hook.record(RULES_KEY, saved());
            return { decision: "allow" as const };
          }
          if (answer === "once") return { decision: "allow" as const };
          return { decision: "deny" as const, reason: "The user denied this tool call. Do not retry it unchanged: adjust, or ask what to do instead." };
        });
        asking = turn.catch(() => {});
        return turn;
      },
    });
  },
});

/** 给用户看的调用内容：命令、路径和要写的内容，太长的截断 */
function detail(call: GatedToolCall): string {
  const input = call.input as Record<string, unknown> | null;
  let text: string;
  if (typeof input?.command === "string") text = input.command;
  else if (typeof input?.path === "string" && typeof input.content === "string") text = `${input.path}\n\n${input.content}`;
  else if (typeof input?.path === "string" && typeof input.old_string === "string") text = `${input.path}\n\n- ${input.old_string}\n+ ${String(input.new_string)}`;
  else text = JSON.stringify(input, null, 2);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… (${text.length - MAX_DETAIL_CHARS} more characters)` : text;
}
