// jade 插件 API：插件能看到的全部类型，加上 definePlugin。设计见 docs/design/jade.md 3.5。
// 这个包没有运行时依赖，也不带任何状态：运行时用到的一切都从 ctx 拿。所以插件自己装一份、
// 和 jade 用的不是同一份模块也没有关系。错误类（PluginError 等）因此不在这里：跨模块副本 instanceof 不成立，
// 插件按 error.name 判断。

import type { LocalHookSpec, LogEvent, RemoteHookSpec, RuntimeNotice, State, Tool, ToolInfo, UserInput } from "uncarved";
export type { LocalHookSpec, LogEvent, RemoteHookSpec, RuntimeNotice, State, Tool, ToolInfo, UserInput } from "uncarved";

/** 来源层级，后面的层级更高（3.3） */
export type PluginLayer = "bundled" | "user" | "project";

/** plugin.json：不执行插件代码就能读到的一切（原则 4） */
export interface Manifest {
  id: string;
  version: string;
  /** 兼容的插件 API 版本，只接受 ^ 范围，如 "^1" */
  api: string;
  /** 进程内插件的入口模块，相对插件目录 */
  entry?: string;
  /** 进程外插件的启动方式（第 6 节），和 entry 二选一 */
  runtime?: { command: string; args?: string[] };
  /** 提供的服务，形如 "commands@1" */
  provides?: string[];
  /** 必需的服务：缺任何一项就不激活 */
  requires?: string[];
  /** 可选的服务：缺了照样激活，ctx.service 返回 undefined */
  optional?: string[];
  /** 代替的插件 id（3.3） */
  replaces?: string[];
  /** 这是一个前端（3.4）：default 为默认前端，flag 为选中它的命令行开关 */
  frontend?: { name: string; default?: boolean; flag?: string };
  /** 配置项（第 8 节）：键 → 默认值、说明；project 为 true 的键项目层的 .jade/config.json 也能设 */
  config?: Record<string, ConfigKey>;
}

export interface ConfigKey {
  default?: unknown;
  description?: string;
  /** 项目层可以设置这个键。项目层插件自己的键不用标 */
  project?: boolean;
}

/** 发现的一个插件 */
export interface PluginSource {
  manifest: Manifest;
  /** 插件目录的绝对路径 */
  dir: string;
  layer: PluginLayer;
}

/** 清理函数，作用域关闭时逆序执行 */
export type Disposer = () => void | Promise<void>;

/** 一个插件的密钥（第 8 节）：按插件 id 隔离，插件只能读写自己的那一份 */
export interface Secrets {
  /** 读一个密钥；没有时 undefined */
  get(key: string): Promise<string | undefined>;
  /** 写一个密钥；value 为 undefined 时删除它 */
  set(key: string, value: string | undefined): Promise<void>;
}

/**
 * 工具的附加说明，注册工具时随工具给出（ctx.kernel.tool）。别的插件按它判断一个工具做什么，不认工具名：
 * 换掉提供文件工具的插件（比如换成 apply_patch），/undo、检查、压缩照样认得出哪些调用改了文件。
 * 值是输入里的字段名
 */
export interface ToolMeta {
  /** 写一个文件，路径在输入的这个字段里（例如 "path"）：/undo 写之前记下文件，检查、压缩据此知道改了哪些文件 */
  writes?: string;
  /** 执行一条 shell 命令，命令在输入的这个字段里（例如 "command"）：审批按命令判断，/undo 在第一条命令之前给工作区拍快照 */
  shell?: string;
}

/**
 * 给用户看的文字：普通字符串，或者带语义样式的片段，可以嵌套成数组（[dim("·"), " ", name]）。
 * 插件只说"这段是次要的、这段是错误"，怎么画由前端决定：终端界面画成颜色，-p 和别的前端可以只取文字。
 * 字符串里仍可以带 ANSI 颜色（旧的写法），终端界面照常显示，其他前端会去掉
 */
export type Text = string | Span | readonly Text[];

/** 一段带样式的文字 */
export interface Span {
  text: string;
  style: TextStyle | readonly TextStyle[];
}

/**
 * dim 次要的；bold 强调；ok 成功；warn 警告；error 错误；accent 醒目的另一种（例如标题、名字）；
 * code 命令、路径一类的字面内容；added、removed 差异里加的、删的行
 */
export type TextStyle = "dim" | "bold" | "ok" | "warn" | "error" | "accent" | "code" | "added" | "removed";

