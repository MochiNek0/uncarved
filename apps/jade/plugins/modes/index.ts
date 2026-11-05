// jade/modes：权限模式的切换。模式本身归 jade/approval（approval@1），这里提供切换方式和给前端显示的状态：
// Shift+Tab 在 ask → auto → plan 之间轮换，/mode 查看或选择，modes@1 让前端显示当前模式、在模式变化时更新。
//
// 计划模式的两件事也在这里：
// - 在 plan 模式时经 prompts@1 往系统提示词里加一段，告诉模型先给计划、不要改东西（切出去时去掉）
// - 这一轮模型给出计划、正常结束后，问用户要不要按计划执行；批准了就先换模式再替用户发一句"开始做"

import type { Block } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Approval } from "../approval/index.ts";
import type { Commands } from "../commands/index.ts";
import type { Keys } from "../keys/index.ts";
import type { Prompts } from "../prompts/index.ts";

/** modes@1 */
export interface Modes {
  current(): string;
  list(): { name: string; description: string }[];
  /** 换模式，从下一个工具调用起生效 */
  set(mode: string): void;
  /** 换到轮换顺序里的下一个 */
  cycle(): string;
  /** 模式变化时调用，返回取消订阅的函数；调用方关闭时自动取消 */
  subscribe(fn: (mode: string) => void): () => void;
}

export const DESCRIPTIONS: Record<string, string> = {
  ask: "ask before edits and commands",
  auto: "edits in this directory and harmless commands run without asking; others still ask",
  plan: "change nothing: research read-only and propose a plan",
  readonly: "change nothing",
  yolo: "never ask",
};
const CYCLE = ["ask", "auto", "plan"];

/** 计划模式时加进系统提示词的段落 */
export const PLAN_NOTE =
  "The session is in plan mode. Investigate with read-only tools (and the task tool for broad searches); do not try to modify files " +
  "or run commands that change anything, such calls are denied. When you understand the task, reply with a concise, concrete plan: " +
  "the files to change and how, in order, any open questions, and how you will verify the result. Then stop and wait for the user's approval.";

/** 批准计划之后替用户发的那句 */
export const APPROVED_NOTE = "The plan is approved. Implement it now.";

/** 模式变化时通知前端和会话里的订阅者（模块每个进程只加载一次，进程级和会话级共用） */
const listeners = new Set<(mode: string) => void>();

function setMode(approval: Approval, mode: string): void {
  if (mode === approval.mode()) return;
  approval.setMode(mode as ReturnType<Approval["mode"]>);
  for (const fn of [...listeners]) {
    try {
      fn(mode);
    } catch {
      // 订阅者的错误经过膜归它自己，不影响别的订阅者
    }
  }
}

export default definePlugin({
  process(ctx) {
    const approval = ctx.require<Approval>("approval@1");
    const set = (mode: string) => setMode(approval, mode);
    const cycle = () => {
      const next = CYCLE[(CYCLE.indexOf(approval.mode()) + 1) % CYCLE.length]!;
      set(next);
      return next;
    };
    const list = () => Object.entries(DESCRIPTIONS).map(([name, description]) => ({ name, description }));

    ctx.provide("modes@1", (caller): Modes => ({
      current: () => approval.mode(),
      list,
      set,
      cycle,
      subscribe(fn) {
        listeners.add(fn);
        const off = () => void listeners.delete(fn);
        caller.onDispose(off);
        return off;
      },
    }));

    ctx.service<Keys>("keys@1")?.register({ key: "shift+tab", description: "cycle ask/auto/plan", run: () => void cycle() });
    ctx.service<Commands>("commands@1")?.register({
      name: "mode",
      args: `[${Object.keys(DESCRIPTIONS).join("|")}]`,
      description: "show or change the permission mode",
      instant: true,
      async run(args, c) {
        let want: string | undefined = args.trim() || undefined;
        if (!want) {
          want = await c.ui.select(
            { title: "Permission mode", options: list().map((m) => ({ label: m.name, value: m.name, hint: m.name === approval.mode() ? "current" : m.description })) },
            c.signal,
          );
          if (!want) return;
        }
        if (!(want in DESCRIPTIONS)) return `unknown mode ${want}; one of ${Object.keys(DESCRIPTIONS).join(", ")}`;
        set(want);
        return `mode: ${approval.mode()}`;
      },
    });
  },

  session(ctx) {
    const approval = ctx.require<Approval>("approval@1");
    const prompts = ctx.service<Prompts>("prompts@1");
    const ui = ctx.service<UI>("ui@1");

    // 计划模式的说明跟着模式进出系统提示词
    let note: (() => void) | undefined;
    const sync = () => {
      const plan = approval.mode() === "plan";
      if (plan && !note && prompts) note = prompts.add({ text: PLAN_NOTE, stable: false });
      else if (!plan && note) {
        note();
        note = undefined;
      }
    };
    sync();
    const onChange = () => sync();
    listeners.add(onChange);
    ctx.effect(() => () => void listeners.delete(onChange));

    /** 这一轮的请求里模型看到过计划模式的说明（中途才切到计划模式时没有） */
    let sawPlan = false;
    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      fn: (req) => {
        sawPlan = approval.mode() === "plan";
        return req;
      },
    });

    /** 最近一次模型回复的正文：没有文字的（只有工具调用）不算计划 */
    let lastReply = "";
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "model.responded") {
          lastReply = (e.data as { content: Block[] }).content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
          return;
        }
        if (e.type !== "turn.ended") return;
        // 这一轮模型看到的是计划模式、正常结束、给出了文字，才发现要问。
        // afterTurn 要在这里登记：会话空闲时登记会马上执行
        const plan = sawPlan;
        const text = lastReply;
        const ended = (e.data as { reason?: string }).reason === "end";
        sawPlan = false;
        lastReply = "";
        if (!ended || !plan || !text.trim() || approval.mode() !== "plan") return;
        ctx.session.afterTurn(async () => {
          if (!ui?.interactive) return;
          const choice = await ui.select(
            {
              title: "Execute this plan?",
              options: [
                { label: "Yes, in auto mode", value: "auto", hint: "edits and safe commands run without asking" },
                { label: "Yes, and ask before each edit", value: "ask", hint: "mode ask" },
                { label: "No, keep planning", value: "plan", hint: "type what to change" },
              ],
            },
            ctx.signal,
          );
          if (choice !== "auto" && choice !== "ask") return;
          setMode(approval, choice);
          const content: Block[] = [{ kind: "text", text: APPROVED_NOTE, origin: { by: "plugin", id: ctx.plugin }, trust: "trusted" }];
          // 和 jade/continue 一样：不能 await，afterTurn 跑完之后会话才处理排队的输入
          ctx.session.send({ kind: "message", content }).catch(() => {});
        });
      },
    });
  },
});
