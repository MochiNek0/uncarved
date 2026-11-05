// jade/approval：审批。tool.before 把路径统一成绝对路径，tool.gate 按模式和规则决定，要问时经 ui@1 问用户。
//
// 没有这个插件（停用、坏掉、被隔离）时，核心的兜底关卡拒绝所有非只读工具（第 7 节），所以这里出错不会放行。
// 用户选的"总是允许"记进日志（derived），恢复会话后仍然有效；模式是进程级的，来自配置，可以经 approval@1 改。

import type { GatedToolCall } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Renderers } from "../renderers/index.ts";
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
/** 等工具的审批预览的时限，过了就用默认的 detail */
const PREVIEW_TIMEOUT_MS = 5000;

let mode: Mode = "ask";
/** 配置里写错的模式：第一个会话打开时告诉用户（process 里可能还拿不到 ui@1：它的提供者可能排在后面激活） */
let badMode: string | undefined;

export default definePlugin({
  process(ctx) {
    const configured = ctx.config.mode;
    if (typeof configured === "string" && (MODES as readonly string[]).includes(configured)) mode = configured as Mode;
    else if (configured !== undefined) badMode = JSON.stringify(configured);
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
    if (badMode !== undefined) {
      ui?.notify(`jade/approval: mode must be one of ${MODES.join(", ")}, got ${badMode}; using ask`, "warning");
      badMode = undefined;
    }
    const renderers = ctx.service<Renderers>("renderers@1");
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
              detail: (await preview(renderers, call)) ?? detail(call),
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

/**
 * 工具自己登记的审批预览（例如文件修改的 diff）。没有登记、返回的不是文字、或者出错时返回 undefined，
 * 用下面的 detail：预览是别的插件的代码，它坏了不能让审批卡住或失败
 */
async function preview(renderers: Renderers | undefined, call: GatedToolCall): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 预览可能读文件、算 diff；一直不返回时也要能问用户
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PREVIEW_TIMEOUT_MS);
    });
    const text = await Promise.race([Promise.resolve(renderers?.forTool(call.name)?.renderer.preview?.(call.input)), late]);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

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
