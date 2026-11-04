// 第三方插件的发现与加载。
//
// 插件放在 $JADE_HOME/plugins/<name>/（用户层）和 .jade/plugins/<name>/（项目层，从仓库根目录到工作目录逐级查找）。
// 一个目录就是一个插件，两种形式：
// - 进程内：TypeScript / JavaScript 模块，默认导出插件对象，或者返回插件对象的工厂函数（每个会话调用一次）；
// - 进程外：plugin.json 里写了 command，jade 启动这个进程，经 stdio 用 JSON-RPC 通信（@uncarved/plugin-stdio），
//   可以用任何语言编写，只能提供 hook。
// 两种形式之外（或者没有代码时），插件目录还可以带上内容：skills/、commands/、mcp.json（或 .mcp.json），
// 和 jade 自己的 skills、自定义命令、MCP 配置格式相同。也认 Claude Code 插件的 .claude-plugin/plugin.json。
// 项目层插件随仓库分发，首次加载和内容变化后要用户确认（宪法 7.1）；用户层插件是用户自己装的，不再确认。
// 只带内容的项目层插件不执行代码，不用确认（skills 和命令是给模型的文字，MCP 服务另有确认）。

import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Choice } from "../ui/screen.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnPlugin, type StdioPlugin } from "@uncarved/plugin-stdio";
import { definePlugin, loadProjectPluginFactory, type Awaitable, type Message, type Plugin, type TrustStore, type Usage } from "uncarved";
import { projectDirs } from "../commands.ts";
import type { RunCommand } from "../tools/shell.ts";
import type { Question } from "../tools/ask.ts";
import type { Checkpoint } from "../tools/checkpoint.ts";
import type { ProviderDef } from "../provider.ts";

/** 插件提供的模型服务，见 provider.ts 的 ProviderDef */
export type PluginProvider = ProviderDef;

export const JADE_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export type PluginLayer = "user" | "project";

/** jade 创建插件实例时传给工厂函数的参数 */
export interface JadePluginContext {
  /** jade 的版本 */
  jade: string;
  /** 工作目录（已解析符号链接） */
  cwd: string;
  /** 仓库根目录；不在 git 仓库里时等于 cwd */
  root: string;
  /** jade 的数据目录（$JADE_HOME） */
  home: string;
  /** 插件自己的目录 */
  dir: string;
  layer: PluginLayer;
  /** 同 uncarved 的 definePlugin：补上 kernel 和 hooks 用到的 needs。项目层插件通常 import 不到 uncarved，用这个 */
  definePlugin: <T extends JadePluginDraft>(draft: T) => T & JadePlugin;
  /** 用 jade 的 shell 执行命令，超时或中断时连同子进程一起结束；找不到 shell 时没有 */
  run?: RunCommand;
  /**
   * 用当前配置的模型发一次请求：不带工具，不记进会话，和会话共用限速和重试；用户切换模型后用新的。
   * 返回回复的文字；onText 收到流式输出的片段，拿到想要的内容后可以用 signal 中止
   */
  complete(req: CompleteRequest, signal: AbortSignal): Promise<CompleteResult>;
  /** 设置状态栏上本插件的那一段文字（一行，过长时截断，窗口窄时先被去掉）；undefined 去掉 */
  status(text: string | undefined): void;
  /** 文件快照：写文件的工具写之前记下原内容，/undo 据此恢复。见 FileCheckpoints */
  checkpoints: FileCheckpoints;
  /** 终端界面的输入框（见 InputControl）。只给用户层插件；非交互运行（-p）时没有 */
  input?: InputControl;
  /**
   * 替用户提交一行，和在输入框里按回车一样：/ 开头的是命令，消息先经过各插件的 beforeSend；模型正忙时排队。
   * 对话里会注明是哪个插件发的。只给用户层插件（它能替用户说话）；非交互运行（-p）时没有
   */
  send?(text: string): void;
}

/** 输入框里用户还没提交的文字 */
export interface InputControl {
  /** 现在的文字 */
  text(): string;
  /** 在光标处插入，光标移到插入的文字后面 */
  insert(text: string): void;
  /** 换掉全部文字，光标放到末尾；空字符串清空 */
  set(text: string): void;
}

