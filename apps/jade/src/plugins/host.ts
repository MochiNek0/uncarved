// 进程级的插件管理（PluginHost）：发现、读清单、加载、注册模型服务、退出时结束进程外插件。
//
// 整个 jade 进程只有一个。进程级的东西（插件模块、进程外插件的进程、模型服务）只在这里创建、只在这里销毁；
// 会话级的插件实例由 createJade 每个会话创建一套。见 docs/design/jade-plugin-lifecycle.md 第 3.1 节。

import { UntrustedPlugin, type TrustStore } from "uncarved";
import { PROVIDER_KIND, registerProviders, SETTING_ENV, type ProviderSetting } from "../provider.ts";
import { discoverPlugins, loadPlugin, resolvePlugins, type ConfirmPlugin, type LoadedPlugin, type PluginBundle, type PluginLayer, type PluginProvider, type ResolvedPlugin } from "./loader.ts";

export interface PluginHostOptions {
  /** $JADE_HOME */
  home: string;
  /** 仓库根目录和工作目录（都已解析符号链接） */
  root: string;
  cwd: string;
  /** 停用的插件 id（$JADE_HOME/plugins.json） */
  disabled: ReadonlySet<string>;
  trust: TrustStore;
  /** 项目层插件新出现或内容变化时请用户确认 */
  confirm: ConfirmPlugin;
  /** 要告诉用户的事：skipped 没加载的插件，note 提示，warning 问题 */
  report(kind: "skipped" | "note" | "warning", text: string): void;
  /** 显示插件目录，默认原样 */
  display?(dir: string): string;
  /** 项目层插件没确认而跳过时，附在原因后面的话（例如非交互运行时教用户怎么确认） */
  untrustedHint?: string;
}

export interface PluginHost {
  /** 读过清单、没停用的插件，还没执行代码。它们带的 skills、命令、MCP 配置从这里取，不用等加载 */
  readonly plugins: readonly ResolvedPlugin[];
  /** 插件带的某种内容的目录，标上是哪个插件、哪一层的 */
  bundled(pick: (b: PluginBundle) => string[]): { plugin: string; dir: string; layer: PluginLayer }[];
  /**
   * 依次加载插件（项目层的先请用户确认），然后注册它们导出的模型服务。只调用一次；
   * 加载失败的跳过并报告，返回加载成功的
   */
  load(): Promise<LoadedPlugin[]>;
  /** 加载成功的插件；load 完成之前是空的 */
  readonly loaded: readonly LoadedPlugin[];
  /** 结束进程外插件；之后它们退出不再报告。可以多次调用 */
  close(): Promise<void>;
}

/** 发现插件并读清单（不执行代码）；按 id 停用的、id 重复的在这里去掉 */
export async function openPluginHost(opts: PluginHostOptions): Promise<PluginHost> {
  const show = opts.display ?? ((dir: string) => dir);
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const resolved = await resolvePlugins(await discoverPlugins({ home: opts.home, root: opts.root, cwd: opts.cwd }), opts.disabled);
  const loaded: LoadedPlugin[] = [];
  let loading: Promise<LoadedPlugin[]> | undefined;
  let closing = false;

  async function load(): Promise<LoadedPlugin[]> {
    for (const { found, error } of resolved.broken) opts.report("skipped", `plugin ${show(found.dir)}: ${errorText(error)}`);
    for (const w of resolved.warnings) opts.report("skipped", w);
    for (const p of resolved.plugins) {
      if (p.info.bundle.unsupported.length) opts.report("note", `plugin ${p.id}: jade does not support its ${p.info.bundle.unsupported.join(" and ")} yet; they are ignored`);
      try {
        loaded.push(
          await loadPlugin(p, {
            trust: opts.trust,
            confirm: opts.confirm,
            onExit: (plugin, { code, signal }) => {
              if (!closing) opts.report("warning", `plugin ${plugin.id} exited (${signal ?? `code ${code}`}); its hooks fail until jade restarts. /plugins shows its stderr`);
            },
          }),
        );
      } catch (err) {
        const hint = p.layer === "project" && err instanceof UntrustedPlugin && opts.untrustedHint ? ` ${opts.untrustedHint}` : "";
        opts.report("skipped", `plugin ${show(p.dir)}: ${errorText(err)}${hint}`);
      }
    }
    // 模型服务是插件模块导出的，不属于哪套插件实例：加载完注册一次，所有会话共用
    const collected = collectProviders(loaded);
    for (const w of [...collected.warnings, ...registerProviders(collected.providers)]) opts.report("warning", w);
    return loaded;
  }

  return {
    plugins: resolved.plugins,
    bundled: (pick) => resolved.plugins.flatMap((p) => pick(p.info.bundle).map((dir) => ({ plugin: p.id, dir, layer: p.layer }))),
    load: () => (loading ??= load()),
    loaded,
    async close() {
      closing = true;
      await Promise.all(loaded.map((p) => p.close?.().catch(() => {})));
    },
  };
}

/**
 * 插件模块导出的模型服务（LoadedPlugin.providers）：检查后返回要注册的服务和要告诉用户的问题。
 * 只认用户层插件：服务能看到全部对话和 API key。不用创建插件实例，所以宿主可以先注册服务、配置好模型，再创建插件
 */
export function collectProviders(sources: readonly LoadedPlugin[]): { providers: { plugin: string; def: PluginProvider }[]; warnings: string[] } {
  const warnings: string[] = [];
  const providers = sources.flatMap((source) => {
    if (source.providers === undefined) return [];
    const where = `plugin ${source.id} (${source.layer})`;
    if (source.layer === "project") {
      warnings.push(`${where}: providers are ignored: only user plugins can provide model services`);
      return [];
    }
    if (!Array.isArray(source.providers)) {
      warnings.push(`${where}: providers is ignored: it must be an array`);
      return [];
    }
    return (source.providers as PluginProvider[])
      .filter((d) => {
        const ok = d && typeof d.kind === "string" && PROVIDER_KIND.test(d.kind) && typeof d.model === "function" && typeof d.create === "function";
        if (!ok) warnings.push(`${where}: provider ${JSON.stringify(d?.kind)} is ignored: it needs a kind of letters, digits, - and _, and model and create functions`);
        else if (d.settings !== undefined) d.settings = providerSettings(d.settings, `${where}: provider ${d.kind}`, warnings);
        return ok;
      })
      .map((def) => ({ plugin: source.id, def }));
  });
  return { providers, warnings };
}

/** 插件服务的配置项：格式不对、用了 jade 自己的变量、重复、第二个 model 的跳过并警告 */
function providerSettings(raw: unknown, where: string, warnings: string[]): ProviderSetting[] {
  if (!Array.isArray(raw)) {
    warnings.push(`${where}: settings are ignored: they must be an array`);
    return [];
  }
  const out: ProviderSetting[] = [];
  for (const x of raw as Partial<ProviderSetting>[]) {
    const env = x?.env;
    if (typeof env !== "string" || !SETTING_ENV.test(env) || env.startsWith("JADE_") || typeof x.label !== "string") {
      warnings.push(`${where}: setting ${JSON.stringify(env)} is ignored: it needs an env name of capital letters, digits and _ (not JADE_…) and a label`);
    } else if (out.some((o) => o.env === env)) warnings.push(`${where}: setting ${env} is ignored: it is listed twice`);
    else if (x.model && out.some((o) => o.model)) warnings.push(`${where}: setting ${env} is ignored: only one setting can be the model`);
    else out.push(x as ProviderSetting);
  }
  return out;
}
