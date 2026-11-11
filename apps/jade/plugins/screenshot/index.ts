// jade/screenshot：截图工具（见 tool.ts）。本机没有能无头截图的浏览器时不注册这个工具。
// 模型能不能看图片由 jade/models 的 models@1 给出（JADE_VISION）：不能看时请求里没有这个工具和提示，调用了也不截图。
// 访问网络的 URL 由 jade/approval 的关卡决定要不要问用户（effect 是 read，本机之外的 URL 会问）。

import { definePlugin } from "@uncarved/jade-api";
import type { Models, Prompts, Renderers } from "@uncarved/jade-api/services";
import { findBrowser, screenshotTool } from "./tool.ts";

/** 提示词里的一段：有截图工具时才加 */
const NOTE =
  "- When the work is visual (a page, a drawing, styles), take a screenshot of the result and look at it instead of guessing from the source. " +
  "If screenshots keep failing, or keep showing something you cannot explain after a couple of attempts, stop changing code to chase it: tell the user what you see and let them look.";

export default definePlugin({
  process(ctx) {
    const renderers = ctx.service<Renderers>("renderers@1");
    // 显示方式和会话无关，登记一次留到进程结束
    renderers?.tool({
      tool: "screenshot",
      summary: (input) => String((input as { url?: unknown; path?: unknown } | null)?.url ?? (input as { path?: unknown } | null)?.path ?? ""),
    });
  },

  session(ctx) {
    const browser = findBrowser(process.env);
    if (!browser) return;
    const models = ctx.service<Models>("models@1");
    // 换了模型（/model）之后也按新的配置判断
    const available = () => models?.current()?.vision !== false;
    const tool = screenshotTool({ cwd: ctx.cwd, browser, available });
    if (!tool) return;
    ctx.kernel.tool(tool);

    // 不能看图片的模型不给这个工具，也不加那句提示：给了它多半会试一次，白费一轮。
    // 排在 jade/prompts 的 context.build 之前（order -1），它组装系统提示词时读到的段落和工具已经是这一次的
    const prompts = ctx.service<Prompts>("prompts@1");
    let note: (() => void) | undefined;
    ctx.effect(() => () => note?.());
    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      order: -1,
      fn: (req) => {
        const can = available();
        if (can && !note) note = prompts?.add({ text: NOTE, stable: false });
        else if (!can && note) {
          note();
          note = undefined;
        }
        return can ? req : { ...req, tools: req.tools.filter((t) => t.name !== tool.name) };
      },
    });
  },
});
