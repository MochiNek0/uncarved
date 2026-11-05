// 进程级的插件宿主：发现、解析、激活、服务注册、故障隔离、关闭（3.1、4.1、5.3、5.4）。

import path from "node:path";
import { pathToFileURL } from "node:url";
import { importProjectModule, UntrustedPlugin, type Plugin, type TrustOptions } from "uncarved";
import {
  API_VERSION,
  PluginError,
  ServiceUnavailable,
  StaleContext,
  type Caller,
  type Disposer,
  type PluginLayer,
  type PluginModule,
  type PluginSource,
  type ProcessContext,
} from "./api.ts";
import { pluginConfig, readConfigFile, type ConfigFile } from "./config.ts";
import { discover, type BrokenSource, type LayerRoot } from "./manifest.ts";
import { ambient, invoke, Scope, serviceHandle, type Owner } from "./membrane.ts";
import { resolve, type Plan, type PlanState } from "./resolve.ts";
import { Sessions } from "./session.ts";
import { countFault, readFaults, readPluginsConfig, writeFaults, type Faults } from "./state.ts";

/** untrusted：项目层插件没有得到用户确认，没有执行它的任何代码 */
export type PluginState = PlanState | "broken" | "failed" | "untrusted" | "quarantined";

export interface PluginInfo {
  id?: string;
  version?: string;
  layer: PluginLayer;
  dir: string;
  state: PluginState;
  reason?: string;
}

export interface HostOptions {
  roots: LayerRoot[];
  /** $JADE_HOME：plugins.json、state/faults.json 所在目录 */
  home: string;
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 配置文件（第 8 节）：用户层默认 $JADE_HOME/config.json；项目层不写就没有 */
  config?: { user?: string; project?: string };
  flags?: readonly string[];
  safe?: boolean;
  /** 项目层插件的确认（第 7 节）：确认记录和向用户提问的方式。不提供时不加载带代码的项目层插件 */
  trust?: TrustOptions;
  /** 要告诉用户的事（插件失败、被隔离、自动停用……），由前端或 CLI 显示 */
  report?: (message: string) => void;
}

/** 核心自己的身份：核心通过服务句柄调用插件（例如 frontend@1）时的调用方 */
const CORE_ID = "jade";

interface Active {
  source: PluginSource;
  module: PluginModule;
  /** 进程级作用域 */
  owner: Owner;
  /** 会话级作用域：隔离插件时一并关闭 */
  sessions: Set<Scope>;
  /** 项目层插件：把它交给内核的插件标记为已确认（内核拒绝未经确认的项目层插件） */
  mark?: (p: Plugin) => Plugin;
}

/** 状态在启动时由 plugins.json、faults.json 和清单算出（不执行插件代码），之后只由宿主改动 */
export async function planPlugins(opts: Pick<HostOptions, "roots" | "home" | "flags" | "safe">): Promise<{ plan: Plan; broken: BrokenSource[]; faults: Faults }> {
  const [{ sources, broken }, config, faults] = await Promise.all([discover(opts.roots), readPluginsConfig(opts.home), readFaults(opts.home)]);
  const disabled = new Set([...config.disabled, ...faults.autoDisabled]);
  const plan = resolve(sources, { apiVersion: API_VERSION, disabled, safe: opts.safe, flags: opts.flags });
  // 区分"用户停用"和"连续崩溃后自动停用"
  for (const e of plan.entries) {
    if (e.state === "disabled" && e.reason !== "safe mode" && !config.disabled.includes(e.source.manifest.id)) {
      e.reason = `disabled after ${faults.streaks[e.source.manifest.id]?.count ?? "repeated"} faulty launches (last: ${faults.streaks[e.source.manifest.id]?.last ?? "unknown"}); run "jade plugins enable ${e.source.manifest.id}" to retry`;
    }
  }
  return { plan, broken, faults };
}

