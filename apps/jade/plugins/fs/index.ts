// jade/fs：文件工具 read_file、write_file、edit_file、multi_edit、list_dir、glob、grep。

import { definePlugin } from "@uncarved/jade-api";
import type { Renderers } from "../renderers/index.ts";
import type { Task } from "../task/index.ts";
import { fsTools, SeenFiles } from "./fs.ts";
import { fsRenderers } from "./renderers.ts";

export default definePlugin({
  process(ctx) {
    // 显示方式和会话无关，登记一次留到进程结束；没有 renderers@1（例如 print）时用前端的默认显示
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of fsRenderers(ctx.cwd)) renderers.tool(r);
  },

  session(ctx) {
    // 数模型调用的次数：同一次回复里先读后改的，改的内容是看到读取结果之前写好的。
    // 同时按最终发给模型的消息让被压缩（jade/compact 总结或清理）掉的读取失效：那些文件要重新读才能改
    const responses = { calls: 0 };
    const seen = new SeenFiles();
    ctx.kernel.hook({
      kind: "transform",
      point: "model.before",
      fn: (request) => {
        responses.calls++;
        seen.prune(request.messages);
      },
    });
    for (const tool of fsTools(ctx.cwd, { responses, seen })) ctx.kernel.tool(tool);
    // 子 Agent（jade/task）的只读工具：另一套实例，子 Agent 读过的文件不算主会话读过
    // jade/task 被隔离时它的服务已失效：子 Agent 没有文件工具，文件工具本身照常
    try {
      const task = ctx.service<Task>("task@1");
      if (task) for (const tool of fsTools(ctx.cwd)) if (tool.effect === "read") task.tool(tool);
    } catch {}
  },
});
