// acme/guard：公司红线。一个普通的 tool.gate：命中规则就拒绝，否则弃权，交给审批插件照常判断。
//
// 拒绝优先（宪法 I-7）：别的插件的允许推翻不了它，yolo 模式、用户点"允许"、模型审查都一样。
// 它拒绝时，还在问人的审批会被中止，不会让人去回答一个注定被拒绝的问题。
// 每次拦截记一个 `acme/guard/blocked` 事件（规则名、原因），审计报告据此说明是哪条红线。
//
// 能管住的：文件工具碰哪些文件、shell 命令里的危险操作和网址、web 工具访问的主机。
// 管不住的：shell 命令里间接的操作（脚本里写的 curl、base64 过的命令）。真要防，靠的是沙箱和网络出口，不是这一层。
//
// 只用类型导入，不依赖 jade 的运行时代码：装到任何地方都能加载。

import os from "node:os";
import path from "node:path";
import type { GatedToolCall, GateResult } from "uncarved";
import type { PluginModule } from "../../../src/api.ts";
import type { Commands } from "../../../plugins/commands/index.ts";

const ID = "acme/guard";

/** 内置的命令规则：规则名 → 正则。配置 denyCommands 可以加规则，或者把某条设成 null 关掉 */
export const BUILTIN_COMMANDS: Record<string, string> = {
  "force-push": String.raw`\bgit\s+push\b[^;&|\n]*\s(--force(-with-lease)?|-f)(\s|$)`,
  "delete-everything": String.raw`\brm\s+(-\w+\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(/|~|\$HOME|\*|\.)(\s|$)`,
  upload: String.raw`\b(curl|wget)\b[^;&|\n]*\s(-d|--data(-\w+)?|-F|--form|-T|--upload-file|--post-data|--post-file)(\s|=|$)`,
  "file-transfer": String.raw`(^|[\s;&|(])(scp|sftp|rsync|nc|ncat|netcat|ftp)\s`,
  publish: String.raw`\b(npm|pnpm|yarn|bun)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b`,
};

/** 拦截时记进日志的事件 */
export interface BlockedEvent {
  toolUseId: string;
  tool: string;
  rule: string;
  detail: string;
}

interface Rules {
  commands: [name: string, re: RegExp][];
  hosts: string[];
  confineWrites: boolean;
  secrets: RegExp[];
}

