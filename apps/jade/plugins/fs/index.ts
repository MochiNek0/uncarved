// jade/fs：文件工具 read_file、write_file、edit_file、multi_edit、list_dir、glob、grep。

import { definePlugin } from "../../src/api.ts";
import type { Renderers } from "../renderers/index.ts";
import { fsTools } from "./fs.ts";
import { fsRenderers } from "./renderers.ts";

export default definePlugin({
  process(ctx) {
    // 显示方式和会话无关，登记一次留到进程结束；没有 renderers@1（例如 print）时用前端的默认显示
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of fsRenderers(ctx.cwd)) renderers.tool(r);
  },

  session(ctx) {
    // 数模型调用的次数：同一次回复里先读后改的，改的内容是看到读取结果之前写好的
    const responses = { calls: 0 };
    ctx.kernel.hook({
      kind: "transform",
      point: "model.before",
      fn: () => {
        responses.calls++;
      },
    });
    for (const tool of fsTools(ctx.cwd, { responses })) ctx.kernel.tool(tool);
  },
});
