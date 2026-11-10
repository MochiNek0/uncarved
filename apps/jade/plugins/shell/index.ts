// jade/shell：bash 工具，以及后台命令的 bash_output、kill_shell；shell@1 给其他插件执行命令。
// 后台命令自己结束时告诉用户，并给模型留一句说明（不用它一直轮询）；/shells 给用户看和停掉后台命令。

import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import type { Renderers } from "../renderers/index.ts";
import type { Task } from "../task/index.ts";
import { shellRenderers } from "./renderers.ts";
import { shellService } from "./service.ts";
import { shellTools, type ShellTools } from "./shell.ts";

/** 打开着的会话 → 它的后台命令（/shells 用） */
const sessions = new Map<string, Pick<ShellTools, "list" | "kill">>();
const firstLine = (command: string) => {
  const line = command.split("\n")[0]!;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

export default definePlugin({
  process(ctx) {
    // 显示方式和会话无关，登记一次留到进程结束；没有 renderers@1（例如 print）时用前端的默认显示
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of shellRenderers) renderers.tool(r);
    // shell@1：找 shell 和杀进程树只有一份（见 service.ts）
    ctx.provide("shell@1", shellService(typeof ctx.config.shell === "string" ? { shell: ctx.config.shell } : {}));
    ctx.service<Commands>("commands@1")?.register({
      name: "shells",
      args: "[kill <id>]",
      description: "list the background commands the agent started, or stop one",
      instant: true,
      async run(args, { sessions: manager }) {
        const shells = manager.current && sessions.get(manager.current.id);
        const [verb, id] = args.trim().split(/\s+/);
        if (verb === "kill" && id) return shells && (await shells.kill(id)) ? `Stopped ${id}.` : `There is no background command ${id}.`;
        const all = shells?.list() ?? [];
        if (all.length === 0) return "No background commands.";
        return all.map((b) => `${b.id}  ${b.status}  ${firstLine(b.command)}`).join("\n");
      },
    });
  },

  async session(ctx) {
    const shell = typeof ctx.config.shell === "string" ? ctx.config.shell : undefined;
    const id = ctx.session.id;
    const { tools, executable, unavailable, shutdown, list, kill } = shellTools({
      cwd: ctx.cwd,
      ...(shell ? { shell } : {}),
      onExit(bg) {
        const what = `Background shell ${bg.id} (${firstLine(bg.command)}) exited with code ${bg.exitCode}`;
        ctx.service<UI>("ui@1")?.notify(what, bg.exitCode === 0 ? "info" : "warning");
        ctx.service<Prompts>("prompts@1")?.note(id, `${what}. Read its remaining output with bash_output.`);
      },
    });
    sessions.set(id, { list, kill });
    // 子 Agent（jade/task）的 bash：只收命令和时限，不能在后台跑；哪些命令能执行由 jade/task 按审批规则把关（只读的才行）
    const bash = tools.find((t) => t.name === "bash");
    try {
      if (bash) {
        ctx.service<Task>("task@1")?.tool({
          ...bash,
          description:
            "Run a read-only shell command in the working directory (for example git log, git diff, git status, ls, rg) and return its exit code and output. " +
            "Commands that could change anything, or that touch paths outside the working directory, are refused.",
          inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["command"], additionalProperties: false },
          execute: (input, c) => bash.execute({ command: (input as { command: string }).command, timeout_ms: (input as { timeout_ms?: number }).timeout_ms }, c),
        });
      }
    } catch {
      // jade/task 被隔离时它的服务已失效：子 Agent 没有 bash，主会话的照常
    }
    if (unavailable) ctx.service<UI>("ui@1")?.notify(unavailable, "warning");
    for (const tool of tools) ctx.kernel.tool(tool);
    if (executable) {
      const lines = [`- Shell for the bash tool: ${executable} (POSIX syntax, also on Windows)`];
      // 模型常用 xdg-open、open 打开文件，Git Bash 里没有；start 是 Git 自带的 /usr/bin/start
      if (process.platform === "win32") lines.push('- To open a file or URL for the user, run: start "" <path-or-url> (xdg-open and open do not exist)');
      ctx.service<Prompts>("prompts@1")?.add({ text: lines.join("\n") });
    }
    // 会话关闭（换会话、退出）时杀掉还在运行的后台命令
    await ctx.effect(() => () => {
      sessions.delete(id);
      shutdown();
    });
  },
});
