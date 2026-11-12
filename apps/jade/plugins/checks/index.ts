// jade/checks：模型改了文件之后，下一次请求模型之前对改过的文件跑项目的检查（类型检查、lint），
// 把发现的问题附在这批修改的最后一个结果后面（见 checks.ts）；/checks 查看、开关；对话里显示检查的结果。
//
// 检查在本轮之内、下一次请求模型之前（context.project）运行，不放到 session.afterTurn：模型要在同一轮里看到
// 自己刚引入的错误并改掉；轮次结束后才检查就得再发起一轮（session.send），等于替用户多说一句话。
//
// 检查会执行仓库里的代码（node_modules 里的 tsc、.jade/checks.json 里的命令），每条命令第一次运行前请用户确认，
// 记在 $JADE_HOME/trust.jsonl（和旧 jade 同一个文件、同一种记录，旧 jade 里确认过的不用再确认）。
// yolo 模式不问；不能提问时不运行没确认过的命令。

import { createHash } from "node:crypto";
import path from "node:path";
import { definePlugin, type SessionContext, type UI } from "@uncarved/jade-api";
import type { Approval, Commands, EventRenderer, Renderers, Shell } from "@uncarved/jade-api/services";
import { changedFiles, checks, type Check, type Checks } from "./checks.ts";
import { bold, dim, display, realPath, repoRoot, TrustFile, yellow } from "./project.ts";

/** 确认记录：同一个目录里的同一条命令只问一次。和旧 jade 的算法相同 */
const checkHash = (c: Check) => createHash("sha256").update(`jade-check\0${c.cwd}\0${c.command}`).digest("hex");

/** 展开后最多显示的行数 */
const MAX_DETAIL_LINES = 40;

/** 会话 id → 这个会话的检查（/checks 用） */
const bySession = new Map<string, Checks>();
/** process() 里准备好、session() 里调用：用进程级的确认记录和"一次只问一个问题" */
let sessionSetup: ((ctx: SessionContext) => Promise<void>) | undefined;

export const checksRenderers: EventRenderer[] = [
  {
    event: "checked",
    render: (data) => {
      const d = data as { summary: { name: string; problems: number; others?: number; failed?: string }[]; report: string };
      const bad = d.summary.filter((s) => s.problems > 0 || s.others || s.failed);
      const lines = d.report ? d.report.split("\n").slice(1) : [];
      const details = lines.length
        ? [...lines.slice(0, MAX_DETAIL_LINES), ...(lines.length > MAX_DETAIL_LINES ? [dim(`… ${lines.length - MAX_DETAIL_LINES} more lines`)] : [])].join("\n")
        : undefined;
      const withDetails = (line: string) => (details ? { line, details } : { line });
      if (bad.length === 0) return withDetails(dim(`✓ checks passed: ${d.summary.map((s) => s.name).join(", ")}`));
      const what = bad.map((s) =>
        s.failed
          ? `${s.name} ${s.failed}`
          : `${s.name}: ${[s.problems > 0 ? `${s.problems} problem${s.problems > 1 ? "s" : ""} in changed files` : "", s.others ? `${s.others} new elsewhere` : ""]
              .filter(Boolean)
              .join(", ")}`,
      );
      return withDetails(yellow(`⚠ checks: ${what.join("; ")}`));
    },
  },
];