/** "ctrl+<字母>" 或 "alt+<字母或数字>" */
export const KEY_SPEC = /^(ctrl\+[a-z]|alt\+[a-z0-9])$/;
/**
 * jade 自己用的键，插件不能用：编辑（ctrl+a/e/d/w/u/k，alt+f）、搜索历史（ctrl+r）、重画（ctrl+l）、展开（ctrl+o）、
 * 中断和退出（ctrl+c），以及终端里等同于退格、Tab、回车的 ctrl+h/i/j/m
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(
  [..."acdehijklmoruw"].map((c) => `ctrl+${c}`).concat("alt+f"),
);

/** 插件的快捷键：输入框有焦点时按下（模型工作时也算）调用 run；弹出对话框时不响应 */
export interface PluginKey {
  /** 见 KEY_SPEC；不分大小写，不能是 RESERVED_KEYS 里的 */
  key: string;
  /** /help 里显示 */
  description?: string;
  /** 出错时在对话里显示警告。要改输入框、发消息用插件上下文的 input、send */
  run(): Awaitable<void>;
}

/**
 * 文件快照，按会话存放，不进日志。jade/fs 的写文件工具和 jade/undo 都只用这个接口：
 * 第三方插件的工具写文件前也调用 save，/undo 就能撤销它的修改
 */
export interface FileCheckpoints {
  /**
   * 写文件之前调用（用工具调用的 ctx.sessionId、ctx.toolUseId）。path 是绝对路径；before 是原内容，null 表示文件原本不存在；
   * afterHash 是写入后内容（UTF-8）的 sha256 十六进制，撤销前用它判断文件之后有没有被别人改过
   */
  save(sessionId: string, cp: Omit<Checkpoint, "at">): Promise<void>;
  /** 会话的全部快照，最新的在前 */
  list(sessionId: string): Promise<Checkpoint[]>;
  /** 文件现在的内容还是不是这次写入后的样子 */
  unchangedSince(cp: Checkpoint): Promise<boolean>;
  /** 把文件恢复成 before（before 为 null 时删掉文件） */
  restore(cp: Checkpoint): Promise<void>;
}

export interface CompleteRequest {
  system?: string;
  prompt: string;
  onText?(delta: string): void;
}

export interface CompleteResult {
  text: string;
  /** 实际回复的模型 */
  model: string;
  usage?: Usage;
}

/** 斜杠命令和用户交互用的界面。非交互运行（-p）时 select / input 直接返回 undefined */
export interface CommandUI {
  readonly interactive: boolean;
  /** 输出一段文字（可以带 ANSI 颜色） */
  log(text: string): void;
  /** 让用户从几项里选一项；取消时返回 undefined */
  select<T>(title: string, choices: Choice<T>[], opts?: { body?: string }): Promise<T | undefined>;
  /** 让用户输入一行；取消时返回 undefined */
  input(title: string, opts?: { initial?: string; placeholder?: string; mask?: boolean }): Promise<string | undefined>;
}

export interface PluginCommandContext {
  sessionId: string;
  cwd: string;
  /** 用户按 esc 或退出时中断 */
  signal: AbortSignal;
  /** 当前会话的派生数据（各插件用 ctx.record 写入的） */
  derived: Readonly<Record<string, unknown>>;
  ui: CommandUI;
  /** 附在用户下一条消息前面告诉模型的话，例如"用户删掉了某条记忆" */
  note(text: string): void;
  /** 操作会话（见 SessionControl）；instant 的命令在模型工作时执行，没有这个字段 */
  session?: SessionControl;
}

/** 这个目录里的一个会话（会话索引里的一项） */
export interface SessionSummary {
  id: string;
  /** 第一条消息的开头 */
  title: string;
  /** 最近一次使用的时间（ISO） */
  at: string;
}

/**
 * 斜杠命令操作会话用的接口，jade 自己的 /clear、/resume、/retry、/undo 也只用它。
 * 换会话之后它指向新的会话：之后的 messages()、record() 都是新会话的
 */
