// jade/modes：权限模式的切换。模式本身归 jade/approval（approval@1），这里提供切换方式和给前端显示的状态：
// Shift+Tab 在 ask → auto → plan 之间轮换，/mode 查看或选择，modes@1 让前端显示当前模式、在模式变化时更新。
//
// 计划模式的两件事也在这里：
// - 在 plan 模式时经 prompts@1 往系统提示词里加一段，告诉模型先给计划、不要改东西（切出去时去掉）
// - propose_plan 工具：模型写好要执行的计划后调用它，问用户要不要执行；批准了就换模式，工具结果告诉模型开始做。
//   由模型声明"这是要执行的计划"，追问、回答问题、只要计划本身（比如健身计划）的回复不会被当成计划去问。
//   用户的选择在工具结果里，会话日志里看得到

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Tool } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";
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

/** 计划模式时加进系统提示词的段落；不能问用户（-p、非终端）时没有 propose_plan，只让模型给出计划后停下 */
export function planNote(canPropose: boolean): string {
  return (
    "The session is in plan mode. Investigate with read-only tools (and the task tool for broad searches); do not try to modify files " +
    "or run commands that change anything, such calls are denied. If the request is unclear in a way that changes the plan, ask the user first. " +
    "When the task needs changes made (files edited, commands run), reply with a concise, concrete plan: the steps in order (for code, the files to change and how), " +
    "any open questions, and how you will verify the result. " +
    (canPropose
      ? "Then call propose_plan so the user can approve it. If nothing needs to be executed (a question, or the plan itself is the answer the user wants), " +
        "just answer and do not call propose_plan."
      : "Then stop and wait for the user's approval.")
  );
}

/** 批准计划之后工具结果里的那句 */
export const APPROVED_NOTE = "The user approved the plan. Implement it now.";
/** 没批准时工具结果里的那句 */
export const NOT_APPROVED = "The user did not approve the plan yet. End your turn and wait for their feedback.";

export const PROPOSE_PLAN = "propose_plan";

/** propose_plan：问用户要不要执行刚写好的计划，批准了就换到用户选的模式 */
export function proposePlanTool(approval: Approval, ui: UI): Tool {
  return {
    name: PROPOSE_PLAN,
    description:
      "In plan mode, ask the user to approve the plan you just wrote in your reply, and wait for the answer. Write the full plan in your reply text first; " +
      "call this only for a plan of changes to execute, not for questions, clarifications or answers that need nothing executed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    // 不碰文件和进程：plan 模式下不用批准
    effect: "read",
    concurrency: "exclusive",
    idempotent: false,
    async execute(_input, ctx) {
      if (approval.mode() !== "plan") return { content: "The session is not in plan mode; no approval is needed.", isError: true };
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
      ctx.signal.throwIfAborted();
      if (choice !== "auto" && choice !== "ask") return { content: NOT_APPROVED };
      setMode(approval, choice);
      return { content: `${APPROVED_NOTE} (mode: ${choice})` };
    },
  };
}

/** 模式变化时通知前端和会话里的订阅者（模块每个进程只加载一次，进程级和会话级共用） */
const listeners = new Set<(mode: string) => void>();

/**
 * 用户选的模式记在 $JADE_HOME/mode.json，下次启动接着用（比配置里的 mode 优先）。
 * plan 是一次任务里的，yolo 不该悄悄带到下一次启动：这两个不记
 */
const REMEMBERED = new Set(["ask", "auto", "readonly"]);
let modeFile: string | undefined;
/** 记下的模式只在第一个可交互的会话里恢复一次：jade -p 这类不能问用户的运行一直用配置的模式 */
let restored = false;

function readRemembered(file: string): string | undefined {
  try {
    const mode = (JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown }).mode;
    return typeof mode === "string" && REMEMBERED.has(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

function remember(mode: string): void {
  if (!modeFile || !REMEMBERED.has(mode)) return;
  try {
    // 同步写：连按几次 Shift+Tab 时，文件里留下的一定是最后一次
    mkdirSync(path.dirname(modeFile), { recursive: true });
    writeFileSync(modeFile, `${JSON.stringify({ mode })}\n`);
  } catch {
    // 记不下只是下次从配置的模式开始
  }
}

function setMode(approval: Approval, mode: string): void {
  if (mode === approval.mode()) return;
  approval.setMode(mode as ReturnType<Approval["mode"]>);
  remember(mode);
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
    modeFile = path.join(ctx.home, "mode.json");
    restored = false;
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

    if (!restored && ui?.interactive && modeFile) {
      restored = true;
      const saved = readRemembered(modeFile);
      if (saved) setMode(approval, saved);
    }

    // 能问用户时才有 propose_plan；它只在 plan 模式下发给模型
    const canPropose = !!ui?.interactive;
    if (canPropose) ctx.kernel.tool(proposePlanTool(approval, ui!));
    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      fn: (req) => (approval.mode() === "plan" ? req : { ...req, tools: req.tools.filter((t) => t.name !== PROPOSE_PLAN) }),
    });

    // 计划模式的说明跟着模式进出系统提示词
    let note: (() => void) | undefined;
    const sync = () => {
      const plan = approval.mode() === "plan";
      if (plan && !note && prompts) note = prompts.add({ text: planNote(canPropose), stable: false });
      else if (!plan && note) {
        note();
        note = undefined;
      }
    };
    sync();
    const onChange = () => sync();
    listeners.add(onChange);
    ctx.effect(() => () => void listeners.delete(onChange));
  },
});