/**
 * 状态栏上插件的一段。只给文字时是普通的一段：灰色，窄的时候比较早去掉。
 * tone：语义上的颜色，前端自己决定怎么画（ok 绿、warn 黄、error 红、accent 醒目的另一种颜色）；
 * keep：窄的时候也不去掉（例如当前模式），这时放不下就换成 short
 */
export interface StatusSegment {
  text: string;
  short?: string;
  tone?: "ok" | "warn" | "error" | "accent";
  keep?: boolean;
}

/** 会话里的一个工具：内核看到的信息，加上注册时给的 meta */
export type SessionTool = ToolInfo & { meta?: ToolMeta };

/** 进程级和会话级 ctx 共有的部分 */
export interface ScopeContext {
  /** 本插件的 id */
  readonly plugin: string;
  /** 作用域关闭时中止 */
  readonly signal: AbortSignal;
  /** 工作目录 */
  readonly cwd: string;
  /** $JADE_HOME */
  readonly home: string;
  /** 本插件的配置：清单里的默认值 < 用户 config.json < 项目 .jade/config.json，按键合并（第 8 节） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 本插件的密钥：按插件 id 分隔存储，和作用域同生共死（第 8 节） */
  readonly secrets: Secrets;
  /** 取一个声明在 requires 里的服务，没有声明或没有提供者时抛错 */
  require<T extends object>(service: string): T;
  /** 取一个声明在 requires 或 optional 里的服务，没有提供者时返回 undefined */
  service<T extends object>(service: string): T | undefined;
  /** 启动一项后台资源，返回的清理函数在作用域关闭时执行 */
  effect(start: () => Disposer | void | Promise<Disposer | void>): Promise<void>;
  /**
   * 告诉用户一个问题（警告，不是错误）：前端起来之后显示成通知，之前打到 stderr；消息前面加上本插件的 id。
   * 例如注册表遇到重名时跳过后来的那一项并报告，而不是抛错让调用方整个激活失败
   */
  report(message: string): void;
}

/** 服务的调用方，交给按调用方创建的服务实例（ProcessContext.provide） */
export interface Caller {
  /** 调用方插件的 id；核心自己调用时为 "jade" */
  readonly plugin: string;
  /** 调用方插件的层级；核心自己调用时为 "core"。项目层插件给的东西（例如提示词）应当当作不可信 */
  readonly layer: PluginLayer | "core";
  /** 调用方的作用域关闭时中止 */
  readonly signal: AbortSignal;
  /** 调用方的作用域关闭时执行，以提供者的身份执行。注册表用它撤销调用方注册的东西 */
  onDispose(d: Disposer): void;
}

export interface ProcessContext extends ScopeContext {
  /**
   * 提供一个声明在 provides 里的服务。
   * 传对象：所有调用方共用；传函数：每个调用方作用域调用一次，得到这个调用方专用的实例。
   * 注册表应当用函数形式，在 caller.onDispose 里撤销调用方注册的东西，这样调用方关闭、
   * 激活失败或被隔离时，它的注册自动撤销（4.1）
   */
  provide(service: string, impl: object | ((caller: Caller) => object)): void;
}

/** 插件在会话里能做的事（4.3） */
export interface SessionControl {
  readonly id: string;
  /** 本轮完全结束（turn.ended 已落盘、没有在途工具）后执行一次；会话空闲时尽快执行 */
  afterTurn(fn: () => void | Promise<void>): void;
  /**
   * 发起一轮。正在跑时排到当前这一轮之后，这一轮跑完时 resolve。
   * 不要在 hook 或工具里 await 它：它要等当前这一轮结束，而当前这一轮在等你。项目层插件不能用（第 7 节）。
   *
   * `kind: "approval"` 是对等待人工审批的调用的回答，属于正在跑的这一轮，不排队：内核停下来等审批时交给它，
   * 内核接着跑到再次停下（下一个审批，或这一轮结束）时 resolve。没有在跑的一轮、或没有这个待批的调用时 reject
   */
  send(input: UserInput): Promise<void>;
  /** 中止正在跑的这一轮（例如用户在别处喊停）；空闲时什么都不做。项目层插件不能用 */
  abort(reason?: string): void;
  /**
   * 会话现在的状态（阶段、消息、还没做完的工具调用、derived）的一份拷贝，和前端的 Session.state 相同。
   * session() 执行期间还没有（会话在全部插件加入之后才建），那时调用会抛错：在 hook、工具、afterTurn、subscribe 的回调里用
   */
  state(): State;
  /**
   * 订阅运行时的通知（写进日志的事件、流式增量、工具进度、停下来等人工审批的 awaiting），和前端的 Session.subscribe 相同；
   * 返回取消订阅，作用域关闭时自动取消。可以在 session() 里订阅。回调要马上返回：它在内核运行的中途被调用。
   * 例如审批插件用 awaiting 知道有调用在等回答，包括恢复一个上次停在等审批的会话时
   */
  subscribe(fn: (n: RuntimeNotice) => void): () => void;
  /** 这个会话里叫这个名字的工具；没有时 undefined（例如历史里的调用来自一个现在没加载的插件） */
  tool(name: string): SessionTool | undefined;
}

