// 权限插件：tool.before 把路径统一成绝对路径，tool.gate 按模式、工具的 effect、路径和规则决定。
//
// 模式和"总是允许"的规则由宿主用 Runtime.record 写进日志（derived），关卡从 ctx.derived 读取：
// 决定只依赖日志里的东西和调用本身，恢复会话后设置仍然有效。

import path from "node:path";
import type { GatedToolCall, GateResult, Plugin } from "uncarved";
import { validate } from "./schema.ts";

export const MODES = ["ask", "auto-edit", "yolo", "readonly"] as const;
export type Mode = (typeof MODES)[number];

/** derived 中保存设置的键 */
export const POLICY_KEY = "coder/policy";

/** 本会话内"总是允许"的规则。prefix 只用于 bash，匹配命令开头 */
export interface AllowRule {
  tool: string;
  prefix?: string;
}

export interface PolicySettings {
  mode: Mode;
  rules: AllowRule[];
}

export interface PolicyOptions {
  cwd: string;
  /** 日志里还没有设置时使用 */
  mode?: Mode;
  id?: string;
}

export interface Policy {
  plugin: Plugin;
  /** 当前设置：日志里记录的，没有就是默认值 */
  settings(derived: Readonly<Record<string, unknown>>): PolicySettings;
  /** 给"总是允许"一个默认规则：bash 取命令的前两个词，其他工具取工具名 */
  ruleFor(call: { name: string; input: unknown }): AllowRule;
  decide(call: GatedToolCall, settings: PolicySettings): GateResult;
}

/** 只读且没有重定向、管道、命令替换的命令直接放行 */
const SAFE_COMMANDS = [
  /^(ls|pwd|cat|head|tail|wc|echo|which|whoami|date|tree|file|stat|du|df)(\s|$)/,
  /^git\s+(status|diff|log|show|branch|rev-parse|remote\s+-v|blame|ls-files)(\s|$)/,
  /^(rg|grep)\s/,
  /^(node|bun|python3?|go|cargo|rustc|tsc)\s+(--version|-v|-V)$/,
];
const SHELL_META = /[;&|<>`$()\n]/;

export function isSafeCommand(command: string): boolean {
  const c = command.trim();
  return !SHELL_META.test(c) && SAFE_COMMANDS.some((re) => re.test(c));
}

export function policy(opts: PolicyOptions): Policy {
  const id = opts.id ?? "coder/policy";
  const defaults: PolicySettings = { mode: opts.mode ?? "ask", rules: [] };
  const inside = (p: string) => {
    const rel = path.relative(opts.cwd, p);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  const self: Policy = {
    settings(derived) {
      return structuredClone((derived[POLICY_KEY] as PolicySettings | undefined) ?? defaults);
    },
    ruleFor(call) {
      if (call.name !== "bash") return { tool: call.name };
      const words = String((call.input as { command?: unknown }).command ?? "").trim().split(/\s+/);
      return { tool: "bash", prefix: words.slice(0, 2).join(" ") };
    },
    decide(call, { mode, rules }) {
      const { tool } = call;
      const problem = validate(tool.inputSchema, call.input);
      if (problem) return { decision: "deny", reason: `Invalid input for ${call.name}: ${problem}. Fix the arguments and try again.` };

      const input = call.input as { path?: string; command?: string };
      const outside = typeof input.path === "string" && !inside(input.path);
      const ruled = rules.some(
        (r) => r.tool === call.name && (r.prefix === undefined || (input.command ?? "").trim().startsWith(r.prefix)),
      );

      if (tool.effect === "read") {
        if (!outside || mode === "yolo" || ruled) return { decision: "allow" };
        return { decision: "ask" };
      }
      if (mode === "readonly") {
        if (call.name === "bash" && isSafeCommand(input.command ?? "")) return { decision: "allow" };
        return {
          decision: "deny",
          reason: `The session is in read-only mode, so ${call.name} is not allowed. Describe the change instead of making it.`,
        };
      }
      if (mode === "yolo" || ruled) return { decision: "allow" };
      if (tool.effect === "write") return { decision: mode === "auto-edit" && !outside ? "allow" : "ask" };
      // external
      if (call.name === "bash" && isSafeCommand(input.command ?? "")) return { decision: "allow" };
      return { decision: "ask" };
    },
    plugin: {
      id,
      version: "0.2.0",
      kernel: "^1",
      needs: ["transform:tool.before", "gate:tool.gate"],
      hooks: [
        {
          kind: "transform",
          point: "tool.before",
          // 让日志里的 tool.decided 记录的是确定的绝对路径，关卡也按它判断
          fn: (call) => {
            const input = call.input as { path?: unknown } | null;
            if (!input || typeof input !== "object" || typeof input.path !== "string") return;
            return { ...call, input: { ...input, path: path.resolve(opts.cwd, input.path) } };
          },
        },
        { kind: "gate", point: "tool.gate", fn: (call, ctx) => self.decide(call, self.settings(ctx.derived)) },
      ],
    },
  };
  return self;
}
