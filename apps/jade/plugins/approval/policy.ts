// 审批规则：按模式、工具的 effect、路径和"总是允许"的规则决定一次工具调用是放行、拒绝还是问用户。
// 纯判断，不碰界面和日志；那些在 index.ts。
//
// 带 url 参数的只读工具（web_fetch）也要问：网页里的提示注入可以让模型把读到的内容拼进 URL 发出去。
// 指向本机的 URL（localhost 上的开发服务器，截图最常见的用途）不问：数据不会离开这台机器。

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { GatedToolCall, GateResult } from "uncarved";
import type { ApprovalMode } from "@uncarved/jade-api/services";
import { validate } from "./schema.ts";

/**
 * 权限模式。ask：改东西先问；auto：工作目录里的改动和只建目录、碰文件的命令不问；
 * plan：不改任何东西，拒绝时告诉模型先给出计划；readonly：不改任何东西（子 Agent 用）；yolo：什么都不问
 */
export const MODES = ["ask", "auto", "plan", "readonly", "yolo"] as const satisfies readonly ApprovalMode[];
export type Mode = (typeof MODES)[number];

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
  /** 工作目录之外也可以直接读取的目录，只影响只读工具 */
  readRoots?: string[];
  /** 工作目录之外、和工作目录同样对待的目录（读、写、命令参数），例如会话的临时目录 */
  writeRoots?: string[];
}

export interface Policy {
  /** 给"总是允许"一个默认规则：bash 取命令的前两个词，工作目录之外的路径取所在目录，URL 取主机，其他取工具名 */
  /** 用户选"总是允许"时记下的规则；bash 的复合命令可能是好几条 */
  rulesFor(call: { name: string; input: unknown }): AllowRule[];
  decide(call: GatedToolCall, settings: PolicySettings): GateResult;
  /** 工具参数里的相对路径换成绝对路径，日志里记下的、关卡判断的都是确定的路径 */
  absolutePath(input: unknown): unknown;
}

/** 白名单命令里会写文件或执行其他程序的参数 */
const UNSAFE_ARGS = [/\s--(output|pre|pre-glob|ext-diff|textconv|open-files-in-pager)(=|\s|$)/];

/** 不管参数是什么都只读的命令（路径另外检查） */
const READ_ANY = new Set(
  (
    "ls pwd cat head tail wc echo printf which whoami file stat du df basename dirname realpath readlink " +
    "cut tr nl column comm diff cmp md5sum sha1sum sha256sum sha512sum cksum od hexdump strings tac rev fold expand paste join " +
    "uname id groups true false seq printenv grep egrep fgrep rg jq type"
  ).split(" "),
);
/** 带 --version 之类的参数时只读的命令 */
const VERSIONED = new Set(
  "node bun deno python python3 pip pip3 go cargo rustc tsc npm pnpm yarn npx java javac gcc g++ clang make cmake git ruby php dotnet uv".split(" "),
);
const VERSION_ARGS = new Set(["--version", "-v", "-V", "version"]);
/** 只读的 git 子命令；其余的（branch、tag、stash……）要看参数 */
const GIT_READ = new Set(
  (
    "status diff log show blame annotate ls-files shortlog describe rev-parse rev-list merge-base name-rev " +
    "cat-file ls-tree for-each-ref show-ref count-objects check-ignore grep whatchanged show-branch"
  ).split(" "),
);
/** find 里会删除、写文件或执行程序的表达式 */
const FIND_UNSAFE = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
/** sed -n 只打印行号范围的脚本：10p、10,20p、$p */
const SED_PRINT = /^(\d+|\$)(,(\d+|\$))?p$/;

/**
 * 用默认程序打开后只是查看的文件：浏览器、图片查看器、PDF 阅读器、文本编辑器。
 * 不含 .js（Windows 默认用 WSH 执行）、.bat、.lnk、.url 这类打开就会执行或跳转的
 */
const VIEWABLE = /\.(html?|svg|png|jpe?g|gif|webp|bmp|ico|pdf|md|txt)$/i;

/**
 * 打开文件给用户看的命令：start "" <文件>（Windows，Git 自带的 /usr/bin/start）、open <文件>（macOS）、xdg-open <文件>。
 * 只认一个本地文件、扩展名是 VIEWABLE 的形式；路径在不在工作目录里由调用方另外检查。
 * URL（会把内容带到网络上）、选项、cmd 会特殊处理的字符都不认
 */
