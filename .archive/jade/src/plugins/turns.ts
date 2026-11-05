// 内置插件参与宿主的轮次：用户消息发出前附加内容，一轮结束后决定接下来做什么。
// 这些本来写在宿主（main.ts）里：计划模式的告知和"执行这个计划？"、输出被截断后自动续写、上下文溢出后压缩重试、@ 引用的附件。
// 挪进内置插件之后，宿主只负责"发消息、跑一轮"，这些行为也能单独停用、单独测试。
// 这套接口还不对第三方插件开放，见 docs/design/jade-host-extensibility.md 的 2.3。

import type { Block, Message, Tool, TurnEndReason } from "uncarved";
import { contextWindowFromEnv, contextWindowInfo, isContextOverflow } from "../context.ts";
import { attachMentions } from "../mentions.ts";
import type { Choice } from "../ui/screen.ts";
import { dim, yellow } from "../ui/screen.ts";
import { clip } from "../ui/render.ts";
import { POLICY_KEY, type Mode, type Policy } from "./policy.ts";

/** 宿主给内置插件的界面：显示一行、让用户选一项 */
export interface TurnUI {
  interactive: boolean;
  log(text: string): void;
  select<T>(title: string, choices: Choice<T>[]): Promise<T | undefined>;
}

export interface TurnContext {
  sessionId: string;
  /** 日志里记下的派生数据（例如权限设置） */
  derived(key: string): unknown;
  /** 会话的最后一条消息 */
  lastMessage(): Message | undefined;
}

export interface TurnInfo {
  /** 这一轮的结束原因；没有正常结束（抛出了错误）时 undefined */
  end?: TurnEndReason;
  /** 这一轮出错时的错误信息 */
  error?: string;
  /** 最后一条消息还没有回复，可以重新请求 */
  canRetry: boolean;
  /** 这一次是用户（或者替用户）发的消息开始的，不是 /retry */
  byMessage: boolean;
  /** 这一次输入之后已经接着跑了几轮 */
  followUps: number;
  /** 用户已经排了别的输入 */
  queued: boolean;
}

export type FollowUp =
  /** 重新请求（例如压缩之后） */
  | { kind: "retry" }
  /** 发一条 [Note from jade] 让模型接着做 */
  | { kind: "continue"; note: string }
  /** 替用户发一条消息；给了 mode 时先切换权限模式 */
  | { kind: "say"; text: string; mode?: Mode };

export interface TurnParticipant {
  /** 用户消息发出前：notes 作为 [Note from jade] 放在用户的话前面，blocks 附在后面。只附加，不改写用户的话 */
  beforeMessage?(text: string, ctx: TurnContext): Promise<{ notes?: string[]; blocks?: Block[] } | undefined>;
  /** 一轮结束后：接下来做什么；undefined 表示不用做什么 */
  afterTurn?(turn: TurnInfo, ctx: TurnContext): Promise<FollowUp | undefined>;
}

/** 宿主用的：按内置插件的顺序问每个参与者。出错的只提示，不影响别的 */
export interface Turns {
  beforeMessage(text: string, ctx: TurnContext): Promise<{ notes: string[]; blocks: Block[] }>;
  /** 第一个给出下一步的生效 */
  afterTurn(turn: TurnInfo, ctx: TurnContext): Promise<FollowUp | undefined>;
}

export function turns(parts: { id: string; part: TurnParticipant }[], warn: (text: string) => void): Turns {
  const failed = (id: string, err: unknown) => warn(`[warning] ${id}: ${err instanceof Error ? err.message : String(err)}`);
  return {
    async beforeMessage(text, ctx) {
      const out = { notes: [] as string[], blocks: [] as Block[] };
      for (const { id, part } of parts) {
        try {
          const r = await part.beforeMessage?.(text, ctx);
          out.notes.push(...(r?.notes ?? []));
          out.blocks.push(...(r?.blocks ?? []));
        } catch (err) {
          failed(id, err);
        }
      }
      return out;
    },
    async afterTurn(turn, ctx) {
      for (const { id, part } of parts) {
        try {
          const next = await part.afterTurn?.(turn, ctx);
          if (next) return next;
        } catch (err) {
          failed(id, err);
        }
      }
      return undefined;
    },
  };
}

// ---------- jade/policy：计划模式 ----------

const PLAN_ON =
  "The session is now in plan mode. Investigate with read-only tools (and the task tool for broad searches); do not try to modify files " +
  "or run commands that change anything, such calls are denied. When you understand the task, reply with a concise, concrete plan: " +
  "the files to change and how, in order, any open questions, and how you will verify the result. Then stop and wait for the user's approval.";
