// 权限插件：tool.before 把路径统一成绝对路径，tool.gate 按模式、工具的 effect、路径和规则决定。
//
// 带 url 参数的只读工具（web_fetch）也要问：网页里的提示注入可以让模型把读到的内容拼进 URL 发出去。
//
// 模式和"总是允许"的规则由宿主用 Runtime.record 写进日志（derived），关卡从 ctx.derived 读取：
// 决定只依赖日志里的东西和调用本身，恢复会话后设置仍然有效。

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { GatedToolCall, GateResult, Plugin } from "uncarved";
import { validate } from "./schema.ts";

export const MODES = ["ask", "auto-edit", "yolo", "readonly"] as const;
export type Mode = (typeof MODES)[number];

/** derived 中保存设置的键 */
export const POLICY_KEY = "jade/policy";

/**
 * 本会话内"总是允许"的规则。prefix、command 只用于 bash：prefix 匹配命令开头的整词，command 只匹配完全相同的命令。
 * dir：允许这个目录（工作目录之外）里的路径；host：允许访问这个主机。
 * 什么都不带的规则只对工作目录内的路径生效：在项目里允许了 write_file，不等于允许改 ~/.bashrc
 */
export interface AllowRule {
  tool: string;
  prefix?: string;
  command?: string;
  dir?: string;
  host?: string;
}

/** 显示用 */
export function describeRule(r: AllowRule): string {
  if (r.command !== undefined) return `${r.tool} "${r.command}"`;
  if (r.prefix !== undefined) return `${r.tool} "${r.prefix}…"`;
  if (r.dir !== undefined) return `${r.tool} in ${r.dir}`;
  if (r.host !== undefined) return `${r.tool} from ${r.host}`;
  return r.tool;
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
  /** 日志之外也要遵守的规则，每次判断时取（子 Agent 用主会话的规则） */
  rules?: () => AllowRule[];
}

export interface Policy {
  plugin: Plugin;
  /** 当前设置：日志里记录的，没有就是默认值 */
  settings(derived: Readonly<Record<string, unknown>>): PolicySettings;
  /** 给"总是允许"一个默认规则：bash 取命令的前两个词，工作目录之外的路径取所在目录，URL 取主机，其他取工具名 */
  ruleFor(call: { name: string; input: unknown }): AllowRule;
  decide(call: GatedToolCall, settings: PolicySettings): GateResult;
}

/** 只读且没有重定向、管道、命令替换的命令直接放行 */
const SAFE_COMMANDS = [
  /^(ls|pwd|cat|head|tail|wc|echo|which|whoami|date|tree|file|stat|du|df)(\s|$)/,
  /^git\s+(status|diff|log|show|rev-parse|remote\s+-v|blame|ls-files)(\s|$)/,
  // 带参数的 git branch 可能删除、重命名、创建分支，只放行列出分支的形式
  /^git\s+branch(\s+(-a|-r|-v|-vv|--all|--remotes|--list|--show-current))*$/,
  /^(rg|grep)\s/,
  /^(node|bun|python3?|go|cargo|rustc|tsc)\s+(--version|-v|-V)$/,
];
/** 白名单命令里会写文件或执行其他程序的参数 */
const UNSAFE_ARGS = [/\s--(output|pre|pre-glob|ext-diff|textconv)(=|\s|$)/, /^tree\s(.*\s)?-[a-zA-Z]*o/];

/** shell 分词后的一个词。glob：含未加引号的通配符，shell 会展开它 */
interface Word {
  value: string;
  glob: boolean;
}

/**
 * 只认最简单的 shell 语法：空白分隔的词、单引号、不含展开的双引号、未加引号的通配符。
 * 其余一切（重定向、管道、命令替换、变量、花括号展开、转义、注释……）返回 undefined，调用方一律按"不安全"处理，
 * 这样判断用的词和 shell 实际看到的参数一致
 */