export interface SessionControl {
  /** 当前会话的消息（拷贝） */
  messages(): Message[];
  /** 写一项派生数据进日志（derived.recorded），恢复会话后仍在。key 只能是插件的 id 或以 "<id>/" 开头 */
  record(key: string, value: unknown): Promise<void>;
  /** 这个工作目录里的会话，最近用过的在前 */
  list(): Promise<SessionSummary[]>;
  /** 开始新会话，当前的保留、可以恢复 */
  clear(): Promise<void>;
  /** 换到会话 id；恢复失败时留在当前会话并显示原因 */
  resume(id: string): Promise<void>;
  /** 上一次请求在模型回复之前就失败了时重新请求，不用再发消息；没有可重试的返回 false */
  retry(): Promise<boolean>;
  /**
   * 用新的插件实例继续当前会话，对话内容不变：工具和系统提示词按现在的配置重新生成（例如改了 $JADE_HOME/.env 之后）。
   * 调用它的插件实例随之被换掉，之后不要再用它的状态
   */
  reload(): Promise<void>;
}

/** 字符串：显示给用户；{ prompt }：作为用户消息发给模型；不返回：什么也不做 */
export type PluginCommandResult = string | { prompt: string } | void | undefined;

/** 插件提供的斜杠命令 */
export interface PluginCommand {
  name: string;
  description?: string;
  /** 参数提示，例如 "<file>" */
  args?: string;
  /**
   * 不碰会话状态（只查看、只改插件自己的设置）的命令设为 true：模型工作时也立即执行，不排队。
   * 这种命令返回 { prompt } 无效
   */
  instant?: boolean;
  run(args: string, ctx: PluginCommandContext): Awaitable<PluginCommandResult>;
}

/** 宿主请用户批准的一个工具调用 */
export interface ApprovalRequest {
  /** 显示给用户的一行，例如 "bash(npm test)"；子 Agent 的调用以 "sub-agent " 开头 */
  title: string;
  tool: string;
  input: unknown;
  /** 和终端里一样的预览（diff、命令），不带颜色 */
  preview: string;
  /** 为什么要问，例如 auto 模式下审查转给用户的理由 */
  reason?: string;
}

/**
 * 在终端之外回答用户该回答的问题（例如经聊天机器人发到手机上）。宿主同时等终端和所有 responder，
 * 用最先给出的回答，然后中止其余的（signal）。返回 undefined 表示这次不回答，宿主继续等别的。
 * 只有用户层的插件能提供：它能替用户批准操作
 */
export interface Responder {
  /** message：用户拒绝时说的话，会转告模型 */
  approve?(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; message?: string } | undefined>;
  /** ask_user 的问题：每个问题一个回答 */
  ask?(questions: Question[], signal: AbortSignal): Promise<string[] | undefined>;
}

/**
 * 预测用户的下一条消息，在输入框里显示成灰字（→ 或 Tab 接受，Ctrl+→ 接受一个词，Esc 丢弃）。
 * 只在终端界面里、一轮正常结束后调用；出错、中断、子 Agent、jade -p 都不调用。
 * 返回整条文字，或者流式返回片段；只显示第一行。用户提交新输入或按 Esc 时 signal 中止
 */
export interface Suggester {
  next(ctx: { sessionId: string; messages: Message[] }, signal: AbortSignal): Promise<string | undefined> | AsyncIterable<string>;
}

/** jade 的插件：内核的 Plugin，外加 jade 认识的扩展字段 */
export interface JadePlugin extends Plugin {
  commands?: PluginCommand[];
  /** 见 Responder；项目层插件的会被忽略 */
  responder?: Responder;
  /** 见 Suggester；多个插件都提供时只用第一个 */
  suggest?: Suggester;
  /** 快捷键，见 PluginKey；和排在前面的插件用了同一个键时忽略 */
  keys?: PluginKey[];
  /**
   * 模型服务，用 JADE_PROVIDER=<kind> 选择。只认用户层插件（服务能看到全部对话和 API key）；
   * 只在启动时读一次，之后的会话共用，所以不要依赖按会话的状态
   */
  providers?: PluginProvider[];
  /**
   * 用户输入的消息发给模型之前（斜杠命令、宿主自己发的话不经过）：返回新的文字代替原文，返回 undefined 不改，
   * 返回空字符串不发送。多个插件按加载顺序依次处理；改动会在对话里提示用户
   */
  beforeSend?(text: string, ctx: { sessionId: string; signal: AbortSignal }): Awaitable<string | undefined>;
  /**
   * 代替的内置插件的 id（例如 "jade/web"）：被代替的内置插件不再加载，它的工具名可以由本插件提供。
   * jade/policy 不能代替
   */
  replaces?: string[];
}

