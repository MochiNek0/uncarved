// jade/approval：审批。tool.before 把路径统一成绝对路径，tool.gate 按模式和规则决定，要问时经 ui@1 问用户。
// auto 模式下规则判断不了、本来要问的调用先让模型审一次（review.ts）：它只能放行或转给用户，不能替用户拒绝。
//
// 没有这个插件（停用、坏掉、被隔离）时，核心的兜底关卡拒绝所有非只读工具（第 7 节），所以这里出错不会放行。
// 用户选的"总是允许"记进日志（derived），恢复会话后仍然有效；模式是进程级的，来自配置，可以经 approval@1 改。

import path from "node:path";
import type { GatedToolCall, Message } from "uncarved";
import { definePlugin, type Caller, type SelectRequest, type UI } from "../../src/api.ts";
import type { Models } from "../models/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { describeRule, MODES, policy, type AllowRule, type Mode } from "./policy.ts";
import { reviewer, type Review } from "./review.ts";

/** approval@1 */
export interface Approval {
  mode(): Mode;
  setMode(mode: Mode): void;
  /** 读这个目录（绝对路径）里的文件不用问，例如 skill 的目录。返回撤销函数，调用方的作用域关闭时自动撤销。项目层插件不能用 */
  allowRead(dir: string): () => void;
  /** 这个目录（绝对路径）和工作目录同样对待：auto 模式下在里面改文件不用问，例如会话的临时目录。返回撤销函数，调用方的作用域关闭时自动撤销。项目层插件不能用 */
  allowWrite(dir: string): () => void;
  /**
   * 登记一个审批渠道（例如聊天机器人）：要问用户时，问题同时交给终端和所有渠道，先回答的算数，
   * 其余的经 signal 收到中止。渠道返回 undefined、不认识的值或出错，算它不回答，不算拒绝；
   * 终端里取消照旧算拒绝。有渠道时，不能提问的前端（-p）也会问。返回撤销函数，调用方的作用域关闭时自动撤销。
   * 项目层插件不能用
   */
  addApprover(approver: Approver): () => void;
  /**
   * 这个只读调用（例如子 Agent 的）在会话 session 里能不能不问就执行：按该会话"总是允许"的规则、
   * allowRead/allowWrite 登记的目录和 yolo 模式判断。会话不存在或不是只读调用时为 false
   */
  allows(session: string, call: GatedToolCall): boolean;
}

/** 审批的回答：允许一次、本会话里总是允许、拒绝 */
export type Answer = "once" | "always" | "deny";
export type Approver = (request: SelectRequest<Answer>, signal: AbortSignal) => Promise<Answer | undefined>;
const ANSWERS: readonly string[] = ["once", "always", "deny"] satisfies Answer[];

/** derived 里保存"总是允许"规则的键 */
const RULES_KEY = "jade/approval/rules";
/** 等用户回答的默认时限：内核要求 hook 有有限的超时，超时按拒绝处理。配置 askTimeoutMinutes 可以改 */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** askTimeoutMinutes 的上限：内核的定时器最长约 24.8 天 */
const MAX_ASK_TIMEOUT_MINUTES = 7 * 24 * 60;
const MAX_DETAIL_CHARS = 2000;
/** 等工具的审批预览的时限，过了就用默认的 detail */
const PREVIEW_TIMEOUT_MS = 5000;

/**
 * 带 URL 的只读工具审查放行之后，完全相同的调用不再审查。不按主机记：同一主机上换一个路径或查询参数
 * 就能把本地数据带出去，正是审查要拦的
 */
const reviewedKey = (call: GatedToolCall): string | undefined => {
  const url = (call.input as { url?: unknown } | null)?.url;
  if (call.tool.effect !== "read" || typeof url !== "string") return undefined;
  return `${call.name} ${JSON.stringify(call.input)}`;
};