export class PluginHost {
  readonly plan: Plan;
  readonly #opts: HostOptions;
  readonly #broken: BrokenSource[];
  readonly #faults: Faults;
  /** 本次启动里已经记过故障的插件 */
  readonly #faulted = new Set<string>();
  readonly #status = new Map<string, { state: PluginState; reason?: string }>();
  readonly #active: Active[] = [];
  readonly #services = new Map<string, { impl: object | ((caller: Caller) => object); provider: Owner }>();
  /** 按调用方创建的服务实例：调用方作用域 → 服务名 → 实例 */
  readonly #perCaller = new WeakMap<Scope, Map<string, object>>();
  readonly #core: Owner = { plugin: CORE_ID, scope: new Scope(CORE_ID) };
  #config: { user: ConfigFile; project: ConfigFile } = { user: {}, project: {} };
  readonly #pluginConfigs = new Map<string, Readonly<Record<string, unknown>>>();
  #sessions: Sessions | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(opts: HostOptions, plan: Plan, broken: BrokenSource[], faults: Faults) {
    this.#opts = opts;
    this.plan = plan;
    this.#broken = broken;
    this.#faults = faults;
    for (const e of plan.entries) this.#status.set(e.source.dir, { state: e.state, ...(e.reason ? { reason: e.reason } : {}) });
  }

  /** 解析并按顺序激活全部插件。单个插件失败不影响其他插件，不抛出 */
  static async start(opts: HostOptions): Promise<PluginHost> {
    const { plan, broken, faults } = await planPlugins(opts);
    const host = new PluginHost(opts, plan, broken, faults);
    const [user, project] = await Promise.all([
      readConfigFile(opts.config?.user ?? path.join(opts.home, "config.json")),
      opts.config?.project ? readConfigFile(opts.config.project) : { config: {}, error: undefined },
    ]);
    host.#config = { user: user.config, project: project.config };
    for (const e of [user.error, project.error]) if (e) host.#report(e);
    for (const w of plan.warnings) host.#report(w);
    for (const b of broken) host.#report(`plugin at ${b.dir}: ${b.error}`);
    for (const source of plan.order) await host.#activate(source);
    await host.#saveFaults();
    return host;
  }

  /** 每个插件的状态和原因，包括读不出清单的目录 */
  status(): PluginInfo[] {
    const infos: PluginInfo[] = this.plan.entries.map((e) => {
      const s = this.#status.get(e.source.dir)!;
      return { id: e.source.manifest.id, version: e.source.manifest.version, layer: e.source.layer, dir: e.source.dir, state: s.state, ...(s.reason ? { reason: s.reason } : {}) };
    });
    for (const b of this.#broken) infos.push({ layer: b.layer, dir: b.dir, state: "broken", reason: b.error });
    return infos;
  }

  /** 核心取服务（例如 frontend@1、provider@1）。没有提供者时返回 undefined */
  service<T extends object>(name: string): T | undefined {
    return this.#handle<T>(name, this.#core);
  }

  /**
   * 处理没人接住的异常（5.3）。归属顺序：AsyncLocalStorage → 错误栈里的插件目录 → 未归属。
   * 能归到插件的隔离它；未归属的记下来，进程不退出
   */
  handleUncaught(error: unknown): void {
    const plugin = ambient.getStore()?.plugin ?? (error instanceof PluginError ? error.plugin : undefined) ?? this.#blame(error);
    const message = error instanceof Error ? error.message : String(error);
    if (plugin && plugin !== CORE_ID) {
      void this.quarantine(plugin, message);
      return;
    }
    this.#faults.unattributed.push({ at: new Date().toISOString(), error: error instanceof Error ? (error.stack ?? message) : message });
    this.#report(`unhandled error not attributable to any plugin: ${message}`);
    void this.#saveFaults();
  }

  /** 安装进程级的异常处理器，返回卸载函数 */
  installProcessHandlers(): () => void {
    const handler = (e: unknown) => this.handleUncaught(e);
    process.on("uncaughtException", handler);
    process.on("unhandledRejection", handler);
    return () => {
      process.off("uncaughtException", handler);
      process.off("unhandledRejection", handler);
    };
  }

  /** 隔离一个插件：关闭它的作用域、撤销它的注册，它提供的服务随之失效（5.3） */
  async quarantine(id: string, reason: string): Promise<void> {
    const i = this.#active.findIndex((a) => a.source.manifest.id === id);
    if (i === -1) return;
    const [a] = this.#active.splice(i, 1);
    this.#status.set(a!.source.dir, { state: "quarantined", reason });
    this.#report(`plugin ${id} was stopped after an error: ${reason}`);
    this.#fault(id, reason);
    // 先会话级、再进程级：会话里的东西可能用着进程级的服务
    for (const s of [...a!.sessions, a!.owner.scope]) {
      for (const e of await s.close()) this.#report(String(e instanceof Error ? e.message : e));
    }
    await this.#saveFaults();
  }

  /** 会话：新建、恢复、切换（4.2） */
  get sessions(): Sessions {
    return (this.#sessions ??= new Sessions({
      home: this.#opts.home,
      cwd: this.#cwd,
      config: (source) => this.#configOf(source),
      core: this.#core,
      active: () => this.#active,
      service: (name, caller) => this.#handle(name, caller),
      track: (plugin, scope) => this.#active.find((a) => a.source.manifest.id === plugin)?.sessions.add(scope),
      untrack: (plugin, scope) => this.#active.find((a) => a.source.manifest.id === plugin)?.sessions.delete(scope),
      fault: (plugin, reason) => {
        this.#fault(plugin, reason);
        void this.#saveFaults();
      },
      report: (m) => this.#report(m),
    }));
  }

  /** 逆序关闭全部插件。这次启动里没出故障的插件，连续故障计数清零 */
  async close(): Promise<void> {
    if (this.#sessions) await this.#sessions.close();
    await this.#core.scope.close();
    while (this.#active.length > 0) {
      const a = this.#active.pop()!;
      for (const e of await a.owner.scope.close()) this.#report(String(e instanceof Error ? e.message : e));
    }
    for (const id of Object.keys(this.#faults.streaks)) if (!this.#faulted.has(id)) delete this.#faults.streaks[id];
    await this.#saveFaults();
  }

  // ---------- 激活 ----------

  async #activate(source: PluginSource): Promise<void> {
    const { manifest, dir } = source;
    const id = manifest.id;
    // 必需服务的提供者激活失败：不激活，原因精确到服务
    for (const need of manifest.requires ?? []) {
      const provider = this.plan.providers.get(need);
      if (provider && !this.#services.has(need)) {
        this.#status.set(dir, { state: "skipped", reason: `requires ${need}: its provider ${provider} failed to activate` });
        return;
      }
    }
    const scope = new Scope(id);
    const owner: Owner = { plugin: id, scope };
    try {
      const { module, mark } = await this.#load(source, owner);
      if (module.process) await invoke(owner, "process", () => module.process!(this.#processContext(source, owner)));
      const missing = (manifest.provides ?? []).filter((s) => this.#services.get(s)?.provider !== owner);
      if (missing.length > 0) throw new Error(`declares ${missing.join(", ")} in provides but did not provide it`);
      this.#active.push({ source, module, owner, sessions: new Set(), ...(mark ? { mark } : {}) });
    } catch (e) {
      // 事务性：已经做的注册全部撤销（4.1）
      await scope.close();
      const reason = e instanceof PluginError && e.plugin === id ? String((e.cause as Error)?.message ?? e.message) : e instanceof Error ? e.message : String(e);
      // 用户没有确认不是插件的故障，不计入连续崩溃
      const untrusted = e instanceof UntrustedPlugin;
      this.#status.set(dir, { state: untrusted ? "untrusted" : "failed", reason });
      this.#report(`plugin ${id} ${untrusted ? "was not loaded" : "failed to activate"}: ${reason}`);
      if (!untrusted) this.#fault(id, reason);
    }
  }

  async #load(source: PluginSource, owner: Owner): Promise<{ module: PluginModule; mark?: (p: Plugin) => Plugin }> {
    const { manifest, dir } = source;
    if (manifest.runtime) throw new Error("out-of-process plugins are not supported yet");
    let mod: { default?: unknown };
    let mark: ((p: Plugin) => Plugin) | undefined;
    if (source.layer === "project") {
      // 项目层：内核负责确认（哈希、import 不出目录、请求确认、导入），之前不执行任何代码（第 7 节）
      const trust = this.#opts.trust;
      if (!trust) throw new UntrustedPlugin(dir, "project plugins need confirmation, which this jade cannot ask for");
      // 模块顶层代码也归这个插件（顶层启动的定时器出错时能找到它）
      const loaded = await ambient.run(owner, () => importProjectModule(dir, { ...trust, entry: manifest.entry! }));
      mod = loaded.module as { default?: unknown };
      mark = loaded.mark;
    } else {
      const file = path.resolve(dir, manifest.entry!);
      const rel = path.relative(dir, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`entry ${manifest.entry} is outside the plugin directory`);
      mod = (await ambient.run(owner, () => import(pathToFileURL(file).href))) as { default?: unknown };
    }
    const m = mod.default;
    if (typeof m !== "object" || m === null) throw new Error(`entry ${manifest.entry} must default-export definePlugin({ ... })`);
    return { module: m as PluginModule, ...(mark ? { mark } : {}) };
  }

  #processContext(source: PluginSource, owner: Owner): ProcessContext {
    const { manifest } = source;
    const id = manifest.id;
    // 每个方法都先检查：作用域关闭后旧 ctx 一律抛 StaleContext（4.1）
    const declared = (name: string, lists: (readonly string[] | undefined)[]) => {
      if (owner.scope.closed) throw new StaleContext(id);
      if (!lists.some((l) => l?.includes(name))) throw new Error(`plugin ${id}: ${name} is not declared in plugin.json`);
    };
    return {
      plugin: id,
      signal: owner.scope.signal,
      cwd: this.#cwd,
      home: this.#opts.home,
      config: this.#configOf(source),
      require: <T extends object>(name: string): T => {
        declared(name, [manifest.requires]);
        const h = this.#handle<T>(name, owner);
        if (!h) throw new ServiceUnavailable(name, this.plan.providers.get(name) ?? "(none)");
        return h;
      },
      service: <T extends object>(name: string): T | undefined => {
        declared(name, [manifest.requires, manifest.optional]);
        return this.#handle<T>(name, owner);
      },
      provide: (name: string, impl: object | ((caller: Caller) => object)): void => {
        declared(name, [manifest.provides]);
        if (this.plan.providers.get(name) !== id) throw new Error(`plugin ${id}: ${name} is provided by ${this.plan.providers.get(name)}`);
        if (this.#services.has(name)) throw new Error(`plugin ${id}: ${name} is already provided`);
        owner.scope.add(() => {
          if (this.#services.get(name)?.provider === owner) this.#services.delete(name);
        });
        this.#services.set(name, { impl, provider: owner });
      },
      effect: async (start): Promise<void> => {
        if (owner.scope.closed) throw new StaleContext(id);
        // 插件调用自己的代码，不过膜：膜会把返回的清理函数也包起来，作用域关闭时它就被当成过期调用拒绝了。
        // Scope.close 自己以插件身份执行清理函数、接住错误
        const d = (await ambient.run(owner, start)) as Disposer | void;
        if (typeof d === "function") owner.scope.add(d);
      },
    };
  }

  #handle<T extends object>(name: string, caller: Owner): T | undefined {
    const entry = this.#services.get(name);
    if (!entry) return undefined;
    const { impl, provider } = entry;
    const isLive = () => this.#services.get(name)?.provider === provider && !provider.scope.closed;
    if (typeof impl !== "function") return serviceHandle<T>(name, impl, provider, caller, isLive);

    let mine = this.#perCaller.get(caller.scope);
    if (!mine) this.#perCaller.set(caller.scope, (mine = new Map()));
    let instance = mine.get(name);
    if (!instance) {
      const info: Caller = {
        plugin: caller.plugin,
        layer: caller === this.#core ? "core" : (this.plan.entries.find((e) => e.source.manifest.id === caller.plugin)?.source.layer ?? "core"),
        signal: caller.scope.signal,
        onDispose: (d) => caller.scope.add(d, provider),
      };
      try {
        instance = ambient.run(provider, () => impl(info));
      } catch (e) {
        throw new PluginError(provider.plugin, `${name} for ${caller.plugin}`, e);
      }
      if (typeof instance !== "object" || instance === null) throw new PluginError(provider.plugin, name, new Error("the service factory must return an object"));
      mine.set(name, instance);
    }
    return serviceHandle<T>(name, instance, provider, caller, isLive);
  }

  get #cwd(): string {
    return this.#opts.cwd ?? process.cwd();
  }

  /** 插件的配置；项目层设置了不允许设置的键时告诉用户一次 */
  #configOf(source: PluginSource): Readonly<Record<string, unknown>> {
    const id = source.manifest.id;
    let c = this.#pluginConfigs.get(id);
    if (!c) {
      const { config, ignored } = pluginConfig(source, this.#config.user, this.#config.project);
      if (ignored.length > 0) this.#report(`project config for ${id}: ${ignored.join(", ")} can only be set in your own config.json; ignored`);
      this.#pluginConfigs.set(id, (c = config));
    }
    return c;
  }

  // ---------- 故障 ----------

  /** 错误栈里第一个落在某个激活插件目录下的帧（5.3 第 2 步） */
  #blame(error: unknown): string | undefined {
    const stack = error instanceof Error ? error.stack : undefined;
    if (!stack) return undefined;
    const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
    let decoded = stack;
    try {
      decoded = decodeURIComponent(stack); // file:// URL 里的空格等被编码过
    } catch {}
    const frames = norm(decoded);
    let best: { id: string; at: number } | undefined;
    for (const a of this.#active) {
      const at = frames.indexOf(norm(a.source.dir) + "/");
      if (at !== -1 && (!best || at < best.at)) best = { id: a.source.manifest.id, at };
    }
    return best?.id;
  }

  #fault(id: string, reason: string): void {
    if (this.#faulted.has(id)) return;
    this.#faulted.add(id);
    if (countFault(this.#faults, id, reason)) {
      this.#report(`plugin ${id} faulted in ${this.#faults.streaks[id]!.count} launches in a row and will be disabled from the next launch; run "jade plugins enable ${id}" to retry`);
    }
  }

  #saveFaults(): Promise<void> {
    this.#writing = this.#writing.then(() => writeFaults(this.#opts.home, this.#faults)).catch((e) => this.#report(`cannot save faults: ${e instanceof Error ? e.message : e}`));
    return this.#writing;
  }

  #report(message: string): void {
    this.#opts.report?.(message);
  }
}
