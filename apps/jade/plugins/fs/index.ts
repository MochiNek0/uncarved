// jade/fs：文件工具 read_file、write_file、edit_file、multi_edit、list_dir、glob、grep。

import { definePlugin } from "../../src/api.ts";
import { fsTools } from "./fs.ts";

export default definePlugin({
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