/** definePlugin 的输入：kernel、needs 可以省略 */
export type JadePluginDraft = Omit<JadePlugin, "kernel" | "needs"> & { kernel?: string; needs?: string[] };

export type JadePluginFactory = (ctx: JadePluginContext) => Awaitable<JadePlugin>;

/** 宿主（createJade）提供的那部分上下文；status、send 由加载器按插件的目录名转给宿主，input、send 只转给用户层插件 */
export type HostContext = Omit<JadePluginContext, "dir" | "layer" | "status" | "send"> & {
  status(plugin: string, text: string | undefined): void;
  send?(plugin: string, text: string): void;
};

/** plugin.json，可以没有 */
export interface PluginJson {
  /** jade plugin add 安装时用作目录名；/plugins 显示 */
  name?: string;
  version?: string;
  description?: string;
  /** 进程内插件的入口，默认依次找 index.ts、index.js、index.mjs */
  entry?: string;
  /** 进程外插件的启动命令；"./"、"../" 开头的相对于插件目录 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 默认 true：继承 jade 的全部环境变量 */
  inheritEnv?: boolean;
  /** 等插件回复 initialize 的时间，默认 10 秒 */
  initTimeoutMs?: number;
}

/** 插件目录带的内容（都是绝对路径） */
export interface PluginBundle {
  /** 每个目录里的 <name>/SKILL.md 是一个 skill */
  skills: string[];
  /** 每个目录里的 <name>.md 是一个斜杠命令 */
  commands: string[];
  /** MCP 服务：配置文件，或者 Claude Code 的 plugin.json 里直接写的 mcpServers */
  mcp?: { file: string; servers?: unknown };
  /** 认出来但 jade 还不支持的内容，例如 Claude Code 插件的 hooks、agents */
  unsupported: string[];
}

/** 不执行代码就能知道的插件信息 */
export interface PluginInfo {
  name?: string;
  version?: string;
  description?: string;
  /** module：TS/JS 模块；process：plugin.json 写了 command；content：没有代码，只有 skills、命令、MCP 配置 */
  kind: "module" | "process" | "content";
  /** module 的入口文件（相对于插件目录） */
  entry?: string;
  json: PluginJson;
  bundle: PluginBundle;
}

export interface FoundPlugin {
  /** 目录名 */
  name: string;
  dir: string;
  layer: PluginLayer;
}

export interface LoadedPlugin extends FoundPlugin {
  kind: PluginInfo["kind"];
  /** 模块入口（相对于插件目录），或者进程外插件的启动命令；只有内容的插件为空字符串 */
  entry: string;
  info: PluginInfo;
  /** 创建一套实例，每个会话调用一次；进程外插件只有一个进程，每次返回同一个对象。只有内容的插件没有 */
  create?(host: HostContext): Promise<JadePlugin>;
  /** 进程外插件：结束进程 */
  close?(): Promise<void>;
  /** 进程外插件的状态：退出信息和最近的 stderr */
  process?: { exited?: { code: number | null; signal: string | null }; stderr: string[] };
}

export interface ConfirmPlugin {
  (request: { path: string; hash: string; files: string[]; command?: string }): Promise<boolean>;
}

export interface LoadOptions {
  trust: TrustStore;
  /** 项目层插件新出现或内容变化时请用户确认 */
  confirm: ConfirmPlugin;
  /** 进程外插件意外退出 */
  onExit?(plugin: LoadedPlugin, exit: { code: number | null; signal: string | null }): void;
}

const ENTRIES = ["index.ts", "index.js", "index.mjs"];
const STDERR_LINES = 20;

/** 用户层在前；项目层从仓库根目录往下，同名目录近的覆盖远的 */
export async function discoverPlugins(opts: { home: string; root: string; cwd: string }): Promise<FoundPlugin[]> {
  const out = new Map<string, FoundPlugin>();
  await scan(path.join(opts.home, "plugins"), "user", out);
  for (const d of projectDirs(opts.root, opts.cwd)) await scan(path.join(d, ".jade", "plugins"), "project", out);
  return [...out.values()];
}

