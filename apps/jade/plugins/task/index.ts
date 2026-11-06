// jade/task：task 工具，把调研交给只读的子 Agent（见 subagent.ts）。
//
// 子 Agent 用哪些工具：插件经 task@1 登记只读工具（jade/fs 登记 read_file、list_dir、glob、grep），
// 登记随登记者的作用域撤销。主会话里的工具对象是各插件私有的，子 Agent 拿到的是登记者另给的一份。

import type { Tool, Usage } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Models } from "../models/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { taskTool, type ApproveSubagent, type TaskProgress } from "./subagent.ts";
import { clip, dim, red } from "./style.ts";

/** task@1 */
export interface Task {
  /**
   * 给子 Agent 登记一个只读工具（effect 必须是 "read"），返回撤销函数；登记者的作用域关闭时自动撤销。
   * 工具名已被登记时抛错。要求批准的情形（工作目录之外的路径、url 参数）由子 Agent 自己判断，经 ui@1 问用户。
   * opts.when：每次启动子 Agent 时调用，返回 false 时这次不给它这个工具（例如没有配置搜索服务时的 web_search）
   */
  tool(tool: Tool, opts?: { when?: () => boolean }): () => void;
}

const DEFAULT_MAX_STEPS = 40;
const MAX_DETAIL_LINES = 40;

/** 登记的只读工具，按登记顺序 */
const registry: { tool: Tool; plugin: string; when?: () => boolean }[] = [];

/** 这次启动子 Agent 时给它的工具：同名的取最后登记的那个，when 返回 false 或出错的不给 */
function available(): Tool[] {
  const latest = new Map<string, (typeof registry)[number]>();
  for (const r of registry) {
    latest.delete(r.tool.name);
    latest.set(r.tool.name, r);
  }
  return [...latest.values()].flatMap((r) => {
    try {
      return !r.when || r.when() ? [r.tool] : [];
    } catch {
      return [];
    }
  });
}

/** 子 Agent 的审批一次问一个：并行的几个子 Agent 不同时弹对话框 */
let asking: Promise<unknown> = Promise.resolve();

export default definePlugin({
  process(ctx) {
    ctx.provide("task@1", (caller): Task => ({
      tool(tool, opts) {
        if (typeof tool?.name !== "string" || typeof tool.execute !== "function") throw new Error("task.tool: a tool needs a name and execute");
        if (tool.effect !== "read") throw new Error(`task.tool: ${tool.name} is not read-only (effect ${JSON.stringify(tool.effect)}); sub-agents only get read-only tools`);
        // 同一个插件重复登记是正常的：换会话时新会话先登记，旧会话随后撤销它的那份；取最后登记的
        const taken = registry.find((r) => r.tool.name === tool.name && r.plugin !== caller.plugin);
        if (taken) throw new Error(`task.tool: ${tool.name} is already registered by ${taken.plugin}`);
        if (opts?.when !== undefined && typeof opts.when !== "function") throw new Error("task.tool: when must be a function");
        const entry = { tool, plugin: caller.plugin, ...(opts?.when ? { when: opts.when } : {}) };
        registry.push(entry);
        const revoke = () => {
          const i = registry.indexOf(entry);
          if (i !== -1) registry.splice(i, 1);
        };
        caller.onDispose(revoke);
        return revoke;
      },
    }));

    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) {
      // 运行中每个只有一行进度（标签、调用过几个工具、正在做什么），并行的几个靠标签分清；结束时把它调用过的工具放进结果的折叠内容里
      const labels = new Map<string, string>();
      const steps = new Map<string, string[]>();
      const line = (id: string, what: string) => {
        const n = steps.get(id)?.length ?? 0;
        return dim(`  ↳ ${labels.get(id) ?? "sub-agent"}${n ? ` (${n} tool call${n > 1 ? "s" : ""})` : ""} · ${what}`);
      };
      renderers.tool({
        tool: "task",
        summary: (input) => String((input as { description?: unknown } | null)?.description ?? ""),
        progress(update, { toolUseId: id, summary }) {
          const p = update as TaskProgress;
          if (p?.kind === "task-start") {
            labels.set(id, p.description);
            return line(id, "starting");
          }
          if (p?.kind === "task-model") return line(id, "thinking");
          if (p?.kind === "task-tool") {
            const step = `${p.decision === "deny" ? "✗" : "·"} ${p.name}(${summary(p.name, p.input)})`;
            steps.set(id, [...(steps.get(id) ?? []), step]);
            return line(id, step);
          }
          return undefined;
        },
        result({ toolUseId: id, text, isError }) {
          const sub = steps.get(id) ?? [];
          steps.delete(id);
          labels.delete(id);
          // 没调用过工具时用默认的显示
          if (!sub.length) return undefined;
          const lines = text.split("\n");
          const shown = lines.slice(0, MAX_DETAIL_LINES).map((l) => (isError ? red(l) : l));
          if (lines.length > MAX_DETAIL_LINES) shown.push(dim(`… (${lines.length - MAX_DETAIL_LINES} more lines)`));
          return {
            line: isError ? red(clip(lines[0] ?? "", 200)) : dim(`${clip(lines[0] ?? "", 160)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`),
            details: [dim(`sub-agent ran ${sub.length} tool call${sub.length > 1 ? "s" : ""}:`), ...sub.map((l) => dim(`  ${l}`)), ...shown].join("\n"),
          };
        },
      });
    }
  },

  session(ctx) {
    const models = ctx.require<Models>("models@1");
    /** 跑完、还没记进日志的子 Agent 用量，按 task 调用的 toolUseId */
    const usage = new Map<string, Usage>();
    const configured = ctx.config.maxSteps;
    const maxSteps = typeof configured === "number" && Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_STEPS;
    const approve: ApproveSubagent = (call, signal) => {
      const ui = ctx.service<UI>("ui@1");
      if (!ui?.interactive) return Promise.resolve({ approved: false, reason: "Nobody can approve this action for a sub-agent. Report what you need instead." });
      const ask = asking.then(async () => {
        const choice = await ui.select(
          {
            title: `A sub-agent wants to ${call.why}. Allow it?`,
            detail: `${call.name} ${clip(JSON.stringify(call.input), 2000)}`,
            options: [
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
            ],
          },
          signal,
        );
        return choice === "yes" ? { approved: true } : { approved: false, reason: "The user denied this action." };
      });
      asking = ask.catch(() => {});
      return ask;
    };
    ctx.kernel.tool(
      taskTool({
        cwd: ctx.cwd,
        provider: { id: ctx.plugin, complete: (req, o) => models.complete(req, o) },
        tools: available,
        maxSteps,
        approve,
        id: ctx.plugin,
        usage: (toolUseId, u) => void usage.set(toolUseId, u),
      }),
    );
    // 子 Agent 的用量记成本插件的事件（和压缩、审查的用量一样），界面据此计入会话用量；只能在 hook 里记
    ctx.kernel.hook({
      kind: "transform",
      point: "tool.after",
      fn: async (outcome, hook) => {
        const u = usage.get(outcome.call.toolUseId);
        if (!u) return undefined;
        usage.delete(outcome.call.toolUseId);
        await hook.emit("subagent", { toolUseId: outcome.call.toolUseId, usage: u });
        return undefined;
      },
    });
    // 被中断的调用不经过 tool.after，一轮结束时还留着的不会再用到
    ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => void (e.type === "turn.ended" && usage.clear()) });
  },
});