export function shellWords(command: string): Word[] | undefined {
  const words: Word[] = [];
  let cur: Word | undefined;
  const s = command.trim();
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t") {
      if (cur) words.push(cur);
      cur = undefined;
      i++;
      continue;
    }
    cur ??= { value: "", glob: false };
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return undefined;
      const inner = s.slice(i + 1, end);
      if (ch === '"' && /[$`\\!]/.test(inner)) return undefined;
      cur.value += inner;
      i = end + 1;
      continue;
    }
    if (/[;&|<>`$()\n\r\\{}!#]/.test(ch)) return undefined;
    if (/[*?[\]]/.test(ch)) cur.glob = true;
    cur.value += ch;
    i++;
  }
  if (cur) words.push(cur);
  return words;
}

const joined = (words: Word[]) => words.map((w) => w.value).join(" ");

export function isSafeCommand(command: string): boolean {
  const words = shellWords(command);
  if (!words || words.length === 0) return false;
  const c = joined(words);
  return SAFE_COMMANDS.some((re) => re.test(c)) && !UNSAFE_ARGS.some((re) => re.test(c));
}

/** 这些命令的第二个词后面跟的是要执行的东西（脚本名、子命令），前缀要带上第三个词 */
const RUNNERS = /^(npm|pnpm|yarn|bun|npx|bunx|uv|poetry|pipenv|docker|kubectl|cargo|go|dotnet)\s+(run|exec|x|compose|tool)$/;
/** 前缀规则批准过的命令再加上这些参数，性质就变了（强制、删除、跳过检查），要重新问 */
const DANGEROUS_ARGS = /^(-f|--force|--force-with-lease|--hard|-D|--delete|--no-verify|-rf|-fr|-Rf|--prune)$|^--force[=-]/;

/**
 * 前缀规则只匹配能完整分词、且前缀按整词对齐的命令，避免 "npm test && …" 搭便车；
 * 前缀之后出现危险参数（git push 之后的 --force）也不算
 */
function matchesPrefix(command: string, prefix: string): boolean {
  const words = shellWords(command);
  if (!words) return false;
  const c = joined(words);
  if (c !== prefix && !c.startsWith(prefix + " ")) return false;
  const extra = words.slice(prefix.split(" ").length);
  return !extra.some((w) => DANGEROUS_ARGS.test(w.value));
}

/**
 * bash 的"总是允许"默认规则：一般取前两个词（"cargo build"、"git commit"），
 * 运行脚本的命令取三个词（"npm run build"）。第二个词就是选项（"rm -rf x"）、只有一个词、
 * 或者分不了词时，只允许这一条命令本身
 */