const PLAN_OFF = "The session has left plan mode; you can now change files and run commands (subject to the user's approval settings).";

/**
 * 进入、离开计划模式时随下一条消息告诉模型；计划模式下模型给出计划、这一轮正常结束后，问用户是否按计划执行。
 * 用户已经排了别的输入、不能交互、这一轮中途才切到计划模式（模型并不知道要给计划）时不问
 */
export function planTurns(pol: Policy, ui: TurnUI): TurnParticipant {
  /** 最近一次告诉模型的权限模式 */
  let announced: Mode | undefined;
  const mode = (ctx: TurnContext) => pol.settings({ [POLICY_KEY]: ctx.derived(POLICY_KEY) }).mode as Mode;
  return {
    async beforeMessage(_text, ctx) {
      const now = mode(ctx);
      const notes = now === "plan" && announced !== "plan" ? [PLAN_ON] : now !== "plan" && announced === "plan" ? [PLAN_OFF] : [];
      announced = now;
      return { notes };
    },
    async afterTurn(turn, ctx) {
      if (!turn.byMessage || turn.end !== "end" || turn.queued || !ui.interactive) return undefined;
      if (mode(ctx) !== "plan" || announced !== "plan") return undefined;
      const last = ctx.lastMessage();
      if (last?.role !== "assistant" || !last.content.some((b) => b.kind === "text" && b.text.trim())) return undefined;
      const choice = await ui.select("Execute this plan?", [
        { label: "Yes, in auto mode", value: "auto" as const, hint: "edits and safe commands run without asking" },
        { label: "Yes, and ask before each edit", value: "ask" as const, hint: "mode ask" },
        { label: "No, keep planning", value: "plan" as const, hint: "type what to change" },
      ]);
      if (!choice || choice === "plan") return undefined;
      return { kind: "say", text: "The plan is approved. Implement it now.", mode: choice };
    },
  };
}

// ---------- jade/continue：输出被截断后接着做 ----------

/** 每次输入最多自动续写几次 */
export const MAX_CONTINUES = 3;
export const CONTINUE_NOTE =
  "Your previous reply was cut off because it reached the output token limit. Continue from where you stopped. " +
  "If you were writing a large file or edit, split it into several smaller write_file/edit_file calls.";

/** 回复被输出上限截断：让模型接着做，而不是把半截任务丢给用户 */
export function continueTurns(ui: TurnUI): TurnParticipant {
  let count = 0;
  return {
    async afterTurn(turn) {
      if (turn.followUps === 0) count = 0;
      if (turn.end !== "max_tokens" || count >= MAX_CONTINUES) return undefined;
      count++;
      ui.log(dim(`[asking the model to continue (${count}/${MAX_CONTINUES})]`));
      return { kind: "continue", note: CONTINUE_NOTE };
    },
  };
}

// ---------- jade/compact：上下文溢出后压缩重试 ----------

/** 请求超出了上下文窗口（窗口估大了，或者一次读进来太多）：压缩后重试一次 */
export function overflowTurns(compact: { request(): void }, ui: TurnUI): TurnParticipant {
  let retried = false;
  return {
    async afterTurn(turn) {
      if (turn.followUps === 0) retried = false;
      if (retried || !turn.canRetry || !isContextOverflow(turn.error)) return undefined;
      retried = true;
      ui.log(
        yellow("[the request exceeded the model's context window; compacting the history and retrying]") +
          (contextWindowInfo().source === "env" ? "" : dim(`\n[jade assumed a ${contextWindowFromEnv()}-token window; set the real one with /model → context window]`)),
      );
      compact.request();
      return { kind: "retry" };
    },
  };
}

// ---------- jade/mentions：@ 引用的文件随消息附上 ----------

/** @ 引用的文件和目录：内容随消息发出，模型不用再读一遍 */
export function mentionTurns(opts: { cwd: string; tools: () => Tool[]; ui: TurnUI }): TurnParticipant {
  return {
    async beforeMessage(text, ctx) {
      const refs = await attachMentions(text, { cwd: opts.cwd, tools: opts.tools(), sessionId: ctx.sessionId, signal: AbortSignal.timeout(30_000) });
      for (const f of refs.failed) opts.ui.log(yellow(`[@${f.path} not attached: ${clip(f.reason, 200)}]`));
      if (refs.attached.length) opts.ui.log(dim(`[attached ${refs.attached.map((p) => `@${p}`).join(", ")}]`));
      return { blocks: refs.blocks };
    },
  };
}
