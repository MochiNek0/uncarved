// jade/shell：bash 工具，以及后台命令的 bash_output、kill_shell；shell@1 给其他插件执行命令。
// 后台命令自己结束时告诉用户，并给模型留一句说明（不用它一直轮询）；/shells 给用户看和停掉后台命令。

import { definePlugin, type Job, type Span, type UI } from "@uncarved/jade-api";
import type { Commands, Prompts, Renderers, Undo } from "@uncarved/jade-api/services";
import { shellRenderers } from "./renderers.ts";
import { shellService } from "./service.ts";
import { shellTools, type ShellTools } from "./shell.ts";

/** 打开着的会话 → 它的后台命令（/shells 用） */
const sessions = new Map<string, Pick<ShellTools, "list" | "kill">>();
const firstLine = (command: string) => {
  const line = command.split("\n")[0]!;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/** /sh 的时限：用户自己看着它跑（登录、安装），给到 bash 工具的上限；不想等就按 esc */
const SH_TIMEOUT_MS = 600_000;
/** 边跑边显示的输出最多留这么多个字符（前端只显示末尾几行） */
const SH_LIVE_CHARS = 4000;
/** /sh 的结果收起时那一行最多这么多个字符 */
const SH_SUMMARY = 160;
/** 后台列表里最多留这么多个已经结束的后台命令（每个都带着输出） */
const MAX_FINISHED_JOBS = 10;
/** 结果的一行：失败的是错误，成功的是次要的（带语义样式的文字，怎么画由前端决定） */
const shade = (failed: boolean, text: string): Span => ({ text, style: failed ? "error" : "dim" });

export default definePlugin({
  process(ctx) {
    // 显示方式和会话无关，登记一次留到进程结束；没有 renderers@1（例如 print）时用前端的默认显示
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of shellRenderers) renderers.tool(r);
    // shell@1：找 shell 和杀进程树只有一份（见 service.ts）
    const shell = shellService(typeof ctx.config.shell === "string" ? { shell: ctx.config.shell } : {});
    ctx.provide("shell@1", shell);
    const commands = ctx.service<Commands>("commands@1");
    // 用户自己执行一条命令（前端里 !<命令> 是它的简写）：不经过模型和审批。
    // 输出显示给用户；会话里已经有对话时，结果作为用户的消息发给模型，它接着做（例如它让用户先 npm login）；
    // 还没有对话、或用户按 esc 停掉时不开始一轮，只给模型留一句说明，下一次请求时它能看到
    commands?.register({
      name: "sh",
      args: "<command>",
      description: "run a shell command yourself (short form: !<command>); then the agent continues with its output",
      prefix: "!",
      prefixHint: "shell command · you run it, not the agent",
      // 不是 instant：和消息一样排队，前端才把它当作正在做的事（esc 能停掉它）
      async run(args, { sessions: manager, signal, print, progress }) {
        const command = args.trim();
        if (!command) return "Usage: /sh <command>, or !<command>";
        if (!shell.executable) return shell.unavailable;
        // 边跑边显示输出（npm login 这类要看着它的提示）；被 esc 停掉时，已经输出的也留下来
        let live = "";
        let r: { code: number | null; output: string; timedOut: boolean };
        let stopped = false;
        const session = manager.current;
        const exec = () =>
          shell.run(command, {
            cwd: ctx.cwd,
            timeoutMs: SH_TIMEOUT_MS,
            signal,
            onOutput(text) {
              live = (live + text).slice(-SH_LIVE_CHARS);
              progress?.(live);
            },
          });
        // 有 undo@1 时这条命令改的文件能用 /undo 撤销（单独算一步）
        const undo = ctx.service<Undo>("undo@1");
        try {
          r = session && undo ? await undo.track(session.id, `$ ${firstLine(command)}`, exec) : await exec();
        } catch (e) {
          if (!signal.aborted) throw e;
          stopped = true;
          r = { code: null, output: live.trimEnd(), timedOut: false };
        }
        const status = stopped ? "stopped by the user" : r.timedOut ? `timed out after ${SH_TIMEOUT_MS / 1000}s` : `exit code ${r.code}`;
        // 和 bash 工具的结果一个样子：一行摘要，完整输出折叠起来
        const lines = r.output ? r.output.split("\n") : [];
        const failed = r.code !== 0;
        const first = failed ? `${status}${lines.length ? ` · ${lines[0]}` : ""}` : (lines[0] ?? "(no output)");
        const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
        const folded = lines.length > 1 || first.length > SH_SUMMARY;
        print(shade(failed, `⎿ ${first.length > SH_SUMMARY ? `${first.slice(0, SH_SUMMARY)}…` : first}${more}`), folded ? { details: r.output.replace(/^/gm, "    ") } : undefined);
        if (!stopped && session && session.state.messages.length > 0) return { prompt: `I ran this shell command myself (${status}):\n$ ${command}\n${r.output}` };
        if (session) ctx.service<Prompts>("prompts@1")?.note(session.id, `The user ran this shell command themselves (${status}):\n$ ${command}\n${r.output}`);
      },
    });
    commands?.register({
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
    /** 前端后台列表里的后台命令（ctrl+t）：用户能看输出、停掉；会话关闭时去掉 */
    const jobs = new Set<Job>();
    /** 用户在后台列表里停掉的 */
    const stoppedByUser = new Set<string>();
    /** 已经结束、还留在列表里的，先结束的在前；多于 MAX_FINISHED_JOBS 个时去掉最早的 */
    const finished: Job[] = [];
    const { tools, executable, unavailable, shutdown, list, kill } = shellTools({
      cwd: ctx.cwd,
      ...(shell ? { shell } : {}),
      onExit(bg) {
        const what = `Background shell ${bg.id} (${firstLine(bg.command)}) exited with code ${bg.exitCode}`;
        ctx.service<UI>("ui@1")?.notify(what, bg.exitCode === 0 ? "info" : "warning");
        ctx.service<Prompts>("prompts@1")?.note(id, `${what}. Read its remaining output with bash_output.`);
      },
      onBackground(bg) {
        const job = ctx.service<UI>("ui@1")?.job?.({
          session: id,
          kind: "shell",
          title: `${bg.id} ${firstLine(bg.command)}`,
          async stop() {
            stoppedByUser.add(bg.id);
            if (await kill(bg.id)) ctx.service<Prompts>("prompts@1")?.note(id, `The user stopped background shell ${bg.id} (${firstLine(bg.command)}).`);
          },
        });
        if (!job) return undefined;
        jobs.add(job);
        job.status("running");
        return {
          output: (text) => job.append(text),
          exit: (code, killed) => {
            job.status(stoppedByUser.has(bg.id) ? "stopped by you" : killed ? "stopped" : `exited with code ${code}`, true);
            finished.push(job);
            for (const old of finished.splice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
              old.dispose();
              jobs.delete(old);
            }
          },
        };
      },
    });
    sessions.set(id, { list, kill });
    // 子会话（子 Agent）里的 bash 只收命令和时限，不能在后台跑：子 Agent 交了报告会话就结束，后台命令随之被杀掉
    const child = ctx.session.parent !== undefined;
    const foreground = (t: (typeof tools)[number]): (typeof tools)[number] =>
      t.name !== "bash"
        ? t
        : {
            ...t,
            inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["command"], additionalProperties: false },
            execute: (input, c) => t.execute({ command: (input as { command: string }).command, timeout_ms: (input as { timeout_ms?: number }).timeout_ms }, c),
          };
    // 主会话已经说过一次
    if (unavailable && !child) ctx.service<UI>("ui@1")?.notify(unavailable, "warning");
    // 管后台命令的工具（bash_output、kill_shell）子会话里用不上
    for (const tool of tools) if (!(child && (tool.name === "bash_output" || tool.name === "kill_shell"))) ctx.kernel.tool(child ? foreground(tool) : tool);
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
      for (const job of jobs) job.dispose();
    });
  },
});