export default definePlugin({
  process(ctx) {
    const off = ctx.config.enabled === false || process.env.JADE_CHECKS === "off";
    const trust = new TrustFile(path.join(ctx.home, "trust.jsonl"));
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of checksRenderers) renderers.event(r);

    ctx.service<Commands>("commands@1")?.register({
      name: "checks",
      args: "[on|off]",
      description: "checks jade runs after the agent edits files (type checker, linter)",
      instant: true,
      async run(args, c) {
        const session = c.sessions.current;
        const checks = session && bySession.get(session.id);
        if (!checks) {
          if (off) return dim(`Edit-time checks are turned off${process.env.JADE_CHECKS === "off" ? " by JADE_CHECKS=off" : ` ({"jade/checks": {"enabled": false}} in ${path.join(ctx.home, "config.json")})`}.`);
          return dim(unavailable ?? "Edit-time checks are not available in this session.");
        }
        const arg = args.trim();
        if (arg === "on" || arg === "off") {
          checks.enabled = arg === "on";
          if (arg === "on") checks.reset();
          return `checks: ${arg}`;
        }
        if (arg) return yellow("usage: /checks [on|off]");
        const files = changedFiles(session.state.messages, realPath(ctx.cwd), (t) => session.tool(t)?.meta?.writes);
        const found = await checks.resolve(files);
        const lines = [`Edit-time checks are ${checks.enabled ? "on" : "off"} in this session.`];
        if (found.length > 0) {
          lines.push("For the files changed in this session:");
          for (const check of found) {
            const pending = (await trust.has(checkHash(check))) ? "" : ", not confirmed yet";
            lines.push(`  ${bold(check.name)} ${dim(`in ${display(ctx.cwd, check.cwd) || "."}${pending}`)}\n    ${dim(check.command)}`);
          }
        } else lines.push(dim(files.length ? "No checks apply to the files changed in this session." : "No files changed in this session yet."));
        lines.push(
          dim(
            "Detected per file: TypeScript (nearest tsconfig.json + the project's typescript), Python (ruff), Go (go vet).\n" +
              `Add your own in .jade/checks.json or ${path.join(ctx.home, "checks.json")}; JADE_CHECKS=off turns them off.`,
          ),
        );
        return lines.join("\n");
      },
    });

    /** 找不到 shell 时的说明，/checks 显示 */
    let unavailable: string | undefined;
    /** 一次只问一个问题 */
    let asking: Promise<unknown> = Promise.resolve();
    sessionSetup = async (s) => {
      if (off) return;
      // 找 shell、杀进程树都在 jade/shell 里（shell@1），这里不再复制一份
      const shell = s.require<Shell>("shell@1");
      if (!shell.executable) {
        unavailable = `edit-time checks are off: ${shell.unavailable ?? "no shell was found"}`;
        return;
      }
      const ui = s.service<UI>("ui@1");
      const approve = async (check: Check, signal: AbortSignal): Promise<boolean> => {
        const hash = checkHash(check);
        if (await trust.has(hash)) return true;
        if (s.service<Approval>("approval@1")?.mode() === "yolo") return true;
        if (!ui?.interactive) return false;
        const turn = asking.then(async () => {
          if (await trust.has(hash)) return true;
          signal.throwIfAborted();
          const answer = await ui.select(
            {
              title: `Run ${check.name} after the agent edits files, and show it the problems found?`,
              detail: `${check.command}\nin ${display(s.cwd, check.cwd) || "."}${check.source === "config" ? " (from checks.json)" : " (detected)"}`,
              options: [
                { label: "Yes, in this project from now on", value: "yes" },
                { label: "No, not in this session", value: "no" },
              ],
            },
            signal,
          );
          if (answer === "yes") {
            await trust.add(hash, check.cwd);
            return true;
          }
          ui.notify(`${check.name} will not run in this session; /checks on to ask again`);
          return false;
        });
        asking = turn.catch(() => {});
        return turn;
      };
      const cwd = realPath(s.cwd);
      const c = checks({ cwd, root: realPath(repoRoot(cwd)), home: s.home, run: shell.run, which: (bin) => shell.which(bin) ?? null, approve, writes: (t) => s.session.tool(t)?.meta?.writes });
      const id = s.session.id;
      bySession.set(id, c);
      await s.effect(() => () => {
        if (bySession.get(id) === c) bySession.delete(id);
      });
      s.kernel.hook(c.hook);
    };
  },

  async session(ctx) {
    await sessionSetup?.(ctx);
  },
});