export interface SessionContext extends ScopeContext {
  readonly session: SessionControl;
  /**
   * 状态栏上这个插件的一段（一行）；undefined 去掉。前端没有状态栏时是 undefined。
   * 状态栏同时显示几个插件的段落时按调用先后排列（4.3）
   */
  readonly status?: (text: string | StatusSegment | undefined) => void;
  /**
   * 输入框上方这个插件的一块，可以多行（例如任务清单），一直显示到换掉或去掉；undefined 去掉。
   * 前端没有这个位置时是 undefined。几个插件都有时按调用先后排列
   */
  readonly panel?: (text: Text | undefined) => void;
  /** 输入框里的草稿：读、追加、整段替换、灰色提示；只有终端界面有 */
  readonly input?: Draft;
  /** 交给内核的部分，只能在 session() 执行期间注册：会话的内核插件清单在创建时确定 */
  readonly kernel: {
    tool(tool: Tool & { meta?: ToolMeta }): void;
    /** 进程内的 hook，或进程外插件的 RemoteHookSpec（字段裁剪、超时由内核保证） */
    hook(hook: LocalHookSpec | RemoteHookSpec): void;
  };
}

/** 输入框（4.3）：只在前端有输入框时给插件 */
export interface Draft {
  /** 现在输入框里的文字 */
  text(): string;
  /** 在光标处插入一段文字 */
  insert(text: string): void;
  /** 换掉整段文字，光标移到末尾 */
  set(text: string): void;
  /** 输入框空着时显示的灰色提示，Tab 或 → 接受；undefined 去掉 */
  hint(text: string | undefined): void;
}

// ---------- 核心消费的服务契约（3.4） ----------

/** 前端拿到的会话 */
export interface Session {
  readonly id: string;
  readonly state: State;
  /**
   * 发一条输入；正在跑时排队。这一轮跑完时 resolve（之后的 afterTurn 不等）。内核停下来等人工审批时这一轮还没完。
   * `kind: "approval"`（审批的回答）不排队，交给正在等的这一轮
   */
  send(input: UserInput): Promise<void>;
  /** 排队的输入和 afterTurn 全部处理完时 resolve */
  idle(): Promise<void>;
  /** 继续日志里没做完的工作（崩溃、重启后） */
  recover(): Promise<void>;
  /** 中止正在跑的这一轮，包括停下来等人工审批的时候 */
  abort(reason?: unknown): void;
  subscribe(fn: (n: RuntimeNotice) => void): () => void;
  /** 日志里的全部事件（恢复会话时前端用它重新显示对话） */
  history(): Promise<LogEvent[]>;
  /** 这个会话里叫这个名字的工具，同 SessionControl.tool */
  tool(name: string): SessionTool | undefined;
}

export interface OpenOptions {
  /** 恢复这个会话；不写就新建 */
  resume?: string;
  /**
   * 从一个会话复制出一个新会话：新会话的日志是原会话 seq 小于 before 的那些事件，原会话不动（例如回退到某条消息之前）。
   * before 要是一条消息输入（input.received）的 seq，复制出的会话才停在两轮之间。和 resume 不能同时用
   */
  fork?: { session: string; before: number };
}

/** 会话管理器：新建、恢复、切换（4.2） */
export interface SessionManager {
  readonly current: Session | undefined;
  /** 新建或恢复一个会话，成功后它成为当前会话，旧会话离开（仍可恢复）。失败时旧会话不受影响 */
  open(opts?: OpenOptions): Promise<Session>;
  /** 当前会话离开（仍可恢复） */
  close(): Promise<void>;
}

