// jade/hooks：不写插件，在配置里写几条 shell 命令，就能在工具调用前后、一轮结束时做点事。
//
// $JADE_HOME/config.json（项目层的配置设不了这一项：克隆的仓库不能让你的机器跑命令）：
//
//   { "jade/hooks": { "hooks": [
//     { "on": "before", "tool": "bash", "command": "python ~/.jade/guard.py" },
//     { "on": "after", "tool": "edit_file", "command": "bunx prettier --write \"$JADE_TOOL_PATH\"" },
//     { "on": "turn", "command": "powershell -c \"New-BurntToastNotification -Text 'jade is done'\"" }
//   ] } }
//
// - before：工具执行前（审批的关卡里）运行。退出码不是 0 时这次调用被拒绝，命令的输出作为理由告诉模型；是 0 时不表态。
// - after：工具成功执行后运行。退出码不是 0 时把输出留给模型看（下一次请求时附上），不改工具的结果。
// - turn：一轮结束后运行，结果不影响会话。
// tool 是工具名，不写或写 "*" 表示所有工具。命令经 shell@1 在工作目录里运行（和 bash 工具同一个 shell），环境变量：
// JADE_TOOL（工具名）、JADE_TOOL_INPUT（参数的 JSON 文件的路径）、JADE_TOOL_PATH（参数里有 path 时）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Prompts, Shell } from "@uncarved/jade-api/services";

export interface UserHook {
  on: "before" | "after" | "turn";
  /** 工具名；undefined 表示所有工具 */
  tool?: string;
  command: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 4000;

/** 检查配置里的 hooks；写错的条目说明原因，其余的照用 */
export function parseHooks(value: unknown): { hooks: UserHook[]; problems: string[] } {
  if (value === undefined) return { hooks: [], problems: [] };
  if (!Array.isArray(value)) return { hooks: [], problems: ["hooks must be a list"] };
  const hooks: UserHook[] = [];
  const problems: string[] = [];
  for (const [i, raw] of value.entries()) {
    const h = (raw ?? {}) as { on?: unknown; tool?: unknown; command?: unknown; timeoutSeconds?: unknown };
    const where = `hooks[${i}]`;
    if (h.on !== "before" && h.on !== "after" && h.on !== "turn") problems.push(`${where}: "on" must be "before", "after" or "turn"`);
    else if (typeof h.command !== "string" || !h.command.trim()) problems.push(`${where}: "command" must be a shell command`);
    else if (h.tool !== undefined && typeof h.tool !== "string") problems.push(`${where}: "tool" must be a tool name`);
    else if (h.timeoutSeconds !== undefined && !(typeof h.timeoutSeconds === "number" && h.timeoutSeconds > 0 && h.timeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
      problems.push(`${where}: "timeoutSeconds" must be a number up to ${MAX_TIMEOUT_SECONDS}`);
    } else {
      hooks.push({
        on: h.on,
        command: h.command,
        timeoutMs: ((h.timeoutSeconds as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        ...(typeof h.tool === "string" && h.tool !== "*" ? { tool: h.tool } : {}),
      });
    }
  }
  return { hooks, problems };
}

/** 单引号括起来，给 POSIX shell 用 */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… (${s.length - MAX_OUTPUT_CHARS} more characters)` : s);

let warned = false;

export default definePlugin({
  session(ctx) {
    const { hooks, problems } = parseHooks(ctx.config.hooks);
    const ui = () => ctx.service<UI>("ui@1");
    if (problems.length > 0 && !warned) {
      warned = true;
      ui()?.notify(`jade/hooks: ${problems.join("; ")}`, "warning");
    }
    if (hooks.length === 0) return;
    const shell = ctx.require<Shell>("shell@1");
    const sessionId = ctx.session.id;

    /** 运行一条 hook；call 给了就把工具名和参数经环境变量交给它 */
    const run = async (hook: UserHook, call: { name: string; input: unknown } | undefined, signal?: AbortSignal) => {
      let dir: string | undefined;
      try {
        let exports = "";
        if (call) {
          dir = await mkdtemp(path.join(os.tmpdir(), "jade-hook-"));
          const file = path.join(dir, "input.json");
          await writeFile(file, JSON.stringify(call.input ?? null));
          const p = (call.input as { path?: unknown } | null)?.path;
          // 路径用正斜杠：Git Bash 里反斜杠是转义符
          const vars = { JADE_TOOL: call.name, JADE_TOOL_INPUT: file.split(path.sep).join("/"), ...(typeof p === "string" ? { JADE_TOOL_PATH: p.split(path.sep).join("/") } : {}) };
          exports = `export ${Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}; `;
        }
        const r = await shell.run(exports + hook.command, { cwd: ctx.cwd, timeoutMs: hook.timeoutMs, ...(signal ? { signal } : {}) });
        return { ok: r.code === 0, output: r.timedOut ? `timed out after ${hook.timeoutMs / 1000}s` : clip(r.output.trim()) };
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    };
    const matching = (on: UserHook["on"], tool?: string) => hooks.filter((h) => h.on === on && (h.tool === undefined || h.tool === tool));

    if (hooks.some((h) => h.on === "before")) {
      ctx.kernel.hook({
        kind: "gate",
        point: "tool.gate",
        timeoutMs: MAX_TIMEOUT_SECONDS * 1000,
        fn: async (call, hook) => {
          for (const h of matching("before", call.name)) {
            const r = await run(h, call, hook.signal);
            if (!r.ok) return { decision: "deny", reason: `A hook the user configured (${h.command}) refused this ${call.name} call${r.output ? `:\n${r.output}` : "."}` };
          }
          return { decision: "abstain" };
        },
      });
    }
    if (hooks.some((h) => h.on === "after")) {
      ctx.kernel.hook({
        kind: "transform",
        point: "tool.after",
        timeoutMs: MAX_TIMEOUT_SECONDS * 1000,
        // 出错时只是这条 hook 没跑，不影响工具的结果
        optional: true,
        fn: async (out) => {
          if (out.isError) return undefined;
          for (const h of matching("after", out.call.name)) {
            const r = await run(h, out.call);
            if (r.ok) continue;
            const text = `The user's hook after ${out.call.name} (${h.command}) failed${r.output ? `:\n${r.output}` : "."}`;
            ui()?.notify(text, "warning");
            ctx.service<Prompts>("prompts@1")?.note(sessionId, text);
          }
          return undefined;
        },
      });
    }
    if (hooks.some((h) => h.on === "turn")) {
      ctx.kernel.hook({
        kind: "observe",
        point: "event",
        fn: (e) => {
          if (e.type !== "turn.ended") return;
          // 不等它：一轮结束不该被用户的命令拖住
          for (const h of matching("turn")) {
            void run(h, undefined, ctx.signal).then(
              (r) => void (r.ok || ui()?.notify(`jade/hooks: ${h.command} failed${r.output ? `: ${r.output}` : ""}`, "warning")),
              () => {},
            );
          }
        },
      });
    }
  },
});