/** 读配置；写错的规则报出来，不静默忽略 */
export function rulesFrom(config: Readonly<Record<string, unknown>>): { rules: Rules; problems: string[] } {
  const problems: string[] = [];
  const regex = (what: string, source: unknown, flags = ""): RegExp | undefined => {
    if (typeof source !== "string") {
      problems.push(`${what} must be a regular expression string`);
      return undefined;
    }
    try {
      return new RegExp(source, flags);
    } catch (err) {
      problems.push(`${what}: ${(err as Error).message}`);
      return undefined;
    }
  };

  const merged: Record<string, unknown> = { ...BUILTIN_COMMANDS };
  const extra = config.denyCommands;
  if (extra !== null && extra !== undefined) {
    if (typeof extra !== "object" || Array.isArray(extra)) problems.push("denyCommands must be an object of { rule name: regular expression }");
    else Object.assign(merged, extra);
  }
  const commands: Rules["commands"] = [];
  for (const [name, source] of Object.entries(merged)) {
    if (source === null) continue;
    const re = regex(`denyCommands.${name}`, source);
    if (re) commands.push([name, re]);
  }

  const hosts: string[] = [];
  const allowed = config.allowedHosts ?? [];
  if (!Array.isArray(allowed) || allowed.some((h) => typeof h !== "string")) problems.push("allowedHosts must be a list of host names");
  else hosts.push(...allowed.map((h: string) => h.toLowerCase().replace(/^\*\./, "")));

  const secrets: RegExp[] = [];
  const files = config.secretFiles ?? [];
  if (!Array.isArray(files)) problems.push("secretFiles must be a list of regular expressions");
  else for (const [i, f] of files.entries()) {
    const re = regex(`secretFiles[${i}]`, f, process.platform === "win32" ? "i" : "");
    if (re) secrets.push(re);
  }

  return { rules: { commands, hosts, confineWrites: config.confineWrites !== false, secrets }, problems };
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"`<>|;)\]]+/gi;
/** 文件工具参数里表示路径的键 */
const PATH_KEYS = ["path", "file_path", "file", "dir", "directory", "cwd"];

/** 判断一个调用；undefined 表示不归这里管 */
export function check(call: Pick<GatedToolCall, "name" | "input"> & { tool: { effect: string } }, rules: Rules, cwd: string): { rule: string; detail: string } | undefined {
  const input = (typeof call.input === "object" && call.input !== null ? call.input : {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : undefined;

  if (command !== undefined) {
    for (const [name, re] of rules.commands) {
      const m = re.exec(command);
      if (m) return { rule: name, detail: `the command matches the "${name}" rule: ${m[0].trim()}` };
    }
  }

  // 网址：参数里的 url 和命令里出现的网址
  if (rules.hosts.length > 0) {
    const urls = [...(typeof input.url === "string" ? [input.url] : []), ...(command?.match(URL_IN_TEXT) ?? [])];
    for (const u of urls) {
      let host: string;
      try {
        host = new URL(u).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!rules.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { rule: "allowed-hosts", detail: `${host} is not on the list of allowed hosts` };
    }
  }

  // 密钥文件：文件工具的路径，和命令里出现的文件名
  const paths = PATH_KEYS.flatMap((k) => (typeof input[k] === "string" ? [input[k] as string] : []));
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p): p is string => typeof p === "string"));
  const names = [...paths, ...(command ? words(command) : [])].map((p) => path.basename(p.replace(/[\\/]+$/, "")));
  for (const name of names) {
    if (rules.secrets.some((re) => re.test(name))) return { rule: "secret-files", detail: `${name} may hold secrets and must not be read or changed by the agent` };
  }

  // 文件工具只能改工作目录和临时目录里的文件
  if (rules.confineWrites && call.tool.effect === "write") {
    const roots = [cwd, os.tmpdir()].map((r) => norm(path.resolve(r)));
    for (const p of paths) {
      const full = norm(path.resolve(cwd, p));
      if (!roots.some((r) => full === r || full.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) {
        return { rule: "confine-writes", detail: `${path.resolve(cwd, p)} is outside the working directory` };
      }
    }
  }
  return undefined;
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** 命令里的词：按空白和 shell 符号切开，去掉引号 */
function words(command: string): string[] {
  return command
    .split(/[\s;&|<>()]+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ""))
    .filter((w) => w !== "" && !w.startsWith("-"));
}

export default {
  process(ctx) {
    const { rules } = rulesFrom(ctx.config);
    // /guard：列出生效的规则，演示和排查用
    ctx.service<Commands>("commands@1")?.register({
      name: "guard",
      description: "the company rules acme/guard enforces",
      instant: true,
      run() {
        const lines = ["Company rules (acme/guard). These cannot be approved, in any mode:", ""];
        for (const [name, re] of rules.commands) lines.push(`  command  ${name}  /${re.source}/`);
        lines.push(`  hosts    ${rules.hosts.length > 0 ? rules.hosts.join(", ") : "any"}`);
        lines.push(`  writes   ${rules.confineWrites ? "working directory and temp directory only" : "anywhere"}`);
        lines.push(`  secrets  ${rules.secrets.map((r) => `/${r.source}/`).join(" ")}`);
        return lines.join("\n");
      },
    });
  },

  session(ctx) {
    const { rules, problems } = rulesFrom(ctx.config);
    if (problems.length > 0) ctx.service<{ notify(m: string, l?: string): void }>("ui@1")?.notify(`acme/guard: ${problems.join("; ")}`, "warning");
    ctx.kernel.hook({
      kind: "gate",
      point: "tool.gate",
      fn: async (call: GatedToolCall, hook): Promise<GateResult> => {
        const hit = check(call, rules, ctx.cwd);
        if (!hit) return { decision: "abstain" };
        const event: BlockedEvent = { toolUseId: call.toolUseId, tool: call.name, ...hit };
        await hook.emit("blocked", event);
        return {
          decision: "deny",
          reason:
            `Blocked by company policy (acme/guard, rule "${hit.rule}"): ${hit.detail}. ` +
            "This cannot be approved. Do not try another way to do the same thing; tell the user what you wanted to do and why it was blocked.",
        };
      },
    });
  },
} satisfies PluginModule;