let mode: Mode = "ask";
/** 配置里写错的模式：第一个会话打开时告诉用户（process 里可能还拿不到 ui@1：它的提供者可能排在后面激活） */
let badMode: string | undefined;
let askTimeoutMs = ASK_TIMEOUT_MS;
/** 配置里写错的 askTimeoutMinutes，和 badMode 一样在第一个会话打开时告诉用户 */
let badTimeout: string | undefined;
/** 经 allowRead 登记的目录；policy 每次判断时读它 */
const readRoots: string[] = [];
/** 经 allowWrite 登记的目录；policy 每次判断时读它 */
const writeRoots: string[] = [];
/** 经 addApprover 登记的审批渠道 */
const approvers = new Set<Approver>();
/** 打开着的会话：会话 id → 判断只读调用能不能不问就执行（allows） */
const sessionChecks = new Map<string, (call: GatedToolCall) => boolean>();

export default definePlugin({
  process(ctx) {
    const configured = ctx.config.mode;
    if (typeof configured === "string" && (MODES as readonly string[]).includes(configured)) mode = configured as Mode;
    else if (configured !== undefined) badMode = JSON.stringify(configured);
    const minutes = ctx.config.askTimeoutMinutes;
    askTimeoutMs = ASK_TIMEOUT_MS;
    badTimeout = undefined;
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_ASK_TIMEOUT_MINUTES) askTimeoutMs = minutes * 60_000;
    else if (minutes !== undefined) badTimeout = JSON.stringify(minutes);
    ctx.provide("approval@1", (caller): Approval => ({
      mode: () => mode,
      setMode(next: Mode) {
        if (!(MODES as readonly string[]).includes(next)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
        mode = next;
      },
      allowRead: (dir: string) => allow(caller, "allowRead", readRoots, dir),
      allowWrite: (dir: string) => allow(caller, "allowWrite", writeRoots, dir),
      addApprover(approver: Approver) {
        if (caller.layer === "project") throw new Error("approval.addApprover: project plugins cannot answer approvals");
        if (typeof approver !== "function") throw new Error("approval.addApprover: approver must be a function");
        approvers.add(approver);
        const remove = () => void approvers.delete(approver);
        caller.onDispose(remove);
        return remove;
      },
      allows: (session: string, call: GatedToolCall) => call.tool?.effect === "read" && (sessionChecks.get(session)?.(call) ?? false),
    }));
  },

  async session(ctx) {
    const rules = policy({ cwd: ctx.cwd, readRoots, writeRoots });
    const ui = ctx.service<UI>("ui@1");
    if (badMode !== undefined) {
      ui?.notify(`jade/approval: mode must be one of ${MODES.join(", ")}, got ${badMode}; using ask`, "warning");
      badMode = undefined;
    }
    if (badTimeout !== undefined) {
      ui?.notify(`jade/approval: askTimeoutMinutes must be a number of minutes between 0 and ${MAX_ASK_TIMEOUT_MINUTES}, got ${badTimeout}; using 24 hours`, "warning");
      badTimeout = undefined;
    }
    const renderers = ctx.service<Renderers>("renderers@1");
    // auto 模式的审查用当前配置的模型；没有 models@1（模型插件被停用）或者配置里关掉时不做审查
    const models = ctx.service<Models>("models@1");
    const reviewing = models !== undefined && ctx.config.review !== false;
    /** 最近一次请求里的消息：auto 模式的审查从中取用户最近的请求 */
    const recent: { messages: readonly Message[] } = { messages: [] };
    if (reviewing) {
      ctx.kernel.hook({
        kind: "transform",
        point: "context.build",
        fn: (req) => {
          recent.messages = req.messages;
          return req;
        },
      });
    }
    const review = reviewing ? reviewer({ models: models!, cwd: ctx.cwd, writeRoots: () => writeRoots, messages: () => recent.messages }) : undefined;
    /** 本会话里审查过一次、放行了的调用 */
    const reviewedCalls = new Set<string>();
    let warned = false;
    /** 本进程里刚选的"总是允许"：并发的关卡拿到的 derived 是各自开始时的快照，可能还没有它 */
    const added: AllowRule[] = [];
    /** 一次只问一个问题；排在后面的问之前重新判断，前面刚选的"总是允许"可能已经覆盖它 */
    let asking: Promise<unknown> = Promise.resolve();
    /** 日志里记下的"总是允许"规则，每次调用工具前取一次：子 Agent 在工具执行期间经 allows 用它 */
    let logged: AllowRule[] = [];
    const id = ctx.session.id;
    const check = (call: GatedToolCall) =>
      rules.decide(call, { mode: mode === "yolo" ? "yolo" : "readonly", rules: [...logged, ...added] }).decision === "allow";
    sessionChecks.set(id, check);
    await ctx.effect(() => () => {
      if (sessionChecks.get(id) === check) sessionChecks.delete(id);
    });

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      fn: (call, hook) => {
        logged = (hook.derived[RULES_KEY] as AllowRule[] | undefined) ?? [];
        return { ...call, input: rules.absolutePath(call.input) };
      },
    });
    ctx.kernel.hook({
      kind: "gate",
      point: "tool.gate",
      timeoutMs: askTimeoutMs,
      fn: async (call, hook) => {
        const saved = () => {
          const logged = (hook.derived[RULES_KEY] as AllowRule[] | undefined) ?? [];
          return [...logged, ...added.filter((r) => !logged.some((l) => JSON.stringify(l) === JSON.stringify(r)))];
        };
        const result = rules.decide(call, { mode, rules: saved() });
        if (result.decision !== "ask") return result;
        // auto 模式：规则判断不了、本来要问的调用先让模型审一次。审查只能放行或转给用户，不会替用户拒绝
        let why: string | undefined;
        if (review && mode === "auto") {
          const key = reviewedKey(call);
          if (key !== undefined && reviewedCalls.has(key)) return { decision: "allow", reason: "This exact call was already approved in this session." };
          const verdict: Review = await review(call, hook.signal);
          // 审查调用不经过 model.responded，用量只能记在这里，界面据此计入会话用量
          if (verdict.usage) await hook.emit("reviewed", { toolUseId: call.toolUseId, usage: verdict.usage });
          if (verdict.decision === "allow") {
            if (key !== undefined) reviewedCalls.add(key);
            return { decision: "allow", reason: verdict.reason };
          }
          why = verdict.reason;
        }
        if (!ui?.interactive && approvers.size === 0) {
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
          const shown = (await preview(renderers, call)) ?? detail(call);
          const answer = await ask(
            ui,
            {
              title: `Allow ${call.name}?`,
              // 审查转给用户的：先说为什么
              detail: why ? `${why}\n\n${shown}` : shown,
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

/** allowRead、allowWrite：把目录登记进 roots，调用方的作用域关闭时撤销 */
function allow(caller: Caller, name: string, roots: string[], dir: string): () => void {
  if (caller.layer === "project") throw new Error(`approval.${name}: project plugins cannot widen what runs without asking`);
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error(`approval.${name}: dir must be an absolute path`);
  const root = path.resolve(dir);
  roots.push(root);
  const remove = () => {
    const i = roots.indexOf(root);
    if (i !== -1) roots.splice(i, 1);
  };
  caller.onDispose(remove);
  return remove;
}

/**
 * 把问题同时交给终端（能提问时）和所有审批渠道，返回先到的回答，然后中止其余的。
 * 终端里取消（undefined）算拒绝；渠道返回 undefined、不认识的值或出错算它不回答。都不回答时返回 undefined（拒绝）
 */
async function ask(ui: UI | undefined, request: SelectRequest<Answer>, signal: AbortSignal): Promise<Answer | undefined> {
  const done = new AbortController();
  const stop = () => done.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await new Promise<Answer | undefined>((resolve, reject) => {
      const channels: Promise<Answer | undefined | typeof NONE>[] = [];
      if (ui?.interactive) channels.push(ui.select(request, done.signal).then((a) => (a !== undefined && ANSWERS.includes(a) ? a : "deny")));
      for (const approver of approvers) {
        channels.push(
          Promise.resolve()
            .then(() => approver(request, done.signal))
            .then(
              (a) => (typeof a === "string" && ANSWERS.includes(a) ? (a as Answer) : NONE),
              () => NONE,
            ),
        );
      }
      let pending = channels.length;
      if (pending === 0) return resolve(undefined);
      for (const c of channels) {
        c.then((a) => {
          if (a !== NONE) resolve(a);
          else if (--pending === 0) resolve(undefined);
        }, reject);
      }
    });
  } finally {
    signal.removeEventListener("abort", stop);
    done.abort(new Error("answered"));
  }
}
const NONE = Symbol("no answer");

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
