// jade 插件 API：插件能看到的全部类型。设计见 docs/design/jade.md。
// 插件只从这里 import 类型和 definePlugin，运行时用到的一切都从 ctx 拿（3.5）。

import type { LocalHookSpec, LogEvent, RemoteHookSpec, RuntimeNotice, State, Tool, UserInput } from "uncarved";
export type { LocalHookSpec, LogEvent, RemoteHookSpec, RuntimeNotice, State, Tool, UserInput } from "uncarved";

/** 插件 API 的版本，插件在 plugin.json 的 api 字段里用 ^ 范围声明 */
export const API_VERSION = "1.0.0";

/** 来源层级，后面的层级更高（3.3） */
export const LAYERS = ["bundled", "user", "project"] as const;
export type PluginLayer = (typeof LAYERS)[number];

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
   * 不要在 hook 或工具里 await 它：它要等当前这一轮结束，而当前这一轮在等你。项目层插件不能用（第 7 节）
   */
  send(input: UserInput): Promise<void>;
}

export interface SessionContext extends ScopeContext {
  readonly session: SessionControl;
  /**
   * 状态栏上这个插件的一段（一行）；undefined 去掉。前端没有状态栏时是 undefined。
   * 状态栏同时显示几个插件的段落时按调用先后排列（4.3）
   */
  readonly status?: (text: string | undefined) => void;
  /** 输入框里的草稿：读、追加、整段替换、灰色提示；只有终端界面有 */
  readonly input?: Draft;
  /** 交给内核的部分，只能在 session() 执行期间注册：会话的内核插件清单在创建时确定 */
  readonly kernel: {
    tool(tool: Tool): void;
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
  /** 发一条输入；正在跑时排队。这一轮跑完时 resolve（之后的 afterTurn 不等） */
  send(input: UserInput): Promise<void>;
  /** 排队的输入和 afterTurn 全部处理完时 resolve */
  idle(): Promise<void>;
  /** 继续日志里没做完的工作（崩溃、重启后） */
  recover(): Promise<void>;
  abort(reason?: unknown): void;
  subscribe(fn: (n: RuntimeNotice) => void): () => void;
  /** 日志里的全部事件（恢复会话时前端用它重新显示对话） */
  history(): Promise<LogEvent[]>;
}

export interface OpenOptions {
  /** 恢复这个会话；不写就新建 */
  resume?: string;
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
  status(text: string | undefined): void;
  /** 输入框；没有输入框的前端（例如 -p）没有 */
  readonly draft?: Draft;
  /** 去掉这个插件在这个会话里留下的一切（状态栏的段落、输入框的提示） */
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
  detail?: string;
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

// ---------- 错误 ----------

/** 插件代码抛出的错误，标明归属 */
export class PluginError extends Error {
  readonly plugin: string;
  constructor(plugin: string, where: string, cause: unknown) {
    super(`plugin ${plugin} (${where}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PluginError";
    this.plugin = plugin;
  }
}

/** 作用域已关闭之后还在用它的 ctx 或从它拿到的东西（4.1） */
export class StaleContext extends Error {
  readonly plugin: string;
  constructor(plugin: string) {
    super(`plugin ${plugin}: this context belongs to a closed scope; do not keep ctx or services across a session switch`);
    this.name = "StaleContext";
    this.plugin = plugin;
  }
}

/** 服务的提供者已被隔离或已关闭（3.3） */
export class ServiceUnavailable extends Error {
  readonly service: string;
  constructor(service: string, provider: string) {
    super(`service ${service}: provider ${provider} is no longer active`);
    this.name = "ServiceUnavailable";
    this.service = service;
  }
}
