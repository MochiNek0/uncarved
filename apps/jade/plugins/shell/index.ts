// jade/shell：bash 工具，以及后台命令的 bash_output、kill_shell。

import { definePlugin, type UI } from "../../src/api.ts";
import type { Prompts } from "../prompts/index.ts";
import { shellTools } from "./shell.ts";

export default definePlugin({
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