async function scan(root: string, layer: PluginLayer, out: Map<string, FoundPlugin>) {
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    // 跟随符号链接判断：用户层常把开发中的插件链接进来（项目层的链接会在计算哈希时被拒绝）
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) continue;
    out.set(`${layer}:${name}`, { name, dir, layer });
  }
}

export async function loadPlugin(found: FoundPlugin, opts: LoadOptions): Promise<LoadedPlugin> {
  const info = await inspectPlugin(found.dir);
  if (info.kind === "process") return loadProcess(found, info, opts);
  if (info.kind === "content") return { ...found, kind: "content", entry: "", info };

  const entry = info.entry!;
  const ctx = ({ input, send, ...host }: HostContext): JadePluginContext => ({
    ...host,
    ...(found.layer === "user" ? { input, send: send && ((text: string) => send(found.name, text)) } : {}),
    dir: found.dir,
    layer: found.layer,
    status: (text) => host.status(found.name, text),
  });

  if (found.layer === "project") {
    // 内核负责：先哈希整个目录、确认，再 import；检查 import 不越出插件目录
    const make = await loadProjectPluginFactory(found.dir, { trust: opts.trust, confirm: opts.confirm, entry });
    return { ...found, kind: "module", entry, info, create: async (host) => (await make(ctx(host))) as JadePlugin };
  }

  const file = path.resolve(found.dir, entry);
  const exported = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  if (typeof exported !== "function" && !isPlugin(exported)) throw new Error("default export is neither a plugin nor a function returning one");
  return {
    ...found,
    kind: "module",
    entry,
    info,
    async create(host) {
      const made = typeof exported === "function" ? await (exported as JadePluginFactory)(ctx(host)) : exported;
      if (!isPlugin(made)) throw new Error("plugin factory did not return a plugin");
      return { ...made, layer: "user" };
    },
  };
}

async function loadProcess(found: FoundPlugin, info: PluginInfo, opts: LoadOptions): Promise<LoadedPlugin> {
  const json = info.json;
  // Windows 上相对路径的命令按 jade 的工作目录查找，而不是子进程的，所以先换成绝对路径
  const command = /^\.\.?[\\/]/.test(json.command!) ? path.resolve(found.dir, json.command!) : json.command!;
  const shown = [json.command!, ...(json.args ?? [])].join(" ");
  const status: NonNullable<LoadedPlugin["process"]> = { stderr: [] };
  let partial = "";
  const proc: StdioPlugin = await spawnPlugin({
    command,
    args: json.args,
    env: json.env,
    inheritEnv: json.inheritEnv,
    cwd: found.dir,
    layer: found.layer,
    trust: found.layer === "project" ? { trust: opts.trust, confirm: (r) => opts.confirm({ ...r, command: shown }), dir: found.dir } : undefined,
    initTimeoutMs: json.initTimeoutMs,
    onStderr: (text) => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      status.stderr.push(...lines);
      status.stderr.splice(0, Math.max(0, status.stderr.length - STDERR_LINES));
    },
  });
  const loaded: LoadedPlugin = {
    ...found,
    kind: "process",
    entry: shown,
    info,
    create: async () => proc,
    close: () => proc.close(),
    process: status,
  };
  void proc.exited.then((exit) => {
    status.exited = exit;
    if (partial) status.stderr.push(partial);
    try {
      opts.onExit?.(loaded, exit);
    } catch {
      // 通知失败不能变成未处理的 rejection
    }
  });
  return loaded;
}

/**
 * 读插件目录，不执行其中的代码：jade plugin add 用它检查和命名，loadPlugin 用它决定怎么加载。
 * 什么都提供不了的目录抛出错误
 */
