// jade/screenshot：截图工具（见 tool.ts）。本机没有能无头截图的浏览器时不注册这个工具。
// 模型能不能看图片由 jade/models 的 models@1 给出（JADE_VISION）：不能看时不截图。
// 访问网络的 URL 由 jade/approval 的关卡决定要不要问用户（effect 是 read，路径之外的 URL 会问）。

import { definePlugin } from "../../src/api.ts";
import type { Models } from "../models/index.ts";
import type { Prompts } from "../prompts/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { findBrowser, screenshotTool } from "./tool.ts";

/** 提示词里的一段：有截图工具时才加 */
const NOTE =
  "- When the work is visual (a page, a drawing, styles), take a screenshot of the result and look at it instead of guessing from the source.";

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
    const tool = screenshotTool({
      cwd: ctx.cwd,
      browser,
      // 换了模型（/model）之后也按新的配置判断
      available: () => models?.current()?.vision !== false,
    });
    if (!tool) return;
    ctx.kernel.tool(tool);
    const remove = ctx.service<Prompts>("prompts@1")?.add({ text: NOTE, stable: false });
    if (remove) ctx.effect(() => () => remove());
  },
});