/** frontend@1：核心启动后把控制权交给它，返回进程的退出码 */
export interface Frontend {
  run(opts: { argv: readonly string[]; sessions: SessionManager; signal: AbortSignal }): Promise<number | void>;
}

/**
 * cli@1：插件注册的 `jade <子命令>`，由核心提供（不是插件，见 3.4）。
 * 命令行的第一个参数是注册过的名字时，核心启动宿主后把剩下的参数交给它，不进前端。
 * 核心自己的子命令（plugins、update、help……）不能注册
 */
export interface Cli {
  /** 注册一条子命令，返回撤销函数。名字不合法或保留时抛错；已被占用时跳过并报告（同 commands@1） */
  register(command: CliCommand): () => void;
}

export interface CliCommand {
  /** jade <name> …：小写字母、数字和 - */
  name: string;
  /**
   * argv 是 name 之后的参数。返回的文字打印到 stdout，退出码 0；
   * 用法错误或失败时抛错，核心把消息打印到 stderr，退出码 2。log 写到 stderr（进度之类）
   */
  run(argv: readonly string[], ctx: { log(text: string): void; signal: AbortSignal }): string | void | Promise<string | void>;
}

/**
 * jade@1：核心自己的诊断信息，由核心提供（不是插件，见 3.4）。只读；`/plugins` 用它，
 * 和救援 CLI `jade plugins list` 看的是同一份状态
 */
export interface Jade {
  /** 这次启动里每个插件的状态和原因，包括读不出清单的目录 */
  plugins(): PluginStatus[];
  /** 服务名 → 提供者 id（含核心自己的 jade@1） */
  services(): { service: string; provider: string }[];
}

/** 一个插件在这次启动里的状态（和 PluginState 一致，这里不 import 宿主） */
export interface PluginStatus {
  id?: string;
  version?: string;
  layer: PluginLayer;
  dir: string;
  state: "active" | "disabled" | "duplicate" | "incompatible" | "replaced" | "conflict" | "skipped" | "broken" | "failed" | "untrusted" | "quarantined";
  reason?: string;
}

/**
 * trust@1：用户确认过的东西（项目里的检查命令、MCP 服务……），由核心提供（不是插件，见 3.4）。
 * hash 由调用方算（把要确认的内容都算进去，内容一变就要重新确认）；按插件分开存，别的插件的确认查不到。
 * 存在 $JADE_HOME/state/confirmed.json
 */
export interface Trust {
  /** 用户确认过这一项 */
  has(hash: string): Promise<boolean>;
  /** 记下用户确认了这一项；where 是给人看的位置（目录、文件） */
  add(hash: string, where: string): Promise<void>;
}

/**
 * sources@1：核心自己的下载器，由核心提供（不是插件，见 3.4）。`jade plugins add` 用的就是它；
 * 插件要从 git、npm 或本地目录装东西（例如 jade/skills 装 skill）时用同一份，不用自己再写一遍。
 * 只下载，不执行下载下来的任何代码，也不装依赖
 */
export interface Sources {
  /** 识别一个来源的写法（本地目录、npm 包、git 仓库，见 5.4）；相对路径按 cwd 解析。不下载 */
  parse(text: string, cwd: string): Promise<PluginSourceSpec>;
  /** 把来源下载到 staging 目录，返回 staging 里来源的根目录；git 来源同时返回提交。清理 staging 是调用方的事 */
  fetch(source: PluginSourceSpec, staging: string, log?: (text: string) => void): Promise<{ root: string; commit?: string }>;
  /** 目录内容的哈希（不算 node_modules、.git 和 lock 文件）：记下来，以后判断装好的东西有没有被手动改过 */
  hash(dir: string): Promise<string>;
}

export type SourceKind = "git" | "npm" | "local";

/** 识别出来的一个来源（Sources.parse） */
export interface PluginSourceSpec {
  kind: SourceKind;
  /** git：仓库地址；npm：交给包管理器的写法；local：绝对路径 */
  location: string;
  /** git 的分支、tag 或提交 */
  ref?: string;
  /** 用户写的原文，记进安装记录 */
  spec: string;
}

/**
 * update@1：jade 本身的版本和升级，由核心提供（不是插件，见 3.4）。和 `jade update` 是同一套代码；
 * 启动时要不要查、查到了怎么告诉用户是插件的事（jade/update）
 */
