// jade/approval：审批。tool.before 把路径统一成绝对路径，tool.gate 按模式和规则决定，要问时经 ui@1 问用户。
// auto 模式下规则判断不了、本来要问的调用先让模型审一次（review.ts）：它只能放行或转给用户，不能替用户拒绝。
//
// 没有这个插件（停用、坏掉、被隔离）时，核心的兜底关卡拒绝所有非只读工具（第 7 节），所以这里出错不会放行。
// 用户选的"总是允许"记进日志（derived），恢复会话后仍然有效；模式是进程级的，来自配置，可以经 approval@1 改。

import path from "node:path";
import type { GatedToolCall, Message } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
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
}

/** derived 里保存"总是允许"规则的键 */
const RULES_KEY = "jade/approval/rules";
/** 等用户回答的时限：内核要求 hook 有有限的超时，超时按拒绝处理 */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
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
/** 经 allowRead 登记的目录；policy 每次判断时读它 */
const readRoots: string[] = [];

export default definePlugin({
  process(ctx) {
    const configured = ctx.config.mode;
    if (typeof configured === "string" && (MODES as readonly string[]).includes(configured)) mode = configured as Mode;
    else if (configured !== undefined) badMode = JSON.stringify(configured);
    ctx.provide("approval@1", (caller): Approval => ({
      mode: () => mode,
      setMode(next: Mode) {
        if (!(MODES as readonly string[]).includes(next)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
        mode = next;
      },
      allowRead(dir: string) {
        if (caller.layer === "project") throw new Error("approval.allowRead: project plugins cannot widen what runs without asking");
        if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("approval.allowRead: dir must be an absolute path");
        const root = path.resolve(dir);
        readRoots.push(root);
        const remove = () => {
          const i = readRoots.indexOf(root);
          if (i !== -1) readRoots.splice(i, 1);
        };
        caller.onDispose(remove);
        return remove;
      },
    }));
  },

  session(ctx) {
    const rules = policy({ cwd: ctx.cwd, readRoots });
    const ui = ctx.service<UI>("ui@1");
    if (badMode !== undefined) {
      ui?.notify(`jade/approval: mode must be one of ${MODES.join(", ")}, got ${badMode}; using ask`, "warning");
      badMode = undefined;
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
    const review = reviewing ? reviewer({ models: models!, cwd: ctx.cwd, messages: () => recent.messages }) : undefined;
    /** 本会话里审查过一次、放行了的调用 */
    const reviewedCalls = new Set<string>();
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
          const shown = (await preview(renderers, call)) ?? detail(call);
          const answer = await ui.select(
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
