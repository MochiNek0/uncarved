// jade/task：task 工具，把一件事交给子 Agent（见 subagent.ts）。
//
// 子 Agent 是核心开的子会话（ctx.session.spawn）：工具就是会话里的工具，默认只留只读的（加上只放行只读命令的 bash），
// 配置 write 为 true 时全部保留，写操作和主会话一样经过审批。子会话的日志存盘，父会话的工具结果带着它的引用。

import type { Usage } from "uncarved";
import { definePlugin, type SessionContext, type UI } from "@uncarved/jade-api";
import type { Approval, Models, Renderers } from "@uncarved/jade-api/services";
import { CHARS_PER_TOKEN, FALLBACK_WINDOW, fitToolResults, READ_ONLY_REASON, REPORT_TOOL_SHARE, stepsThisTurn, subagentPrompt, taskTool, WRAP_UP_AT, type Control, type TaskProgress } from "./subagent.ts";
import { clip, dim, error, lines as joinLines } from "./style.ts";

const MAX_DETAIL_LINES = 40;

/** task 开的、还在跑的子会话 → 它的运行状态（子会话里本插件的 hook 用） */
const controls = new Map<string, Control>();

export default definePlugin({
  process(ctx) {
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
          const shown = lines.slice(0, MAX_DETAIL_LINES).map((l) => (isError ? error(l) : l));
          if (lines.length > MAX_DETAIL_LINES) shown.push(dim(`… (${lines.length - MAX_DETAIL_LINES} more lines)`));
          return {
            line: isError ? error(clip(lines[0] ?? "", 200)) : dim(`${clip(lines[0] ?? "", 160)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`),
            details: joinLines([dim(`sub-agent ran ${sub.length} tool call${sub.length > 1 ? "s" : ""}:`), ...sub.map((l) => dim(`  ${l}`)), ...shown]),
          };
        },
      });
    }
  },

  session(ctx) {
    const models = ctx.require<Models>("models@1");
    const configured = ctx.config.maxSteps;
    // 不配置时不限步数：子 Agent 做完就报告，接近上下文窗口时也会被要求报告
    const maxSteps = typeof configured === "number" && Number.isInteger(configured) && configured > 0 ? configured : Infinity;
    const write = ctx.config.write === true;
    const window = () => models.current()?.contextWindow ?? FALLBACK_WINDOW;

    // 本插件在子会话里的那份：task 开的子会话的步数上限、写报告、只读的限制。别的插件开的子会话（controls 里没有）不管
    if (ctx.session.parent) childHooks(ctx, () => controls.get(ctx.session.id), window);

    // 层数到了上限的会话（默认子 Agent 不能再开子 Agent）不给 task 工具
    if (!ctx.session.canSpawn) return;
    /** 跑完、还没记进日志的子 Agent 用量，按 task 调用的 toolUseId */
    const usage = new Map<string, Usage>();
    // 子 Agent 用的模型：/model 保存过的名字，或当前服务上的另一个模型；不设时用会话的模型
    const model = typeof ctx.config.model === "string" && ctx.config.model ? ctx.config.model : undefined;
    const provider = model ? { id: ctx.plugin, complete: (req: Parameters<Models["complete"]>[0], o: Parameters<Models["complete"]>[1]) => models.complete(req, { ...o, model }) } : undefined;
    const system = subagentPrompt(maxSteps, write);
    ctx.kernel.tool(
      taskTool({
        maxSteps,
        write,
        spawn: (parent, description, signal) =>
          ctx.session.spawn({
            parent,
            signal,
            label: description,
            system,
            ...(provider ? { provider } : {}),
            // 只读时：只读的工具，加上 bash 这类按命令判断的（只放行审批规则认定为只读的命令，见 childHooks）。
            // 子 Agent 不能问用户问题（ask_user）：它的过程用户看不到，问了也没有上下文
            tools: (t) => t.name !== "ask_user" && (write || t.effect === "read" || t.meta?.shell !== undefined),
          }),
        register: (child, control) => {
          controls.set(child, control);
          // 只读的子 Agent：jade/approval 判断它的非只读调用（auto 模式下交给审查按只读的标准判断），见 childHooks
          const release = write ? undefined : ctx.service<Approval>("approval@1")?.readOnly(child);
          return () => {
            controls.delete(child);
            release?.();
          };
        },
        usage: (toolUseId, u) => void usage.set(toolUseId, u),
        job: (description, stop) => ctx.service<UI>("ui@1")?.job?.({ session: ctx.session.id, kind: "agent", title: description, stop }),
        describe: (name, input) => ctx.service<Renderers>("renderers@1")?.forTool(name)?.renderer.summary?.(input) ?? clip(JSON.stringify(input) ?? "", 120),
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

/** task 开的子会话里，本插件加的 hook。control 在子会话开好之后才登记，hook 执行时再取 */
function childHooks(ctx: SessionContext, control: () => Control | undefined, window: () => number): void {
  // 步数上限；wrapUp 时只再要一次回复（报告）。历史接近上下文窗口时也停下，之后要报告
  ctx.kernel.hook({
    kind: "gate",
    point: "turn.continue",
    fn: (s) => {
      const c = control();
      if (!c) return { decision: "abstain" };
      return stepsThisTurn(s) >= (c.wrapUp ? 1 : c.maxSteps) || (c.lastTokens ?? 0) >= window() * WRAP_UP_AT ? { decision: "deny" } : { decision: "abstain" };
    },
  });
  // 要报告时工具输出可能已经很多（上面停下时、或者已经超出窗口）：只放进最近的一部分
  ctx.kernel.hook({
    kind: "transform",
    point: "context.project",
    fn: (messages) => (control()?.wrapUp ? fitToolResults(messages, window() * REPORT_TOOL_SHARE * CHARS_PER_TOKEN, ctx.plugin) : messages),
  });
  // 只读的子 Agent：不是只读的工具（bash）由 jade/approval 判断（登记见 register）：审批规则认定为只读的（git log、ls、rg……）放行，
  // 其余的 auto 模式下交给审查按只读的标准判断，其他模式直接拒绝。没有 jade/approval 时这里直接拒绝
  ctx.kernel.hook({
    kind: "gate",
    point: "tool.gate",
    fn: (call) => {
      const c = control();
      if (!c || c.write || call.tool.effect === "read") return { decision: "abstain" };
      if (ctx.service<Approval>("approval@1")) return { decision: "abstain" };
      return { decision: "deny", reason: READ_ONLY_REASON(call.name) };
    },
  });
  // instructions: false：不给子 Agent 指令文件（jade/prompts 放进来的、带来源的那几段）
  if (ctx.config.instructions === false) {
    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      order: 100,
      fn: (req) => (control() ? { ...req, system: req.system.filter((seg) => !(seg.origin.by === "plugin" && seg.origin.id === "jade/prompts" && seg.origin.source)) } : req),
    });
  }
}
