// jade/computer：让模型看屏幕、操作键鼠（见 tool.ts）。目前只支持 Windows（windows.ts）。
// 默认不开：设 JADE_COMPUTER=1 才注册这个工具。它能操作整台电脑，写代码时不该出现在模型面前。
// 模型不能看图片时（models@1 的 vision）请求里不给这个工具。

import { definePlugin } from "@uncarved/jade-api";
import type { Models, Renderers } from "@uncarved/jade-api/services";
import { computerTool } from "./tool.ts";
import { windowsDriver, type Driver } from "./windows.ts";

export default definePlugin({
  process(ctx) {
    ctx.service<Renderers>("renderers@1")?.tool({
      tool: "computer",
      summary: (input) => {
        type Step = { action?: string; x?: number; y?: number; text?: string; keys?: string; amount?: number; ms?: number };
        const one = (i: Step) => {
          if (i.action === "click" || i.action === "scroll") return `${i.action} ${i.x}, ${i.y}${i.amount ? ` ${i.amount}` : ""}`;
          if (i.action === "type") return `type ${JSON.stringify(i.text ?? "")}`;
          if (i.action === "key") return `key ${i.keys ?? ""}`;
          if (i.action === "wait") return `wait ${i.ms}ms`;
          return String(i.action ?? "");
        };
        const i = (input ?? {}) as Step & { actions?: Step[] };
        return Array.isArray(i.actions) ? i.actions.map(one).join(" → ") : one(i);
      },
    });
  },

  session(ctx) {
    if (process.env.JADE_COMPUTER !== "1" || process.platform !== "win32") return;
    const models = ctx.service<Models>("models@1");
    const available = () => models?.current()?.vision !== false;

    let driver: Driver | undefined;
    ctx.effect(() => () => driver?.close());
    const tool = computerTool({ driver: () => (driver ??= windowsDriver()), available });
    ctx.kernel.tool(tool);

    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      fn: (req) => (available() ? req : { ...req, tools: req.tools.filter((t) => t.name !== tool.name) }),
    });
  },
});