export async function inspectPlugin(dir: string): Promise<PluginInfo> {
  const json = await readPluginJson(dir);
  const claude = await readJsonObject(path.join(dir, ".claude-plugin", "plugin.json"));
  const pkg = (await readJsonObject(path.join(dir, "package.json"), true)) ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const inside = (rel: unknown, what: string): string => {
    if (typeof rel !== "string" || !rel) throw new Error(`.claude-plugin/plugin.json: "${what}" must be a path`);
    const full = path.resolve(dir, rel);
    const r = path.relative(dir, full);
    if (r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) throw new Error(`.claude-plugin/plugin.json: "${what}" points outside the plugin`);
    return full;
  };
  const paths = (v: unknown, what: string) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map((x) => inside(x, what)));
  const isDir = async (p: string) => Boolean((await stat(p).catch(() => undefined))?.isDirectory());

  const bundle: PluginBundle = { skills: [], commands: [], unsupported: [] };
  for (const d of paths(claude?.skills, "skills") ?? [path.join(dir, "skills")]) if (await isDir(d)) bundle.skills.push(d);
  for (const d of paths(claude?.commands, "commands") ?? [path.join(dir, "commands")]) if (await isDir(d)) bundle.commands.push(d);
  const servers = claude?.mcpServers;
  if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
    bundle.mcp = { file: path.join(dir, ".claude-plugin", "plugin.json"), servers };
  } else if (servers !== undefined) {
    bundle.mcp = { file: inside(servers, "mcpServers") };
  } else {
    const file = await firstFile(dir, ["mcp.json", ".mcp.json"]);
    if (file) bundle.mcp = { file: path.join(dir, file) };
  }
  if (claude?.hooks !== undefined || (await firstFile(path.join(dir, "hooks"), ["hooks.json"]))) bundle.unsupported.push("hooks");
  if (claude?.agents !== undefined || (await isDir(path.join(dir, "agents")))) bundle.unsupported.push("agents");

  const meta = {
    name: str(json.name) ?? str(claude?.name) ?? str(pkg.name)?.replace(/^@[^/]+\//, ""),
    version: str(json.version) ?? str(claude?.version) ?? str(pkg.version),
    description: str(json.description) ?? str(claude?.description) ?? str(pkg.description),
  };
  if (json.command !== undefined) return { ...meta, kind: "process", json, bundle };
  const entry = json.entry ?? (await firstFile(dir, ENTRIES));
  if (entry) return { ...meta, kind: "module", entry, json, bundle };
  if (bundle.skills.length || bundle.commands.length || bundle.mcp) return { ...meta, kind: "content", json, bundle };
  throw new Error(`no ${ENTRIES.join(", ")}, no plugin.json, and no skills/, commands/ or mcp.json`);
}

/** 读一个 JSON 对象；文件不存在时返回 undefined。lenient：格式不对也返回 undefined（package.json 不归插件规范管） */
async function readJsonObject(file: string, lenient = false): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(text);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (err) {
    if (!lenient) throw new Error(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!lenient) throw new Error(`${path.basename(path.dirname(file))}/${path.basename(file)}: must be an object`);
  return undefined;
}

async function readPluginJson(dir: string): Promise<PluginJson> {
  let text: string;
  try {
    text = await readFile(path.join(dir, "plugin.json"), "utf8");
  } catch {
    return {};
  }
  let json: PluginJson;
  try {
    json = JSON.parse(text) as PluginJson;
  } catch (err) {
    throw new Error(`plugin.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const problem =
    typeof json !== "object" || json === null || Array.isArray(json)
      ? "must be an object"
      : json.entry !== undefined && typeof json.entry !== "string"
        ? '"entry" must be a string'
        : json.command !== undefined && (typeof json.command !== "string" || !json.command)
          ? '"command" must be a non-empty string'
          : json.args !== undefined && !strings(json.args)
            ? '"args" must be an array of strings'
            : json.env !== undefined && (typeof json.env !== "object" || json.env === null || !Object.values(json.env).every((v) => typeof v === "string"))
              ? '"env" must map names to strings'
              : json.entry !== undefined && json.command !== undefined
                ? 'use either "entry" (in-process) or "command" (separate process), not both'
                : undefined;
  if (problem) throw new Error(`plugin.json: ${problem}`);
  return json;
}

async function firstFile(dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) if ((await stat(path.join(dir, n)).catch(() => undefined))?.isFile()) return n;
  return undefined;
}

function isPlugin(v: unknown): v is JadePlugin {
  return typeof v === "object" && v !== null && typeof (v as Plugin).id === "string";
}

/** 斜杠命令名：字母数字开头，之后可以有 - 和 _ */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