export function bashRule(command: string): AllowRule {
  const exact = { tool: "bash", command: command.trim() };
  const words = shellWords(command)?.map((w) => w.value);
  if (!words || words.length < 2 || words[1]!.startsWith("-") || words.some((w) => DANGEROUS_ARGS.test(w))) return exact;
  const n = RUNNERS.test(words.slice(0, 2).join(" ")) && words.length >= 3 && !words[2]!.startsWith("-") ? 3 : 2;
  return { tool: "bash", prefix: words.slice(0, n).join(" ") };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** 真实路径：解析符号链接；路径还不存在时解析最近的已存在的上级目录 */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

export function policy(opts: PolicyOptions): Policy {
  const id = opts.id ?? "jade/policy";
  const defaults: PolicySettings = { mode: opts.mode ?? "ask", rules: [] };
  /** p 在 base 目录里 */
  const within = (base: string, p: string) => {
    // 按真实路径比较：目录里指向外面的符号链接也算外面
    const rel = path.relative(real(base), real(path.resolve(opts.cwd, p)));
    // 只有 ".." 这一段才表示上级目录，名为 "..foo" 的目录仍在里面
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const inside = (p: string) => within(opts.cwd, p);
  /** glob 的 pattern 是绝对路径或含 ".." 段时，匹配范围会超出 path */
  const globEscapes = (pattern: string) => path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..");
  /** 以 "." 或 "[" 开头的通配段可能匹配到 ".."（取决于 bash 版本和选项），按越界处理 */
  const mayMatchParent = (value: string) => value.split(/[\\/]/).some((seg) => /^[.[]/.test(seg) && /[*?[]/.test(seg));
  /**
   * 命令参数里有指向工作目录之外的路径。选项也要看：--opt=path 的值，以及粘在短选项后面的值（-f/etc/x）。
   * 分不了词的命令按越界处理
   */
  const argsOutside = (command: string) => {
    const words = shellWords(command);
    if (!words) return true;
    return words.slice(1).some((w) => {
      const v = w.value;
      const candidates = !v.startsWith("-")
        ? [v]
        : [v.includes("=") ? v.slice(v.indexOf("=") + 1) : "", !v.startsWith("--") && v.length > 2 ? v.slice(2) : ""];
      return candidates.some(
        (c) => c !== "" && (c.startsWith("~") || !inside(c) || (w.glob && mayMatchParent(c))),
      );
    });
  };

  const self: Policy = {
    settings(derived) {
      return structuredClone((derived[POLICY_KEY] as PolicySettings | undefined) ?? defaults);
    },
    ruleFor(call) {
      if (call.name === "bash") return bashRule(String((call.input as { command?: unknown }).command ?? ""));
      const input = call.input as { path?: unknown; url?: unknown } | null;
      if (typeof input?.url === "string") {
        const host = hostOf(input.url);
        if (host) return { tool: call.name, host };
      }
      if (typeof input?.path === "string" && !inside(input.path)) {
        const full = path.resolve(opts.cwd, input.path);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // 还不存在的文件
        }
        return { tool: call.name, dir: isDir ? full : path.dirname(full) };
      }
      return { tool: call.name };
    },
    decide(call, { mode, rules }) {
      const { tool } = call;
      const problem = validate(tool.inputSchema, call.input);
      if (problem) return { decision: "deny", reason: `Invalid input for ${call.name}: ${problem}. Fix the arguments and try again.` };

      const input = call.input as { path?: string; command?: string; pattern?: string; url?: string };
      const outside =
        (typeof input.path === "string" && !inside(input.path)) ||
        (call.name === "glob" && typeof input.pattern === "string" && globEscapes(input.pattern));
      /** 会把参数发到网络上的只读工具 */
      const network = typeof input.url === "string";
      const covers = (r: AllowRule) => {
        if (r.tool !== call.name) return false;
        if (r.command !== undefined) return (input.command ?? "").trim() === r.command;
        if (r.prefix !== undefined) return matchesPrefix(input.command ?? "", r.prefix);
        // glob 的 pattern 越界时路径本身说明不了范围，目录规则不算
        if (r.dir !== undefined) return typeof input.path === "string" && within(r.dir, input.path) && !(call.name === "glob" && globEscapes(input.pattern ?? ""));
        if (r.host !== undefined) return network && hostOf(input.url!) === r.host;
        return !outside;
      };
      const ruled = [...rules, ...(opts.rules?.() ?? [])].some(covers);
      // 只读命令也要和 read_file 一样：读工作目录之外的东西先问
      const safeBash = call.name === "bash" && isSafeCommand(input.command ?? "");
      const safeDecision = (): GateResult => ({ decision: argsOutside(input.command ?? "") ? "ask" : "allow" });

      if (tool.effect === "read") {
        if (mode === "yolo" || ruled || (!outside && !network)) return { decision: "allow" };
        return { decision: "ask" };
      }
      if (mode === "readonly") {
        if (safeBash) return safeDecision();
        return {
          decision: "deny",
          reason: `The session is in read-only mode, so ${call.name} is not allowed. Describe the change instead of making it.`,
        };
      }
      if (mode === "yolo" || ruled) return { decision: "allow" };
      if (tool.effect === "write") return { decision: mode === "auto-edit" && !outside ? "allow" : "ask" };
      // external
      if (safeBash) return safeDecision();
      return { decision: "ask" };
    },
    plugin: {
      id,
      version: "0.2.0",
      kernel: "^0.1",
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