export interface Updater {
  /** 正在运行的 jade 的版本 */
  readonly version: string;
  /** jade 是怎么装的；dev 是仓库里的开发版或 npm link，不能自动升级 */
  readonly install: Install["kind"];
  /** 有比当前更新的版本时返回它的版本号。每天最多查一次 npm，其余时候用缓存；查不到时 undefined */
  newer(): Promise<string | undefined>;
  /** 用户有没有用环境变量关掉自动升级（JADE_AUTO_UPDATE、JADE_UPDATE_CHECK） */
  autoEnabled(): boolean;
  /** 在后台把 jade 升级到 latest，下次启动生效 */
  upgrade(latest: string): Promise<AutoUpdateResult>;
}

export type Install = { kind: "npm" | "bun" | "pnpm" | "yarn"; dir: string } | { kind: "dev"; dir: string };

export type AutoUpdateResult =
  /** 装好了，下次启动生效 */
  | { status: "installed" }
  /** 别的 jade 正在升级，或者这个版本不久前刚失败过：这次不试 */
  | { status: "skipped"; why: "busy" | "failed-recently" | "unsupported" }
  | { status: "failed"; log: string };

/** ui@1：前端提供的和用户打交道的方式。每个前端都提供它，形状由 jade 定义 */
export interface UI {
  /** 能不能向用户提问。不能时 select 总是返回 undefined */
  readonly interactive: boolean;
  /** 告诉用户一件事 */
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** 请用户从选项里选一个，返回选中项的 value；不能提问、用户取消或 signal 中止时返回 undefined */
  select<T extends string>(request: SelectRequest<T>, signal?: AbortSignal): Promise<T | undefined>;
  /** 请用户输入一行；不能提问、用户取消或 signal 中止时返回 undefined */
  input(request: InputRequest, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * 把文字放进用户的系统剪贴板；交给终端了返回 true，这个前端现在做不到返回 false。
   * 没有剪贴板的前端（例如 -p）没有这个方法
   */
  copy?(text: string): boolean;
  /**
   * 把终端让出来给另一个程序用（例如 $EDITOR）：前端停止画界面、不再读键盘，把终端恢复成普通状态，然后执行 fn；
   * fn 结束（或抛错）后前端重新接管、重画界面，返回 fn 的结果。期间会话照常运行，输出在重新接管后显示。
   * 在 fn 里启动的程序用 stdio: "inherit"。不占着终端的前端没有这个方法
   */
  suspend?<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * 某个插件在一个会话里的界面（4.3）：状态栏上它的一段、输入框。
   * 核心为每个加入会话的插件调用一次；不能显示时返回 undefined。插件的作用域关闭时核心调用 dispose
   */
  session?(request: SessionRequest): SessionUI | undefined;
}

/** UI.session 的参数：会话 id 和调用它的插件 */
export interface SessionRequest {
  session: string;
  plugin: string;
}

/** 一个插件在一个会话里的界面；每个插件一份，所以状态栏的段落不用 key */
export interface SessionUI {
  /** 状态栏上这个插件的一段（一行）；undefined 去掉 */
  status(text: string | StatusSegment | undefined): void;
  /** 输入框上方这个插件的一块（可以多行）；undefined 去掉。没有这个位置的前端没有 */
  panel?(text: Text | undefined): void;
  /** 输入框；没有输入框的前端（例如 -p）没有 */
  readonly draft?: Draft;
  /** 去掉这个插件在这个会话里留下的一切（状态栏的段落、输入框上方的一块、输入框的提示） */
  dispose(): void;
}

export interface InputRequest {
  title: string;
  initial?: string;
  placeholder?: string;
  /** 输入的内容不显示（密钥） */
  mask?: boolean;
}

export interface SelectRequest<T extends string> {
  title: string;
  /** 选项上方的详细内容，例如要执行的命令、要改的文件 */
  detail?: Text;
  options: { label: string; value: T; /** 选项后面的灰色说明 */ hint?: string }[];
}

export interface PluginModule {
  /** 进程级：提供服务、向其他插件的注册服务注册东西。只做注册，不在这里直接启动后台资源 */
  process?(ctx: ProcessContext): void | Promise<void>;
  /** 会话级：每个会话调用一次，注册工具和内核 hook。会话关闭（换会话、退出）时作用域关闭 */
  session?(ctx: SessionContext): void | Promise<void>;
}

export function definePlugin<T extends PluginModule>(module: T): T {
  return module;
}
