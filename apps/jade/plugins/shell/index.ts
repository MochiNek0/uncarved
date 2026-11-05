// jade/shell：bash 工具，以及后台命令的 bash_output、kill_shell；shell@1 给其他插件执行命令。

import { definePlugin, type UI } from "../../src/api.ts";
import type { Prompts } from "../prompts/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { shellRenderers } from "./renderers.ts";
import { shellService } from "./service.ts";
import { shellTools } from "./shell.ts";

export default definePlugin({
  process(ctx) {
    // 显示方式和会话无关，登记一次留到进程结束；没有 renderers@1（例如 print）时用前端的默认显示
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of shellRenderers) renderers.tool(r);
    // shell@1：找 shell 和杀进程树只有一份（见 service.ts）
    ctx.provide("shell@1", shellService(typeof ctx.config.shell === "string" ? { shell: ctx.config.shell } : {}));
  },

  async session(ctx) {
    const shell = typeof ctx.config.shell === "string" ? ctx.config.shell : undefined;
    const { tools, executable, unavailable, shutdown } = shellTools({ cwd: ctx.cwd, ...(shell ? { shell } : {}) });
    if (unavailable) ctx.service<UI>("ui@1")?.notify(unavailable, "warning");
    for (const tool of tools) ctx.kernel.tool(tool);
    if (executable) {
      const lines = [`- Shell for the bash tool: ${executable} (POSIX syntax, also on Windows)`];
      // 模型常用 xdg-open、open 打开文件，Git Bash 里没有；start 是 Git 自带的 /usr/bin/start
      if (process.platform === "win32") lines.push('- To open a file or URL for the user, run: start "" <path-or-url> (xdg-open and open do not exist)');
      ctx.service<Prompts>("prompts@1")?.add({ text: lines.join("\n") });
    }
    // 会话关闭（换会话、退出）时杀掉还在运行的后台命令
    await ctx.effect(() => shutdown);
  },
});