function opensForViewing(name: string, args: string[]): boolean {
  let files: string[];
  if (name === "start") files = args[0] === "" ? args.slice(1) : args;
  else if (name === "xdg-open" || (name === "open" && process.platform === "darwin")) files = args;
  else return false;
  if (files.length !== 1) return false;
  const f = files[0]!;
  // 盘符（D:\、D:/）之外的 xxx: 都当成 URL 或协议
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(f) && !/^[a-z]:[\\/]/i.test(f);
  // cmd 的 start 把 /wait、/b 这样的词当成开关；/d/x.html 这种 Git Bash 路径不算
  const startSwitch = name === "start" && /^\/[^/]*$/.test(f);
  return !scheme && !startSwitch && !f.startsWith("-") && !/[%^&|<>"!]/.test(f) && VIEWABLE.test(f);
}

const positional = (args: string[]) => args.filter((a) => !a.startsWith("-"));
const onlyFlags = (args: string[], allowed: string[]) => args.every((a) => allowed.includes(a));

function gitKind(args: string[]): CommandKind | undefined {
  let i = 0;
  while (args[i] === "--no-pager") i++;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return undefined;
  if (VERSION_ARGS.has(sub) && rest.length === 0) return "read";
  if (GIT_READ.has(sub)) return sub === "grep" && rest.some((a) => /^-[a-zA-Z]*O/.test(a)) ? undefined : "read";
  // 带参数的 branch、tag 可能删除、重命名、创建，只放行列出的形式
  if (sub === "branch") return onlyFlags(rest, ["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--show-current"]) ? "read" : undefined;
  if (sub === "tag") return onlyFlags(rest, ["-l", "--list", "-n"]) ? "read" : undefined;
  if (sub === "remote") return onlyFlags(rest, ["-v", "--verbose"]) ? "read" : undefined;
  if (sub === "stash" || sub === "worktree") return rest[0] === "list" || (sub === "stash" && rest[0] === "show") ? "read" : undefined;
  if (sub === "submodule") return rest[0] === "status" ? "read" : undefined;
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show" || /^-/.test(rest[0]!) ? "read" : undefined;
  if (sub === "config") return rest.length > 0 && ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(rest[0]!) ? "read" : undefined;
  return undefined;
}

type CommandKind = "read" | "edit";

/**
 * 一条简单命令（已分好词）的性质：read 只读；edit 只在工作目录里建目录、碰文件，auto 模式下和改文件一样不问；
 * undefined 表示不认识或可能有副作用
 */
export function commandKind(words: string[]): CommandKind | undefined {
  const [first, ...args] = words;
  if (first === undefined) return undefined;
  // /usr/bin/grep、/bin/cat 就是 grep、cat；别的目录下的同名程序不认
  const name = first.replace(/^\/(usr\/)?bin\/(?=[^/]+$)/, "");
  if (UNSAFE_ARGS.some((re) => re.test(` ${args.join(" ")} `))) return undefined;
  if (name === "git") return gitKind(args);
  // 不改任何文件，按只读算；打开工作目录之外的文件照常先问
  if (opensForViewing(name, args)) return "read";
  if (VERSIONED.has(name) && args.length === 1 && VERSION_ARGS.has(args[0]!)) return "read";
  if (READ_ANY.has(name)) {
    // file -C 会编译并写出 magic 文件
    if (name === "file" && args.some((a) => /^-[a-zA-Z]*C/.test(a))) return undefined;
    return "read";
  }
  switch (name) {
    case "tree":
      return args.some((a) => /^-[a-zA-Z]*o/.test(a)) ? undefined : "read";
    case "date":
      return args.some((a) => /^(-[a-zA-Z]*s|--set)/.test(a)) ? undefined : "read";
    case "hostname":
      return args.length === 0 ? "read" : undefined;
    case "sort":
      return args.some((a) => /^(-[a-zA-Z]*o|--compress-program)/.test(a)) ? undefined : "read";
    // 第二个位置参数是输出文件
    case "uniq":
    case "xxd":
      return positional(args).length <= 1 ? "read" : undefined;
    case "find":
      return args.some((a) => FIND_UNSAFE.test(a)) ? undefined : "read";
    case "sed": {
      // 只认 sed -n '10,20p' 文件……：sed 脚本里的 w、e 命令能写文件、执行程序，不去分析
      const i = args.findIndex((a) => !a.startsWith("-"));
      const flags = i < 0 ? args : args.slice(0, i);
      if (i < 0 || !flags.some((f) => ["-n", "--quiet", "--silent"].includes(f))) return undefined;
      if (!onlyFlags(flags, ["-n", "--quiet", "--silent", "-E", "-r"]) || !SED_PRINT.test(args[i]!)) return undefined;
      return args.slice(i + 1).some((a) => a.startsWith("-")) ? undefined : "read";
    }
    case "npm":
    case "pnpm":
    case "yarn":
      return ["ls", "list", "why"].includes(args[0] ?? "") ? "read" : undefined;
    case "mkdir":
    case "touch":
      return args.length > 0 ? "edit" : undefined;
  }
  return undefined;
}

/** shell 分词后的一个词。glob：含未加引号的通配符，shell 会展开它 */
interface Word {
  value: string;
  glob: boolean;
}

/** 控制符（&& || | ;）、重定向（> <，目标是下一个词）、文件描述符复制（2>&1，无害） */
type Token = Word | { op: "&&" | "||" | "|" | ";" | ">" | "<" | "dup" };

/** 词结束的位置：空白或操作符 */
const BOUNDARY = /[\s;&|<>]/;

/**
 * 只认简单的 shell 语法：空白分隔的词、单引号、不含展开的双引号、未加引号的通配符、
 * 控制符 && || | ; 和换行、重定向 > >> < &> 和 2>&1。
 * 其余一切（命令替换、变量、花括号展开、转义、注释、后台 &、here-doc……）返回 undefined，调用方一律按"不安全"处理，
 * 这样判断用的词和 shell 实际看到的参数一致
 */
function tokenize(command: string): Token[] | undefined {
  const out: Token[] = [];
  let cur: Word | undefined;
  const flush = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  const s = command.trim();
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flush();
      out.push({ op: ";" });
      i++;
      continue;
    }
    if (ch === "|") {
      flush();
      if (s[i + 1] === "&") return undefined;
      const two = s[i + 1] === "|";
      out.push({ op: two ? "||" : "|" });
      i += two ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      flush();
      if (s[i + 1] === "&") {
        out.push({ op: "&&" });
        i += 2;
        continue;
      }
      // &> 和 &>>：stdout、stderr 一起重定向
      if (s[i + 1] !== ">") return undefined;
      i += s[i + 2] === ">" ? 3 : 2;
      if (s[i] === "(" || s[i] === "&") return undefined;
      out.push({ op: ">" });
      continue;
    }
    if (ch === ">" || ch === "<") {
      // 紧挨在前面的一位数字是文件描述符（2>），其他的词先结束
      if (cur && /^\d$/.test(cur.value)) cur = undefined;
      else flush();
      i++;
      if (ch === "<" && (s[i] === "<" || s[i] === "(" || s[i] === ">" || s[i] === "&")) return undefined;
      if (ch === ">" && (s[i] === ">" || s[i] === "|")) i++;
      if (s[i] === "(") return undefined;
      if (ch === ">" && s[i] === "&") {
        const m = /^(\d|-)/.exec(s.slice(i + 1));
        if (!m || (s[i + 1 + m[0].length] !== undefined && !BOUNDARY.test(s[i + 1 + m[0].length]!))) return undefined;
        i += 1 + m[0].length;
        out.push({ op: "dup" });
        continue;
      }
      out.push({ op: ch });
      continue;
    }
    cur ??= { value: "", glob: false };
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return undefined;
      const inner = s.slice(i + 1, end);
      // 双引号里的反斜杠只在 $ ` " \ 和换行前面是转义，其他时候原样保留（Windows 路径 "D:\a\b"）；
      // 末尾的反斜杠转义的是这个引号，引号其实没有结束
      if (ch === '"' && (/[$`!]/.test(inner) || /\\([$`"\\\n]|$)/.test(inner))) return undefined;
      cur.value += inner;
      i = end + 1;
      continue;
    }
    if (/[`$()\r\\{}!#]/.test(ch)) return undefined;
    if (/[*?[\]]/.test(ch)) cur.glob = true;
    cur.value += ch;
    i++;
  }
  flush();
  return out;
}

const isWord = (t: Token | undefined): t is Word => t !== undefined && "value" in t;

/** 不含任何操作符的命令分成词；含操作符或分不了词时返回 undefined */
export function shellWords(command: string): Word[] | undefined {
  const tokens = tokenize(command);
  if (!tokens || !tokens.every(isWord)) return undefined;
  return tokens;
}

/** 复合命令里的一条简单命令。inputs、outputs：重定向的目标 */
export interface SimpleCommand {
  words: Word[];
  inputs: Word[];
  outputs: Word[];
}

/** 把命令按 && || | ; 拆成简单命令；有空命令或分不了词时返回 undefined */
export function shellCommands(command: string): SimpleCommand[] | undefined {
  const tokens = tokenize(command);
  if (!tokens) return undefined;
  const cmds: SimpleCommand[] = [];
  let cur: SimpleCommand = { words: [], inputs: [], outputs: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isWord(t)) cur.words.push(t);
    else if (t.op === "dup") continue;
    else if (t.op === ">" || t.op === "<") {
      const target = tokens[++i];
      if (!isWord(target)) return undefined;
      (t.op === ">" ? cur.outputs : cur.inputs).push(target);
    } else {
      if (cur.words.length === 0) return undefined;
      cmds.push(cur);
      cur = { words: [], inputs: [], outputs: [] };
    }
  }
  if (cur.words.length > 0) cmds.push(cur);
  // 结尾可以是 ;（或换行），不能是 && || |
  else if (!(tokens.length > 0 && (tokens.at(-1) as { op?: string }).op === ";")) return undefined;
  return cmds.length > 0 ? cmds : undefined;
}

const joined = (words: Word[]) => words.map((w) => w.value).join(" ");
/** 输出只能丢进 /dev/null：其他重定向会写文件 */
const quietOutputs = (c: SimpleCommand) => c.outputs.every((w) => !w.glob && w.value === "/dev/null");

/** 每条简单命令都只读（或是 cd），重定向只丢弃输出。不看路径 */
export function isSafeCommand(command: string): boolean {
  const cmds = shellCommands(command);
  return !!cmds && cmds.every((c) => quietOutputs(c) && (c.words[0]!.value === "cd" || commandKind(c.words.map((w) => w.value)) === "read"));
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
  return !!words && prefixCovers(words, prefix);
}

function prefixCovers(words: Word[], prefix: string): boolean {
  const c = joined(words);
  if (c !== prefix && !c.startsWith(prefix + " ")) return false;
  const extra = words.slice(prefix.split(" ").length);
  return !extra.some((w) => DANGEROUS_ARGS.test(w.value));
}

/**
 * bash 的"总是允许"默认规则：一般取前两个词（"cargo build"、"git commit"），
 * 运行脚本的命令取三个词（"npm run build"）。第二个词就是选项（"rm -rf x"）、只有一个词时，只允许这一条命令本身。
 * 复合命令（"git add -A && git commit -m …"、"bun test 2>&1 | tail -20"）里每条不是只读的命令各记一条：
 * 关卡对复合命令逐条判断，所以下次换了提交信息、换了组合也不用再问。
 * 分不了词、有输出重定向、或者不是只读的命令带输入重定向时，只允许整条命令原文
 */
export function bashRules(command: string): AllowRule[] {
  const exact = [{ tool: "bash", command: command.trim() }];
  const cmds = shellCommands(command);
  const unsafe = cmds?.filter((c) => c.words[0]!.value !== "cd" && commandKind(c.words.map((w) => w.value)) !== "read");
  if (!cmds || !unsafe || unsafe.length === 0 || !cmds.every(quietOutputs) || unsafe.some((c) => c.inputs.length > 0)) return exact;
  // 只有一条命令、又只能按原文记时，记整条原文（和关卡比较的是同一个字符串）
  if (cmds.length === 1 && !prefixOf(unsafe[0]!.words)) return exact;
  const rules = unsafe.map((c): AllowRule => {
    const prefix = prefixOf(c.words);
    return prefix ? { tool: "bash", prefix } : { tool: "bash", command: joined(c.words) };
  });
  return rules.filter((r, i) => rules.findIndex((o) => o.prefix === r.prefix && o.command === r.command) === i);
}

/** 一条简单命令的前缀规则；只能按原文记时返回 undefined */
function prefixOf(all: Word[]): string | undefined {
  const words = all.map((w) => w.value);
  if (words.length < 2 || words[1]!.startsWith("-") || words.some((w) => DANGEROUS_ARGS.test(w))) return undefined;
  const n = RUNNERS.test(words.slice(0, 2).join(" ")) && words.length >= 3 && !words[2]!.startsWith("-") ? 3 : 2;
  return words.slice(0, n).join(" ");
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** 本机的地址：localhost、127.x.x.x、::1（URL 会把 127.1 这类写法规范成 127.0.0.1） */
const isLoopback = (host: string | undefined) =>
  host !== undefined && (host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]");

/**
 * Windows 上 bash 工具跑的是 Git Bash，模型常把路径写成 /c/Users/...（MSYS 的写法）。
 * path.resolve 会把它当成当前盘符下的 \c\Users\...，判断成工作目录之外，只读命令也要确认。
 * 换算成 C:/Users/... 再判断；/tmp、/usr 这类 MSYS 自己的目录不换算，仍然算在外面
 */
export function nativePath(p: string, platform: string = process.platform): string {
  if (platform !== "win32") return p;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? "/"}` : p;
}

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
  /**
   * 作为范围的目录（工作目录、登记的目录、规则里的目录）的真实路径，本会话内记住：复合命令的每个参数都要和它们比，
   * 每次都 realpathSync 是一串同步 IO。只记已经存在的；要判断的路径本身每次都重新解析，符号链接可能随时被换掉
   */
  const bases = new Map<string, string>();
  const realBase = (dir: string): string => {
    let r = bases.get(dir);
    if (r !== undefined) return r;
    try {
      r = realpathSync(dir);
    } catch {
      return real(dir);
    }
    bases.set(dir, r);
    return r;
  };
  /** 真实路径 target 在真实路径 base 里 */
  const contains = (base: string, target: string) => {
    const rel = path.relative(base, target);
    // 只有 ".." 这一段才表示上级目录，名为 "..foo" 的目录仍在里面
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  /** p 在 base 目录里。按真实路径比较：目录里指向外面的符号链接也算外面 */
  const within = (base: string, p: string) => contains(realBase(base), real(path.resolve(opts.cwd, p)));
  const inside = (p: string) => {
    const target = real(path.resolve(opts.cwd, p));
    return contains(realBase(opts.cwd), target) || (opts.writeRoots ?? []).some((r) => contains(realBase(r), target));
  };
  /** glob 的 pattern 是绝对路径或含 ".." 段时，匹配范围会超出 path */
  const globEscapes = (pattern: string) => path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..");
  /** 以 "." 或 "[" 开头的通配段可能匹配到 ".."（取决于 bash 版本和选项），按越界处理 */
  const mayMatchParent = (value: string) => value.split(/[\\/]/).some((seg) => /^[.[]/.test(seg) && /[*?[]/.test(seg));
  /** 相对 base 目录的路径 p 指向工作目录之外 */
  const pathOutside = (base: string, p: string, glob: boolean) =>
    p.startsWith("~") || !inside(path.resolve(base, nativePath(p))) || (glob && mayMatchParent(p));
  /**
   * 命令参数里有指向工作目录之外的路径。选项也要看：--opt=path 的值，以及粘在短选项后面的值（-f/etc/x）
   */
  const argsOutside = (base: string, words: Word[]) =>
    words.slice(1).some((w) => {
      const v = w.value;
      const candidates = !v.startsWith("-")
        ? [v]
        : [v.includes("=") ? v.slice(v.indexOf("=") + 1) : "", !v.startsWith("--") && v.length > 2 ? v.slice(2) : ""];
      return candidates.some((c) => c !== "" && pathOutside(base, c, w.glob));
    });
  /**
   * 判断一条 bash 命令能不能不问就执行。复合命令（&& || | ;）要求每条简单命令都满足：
   * 只读命令；edits 时还可以是建目录、碰文件的命令；ruled 时还可以是"总是允许"的规则覆盖的命令。
   * 输出重定向只能是 /dev/null。cd 到工作目录里的目录后，后面的相对路径按新目录算。
   * 返回 inside（可以放行）、outside（认识，但碰到了工作目录之外的路径，先问）、undefined（不认识）
   */
  const classifyBash = (
    command: string,
    { edits, ruled }: { edits: boolean; ruled?: (words: Word[]) => boolean },
  ): "inside" | "outside" | undefined => {
    const cmds = shellCommands(command);
    if (!cmds) return undefined;
    let base = opts.cwd;
    let outside = false;
    for (const c of cmds) {
      if (!quietOutputs(c) || c.words[0]!.glob) return undefined;
      if (c.inputs.some((w) => w.value !== "/dev/null" && pathOutside(base, w.value, w.glob))) outside = true;
      if (c.words[0]!.value === "cd") {
        const target = c.words[1];
        // 不带参数的 cd 回到 home；cd 到外面以后，后面的相对路径都说不清了
        if (!target || c.words.length > 2 || target.glob || target.value.startsWith("-") || pathOutside(base, target.value, false)) return undefined;
        base = path.resolve(base, nativePath(target.value));
        continue;
      }
      // 规则覆盖的命令和原来的前缀规则一样不看路径
      if (ruled?.(c.words)) continue;
      const kind = commandKind(c.words.map((w) => w.value));
      if (!kind || (kind === "edit" && !edits)) return undefined;
      if (argsOutside(base, c.words)) outside = true;
    }
    return outside ? "outside" : "inside";
  };
  /** 把 classifyBash 的结果变成决定 */
  const bashGate = (r: "inside" | "outside" | undefined): GateResult | undefined =>
    r === undefined ? undefined : { decision: r === "outside" ? "ask" : "allow" };

  return {
    absolutePath(input) {
      if (!input || typeof input !== "object" || typeof (input as { path?: unknown }).path !== "string") return input;
      return { ...input, path: path.resolve(opts.cwd, (input as { path: string }).path) };
    },
    rulesFor(call) {
      if (call.name === "bash") return bashRules(String((call.input as { command?: unknown }).command ?? ""));
      const input = call.input as { path?: unknown; url?: unknown } | null;
      if (typeof input?.url === "string") {
        const host = hostOf(input.url);
        if (host) return [{ tool: call.name, host }];
      }
      if (typeof input?.path === "string" && !inside(input.path)) {
        const full = path.resolve(opts.cwd, input.path);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // 还不存在的文件
        }
        return [{ tool: call.name, dir: isDir ? full : path.dirname(full) }];
      }
      return [{ tool: call.name }];
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
      const network = typeof input.url === "string" && !isLoopback(hostOf(input.url));
      const covers = (r: AllowRule) => {
        if (r.tool !== call.name) return false;
        if (r.command !== undefined) return (input.command ?? "").trim() === r.command;
        if (r.prefix !== undefined) return matchesPrefix(input.command ?? "", r.prefix);
        // glob 的 pattern 越界时路径本身说明不了范围，目录规则不算
        if (r.dir !== undefined) return typeof input.path === "string" && within(r.dir, input.path) && !(call.name === "glob" && globEscapes(input.pattern ?? ""));
        if (r.host !== undefined) return network && hostOf(input.url!) === r.host;
        return !outside;
      };
      const allRules = rules;
      const ruled = allRules.some(covers);
      /** 复合命令里的一条简单命令被 bash 规则覆盖 */
      const ruledWords = (words: Word[]) =>
        allRules.some(
          (r) =>
            r.tool === "bash" &&
            ((r.command !== undefined && joined(words) === r.command) || (r.prefix !== undefined && prefixCovers(words, r.prefix))),
        );
      const isBash = call.name === "bash";
      const command = input.command ?? "";

      if (tool.effect === "read") {
        const readable =
          !outside ||
          (typeof input.path === "string" && call.name !== "glob" && (opts.readRoots ?? []).some((r) => within(r, input.path!)));
        if (mode === "yolo" || ruled || (readable && !network)) return { decision: "allow" };
        return { decision: "ask" };
      }
      // plan：和 readonly 一样不改任何东西，只是拒绝的理由告诉模型先给出计划
      if (mode === "readonly" || mode === "plan") {
        // 只读命令也要和 read_file 一样：读工作目录之外的东西先问
        const gate = isBash ? bashGate(classifyBash(command, { edits: false })) : undefined;
        if (gate) return gate;
        return {
          decision: "deny",
          reason:
            mode === "plan"
              ? `The session is in plan mode, so ${call.name} is not allowed yet. Finish investigating, then present your plan for the user to approve as the plan mode instructions describe (with propose_plan when you have it).`
              : `The session is in read-only mode, so ${call.name} is not allowed. Describe the change instead of making it.`,
        };
      }
      if (mode === "yolo" || ruled) return { decision: "allow" };
      if (tool.effect === "write") return { decision: mode === "auto" && !outside ? "allow" : "ask" };
      // external
      const gate = isBash ? bashGate(classifyBash(command, { edits: mode === "auto", ruled: ruledWords })) : undefined;
      return gate ?? { decision: "ask" };
    },
  };
}
