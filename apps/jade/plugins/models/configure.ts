// /model：选服务、填地址和密钥、选模型、改输出上限、思考力度、上下文窗口、限速和能不能看图。
// 配置写进 $JADE_HOME/.env；用过的服务和模型记在 $JADE_HOME/models.json 里（saved.ts），可以直接切回去。
//
// 从旧 jade 的 ui/configure.ts 移植。省掉了旧 jade 的"插件提供的模型服务"（新的 jade 还没有这种服务），
// 其余流程一样。

import { hasProvider, parseTokens } from "./config.ts";
import { contextWindow } from "./context.ts";
import { EFFORTS, isBuiltinKind, KEY_KEY, listModels, MODEL_KEY, providerInfo, providerKind, rpmFromEnv, URL_KEY, visionFromEnv, type ProviderKind } from "./provider.ts";
import { MODEL_SETTINGS, readSavedServices, updateEnvFile, writeSavedServices, type Env, type SavedModel, type SavedService } from "./saved.ts";
import type { UI } from "../../src/api.ts";

export interface ConfigureOptions {
  envFile: string;
  modelsFile: string;
  /** 当前的模型配置；updateEnvFile 会改它，apply 之后要用新的那个 */
  env(): Env;
  /** 按新的环境变量换上 provider；配置不完整时抛出 */
  apply(): Promise<void>;
  /** 在对话里显示一段文字 */
  report(text: string): void;
  ui: UI;
  /** 用户中断时中止 */
  signal: AbortSignal;
  /** 测试用：列模型时的 fetch */
  fetch?: typeof fetch;
}

export interface Configure {
  /** 选服务、填地址和密钥、选模型；返回是否配置成功 */
  provider(): Promise<boolean>;
  /** /model [name] */
  model(arg: string | undefined): Promise<void>;
}

const PROVIDERS: Array<{ kind: ProviderKind; label: string; hint: string }> = [
  { kind: "openai-compat", label: "OpenAI-compatible service", hint: "any /chat/completions endpoint" },
  { kind: "openai", label: "OpenAI", hint: "Responses API" },
  { kind: "anthropic", label: "Anthropic", hint: "Claude" },
];

/** JADE_VISION 设成了什么；没设或写错时 undefined */
function visionSetting(env: Env): boolean | undefined {
  if (!env.JADE_VISION?.trim()) return undefined;
  try {
    return visionFromEnv({ JADE_VISION: env.JADE_VISION });
  } catch {
    return undefined;
  }
}

function visionHint(env: Env, kind: string): string {
  const v = visionSetting(env);
  return v === undefined ? `${isBuiltinKind(kind) && kind !== "openai-compat" ? "yes" : "no"} (default)` : v ? "yes" : "no";
}

/** 一个服务包含的变量（不含模型名） */
const serviceKeys = (kind: ProviderKind) => ["JADE_PROVIDER", URL_KEY[kind], KEY_KEY[kind], ...(kind === "openai-compat" ? ["OPENAI_COMPAT_EXTRA_BODY"] : [])];

const pick = (env: Env, keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
};

/** 服务的类型、地址和密钥都相同的算同一个；配置无效时返回 undefined */
function serviceId(env: Env): string | undefined {
  try {
    const i = providerInfo(env);
    if (!isBuiltinKind(i.kind)) return undefined;
    return `${i.kind}|${i.baseURL ?? ""}|${env[KEY_KEY[i.kind]] ?? ""}`;
  } catch {
    return undefined;
  }
}

/** 选择列表里服务的说明：类型和地址的主机名 */
function describeService(service: SavedService): string {
  const i = providerInfo(service.env);
  let host = i.baseURL ?? "";
  try {
    host = new URL(host).host;
  } catch {}
  return [i.kind, host].filter(Boolean).join(" · ");
}

/** 选择列表里一组模型的说明：前几个名字 */
function modelNames(models: SavedModel[]): string {
  const names = models.slice(0, 3).map((m) => m.name).join(", ");
  return models.length > 3 ? `${names} +${models.length - 3}` : names;
}

/** 主菜单里设置那一项的简要说明，例如 "64K out · 1M ctx · images" */
function settingsSummary(env: Env, kind: string, window: number): string {
  const images = visionSetting(env) ?? (isBuiltinKind(kind) && kind !== "openai-compat");
  return [
    env.JADE_MAX_TOKENS && `${env.JADE_MAX_TOKENS} out`,
    env.JADE_EFFORT && `${env.JADE_EFFORT} effort`,
    `${env.JADE_CONTEXT_WINDOW ?? window} ctx`,
    env.JADE_RPM && `${env.JADE_RPM}/min`,
    images ? "images" : "no images",
  ]
    .filter(Boolean)
    .join(" · ");
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function configurator(opts: ConfigureOptions): Configure {
  const { ui, envFile, modelsFile } = opts;
  const report = (text: string) => opts.report(text);

  /** 保存过的、有效的服务，最近用过的在前 */
  const savedServices = async () => (await readSavedServices(modelsFile)).filter((s) => serviceId(s.env) !== undefined);

  /** 输入的 token 数：空表示不设；写错时报告并返回 false */
  const tokensInput = (name: string, text: string): boolean => {
    if (!text) return true;
    try {
      parseTokens(name, text);
      return true;
    } catch (err) {
      report(errorText(err));
      return false;
    }
  };

  /**
   * 把当前的服务和模型记下来，都放到最前面。
   * replacing：换了密钥的那个服务原来的 id，它下面的模型归到新的密钥下
   */
  async function remember(replacing?: string) {
    const env = opts.env();
    if (!hasProvider(env)) return;
    const id = serviceId(env);
    const model = providerInfo(env).model;
    const kind = providerKind(env);
    if (!id || !model || !isBuiltinKind(kind)) return;
    // 写回时保留现在认不出的服务，不然它和它的密钥就丢了
    const all = await readSavedServices(modelsFile);
    const old = all.filter((s) => {
      const sid = serviceId(s.env);
      return sid !== undefined && (sid === id || (replacing !== undefined && sid === replacing));
    });
    const models = old.flatMap((s) => s.models).filter((m, i, list) => m.name !== model && list.findIndex((x) => x.name === m.name) === i);
    const service: SavedService = {
      env: { ...pick(env, serviceKeys(kind)), JADE_PROVIDER: kind },
      models: [{ name: model, settings: pick(env, MODEL_SETTINGS) }, ...models],
    };
    await writeSavedServices(modelsFile, [service, ...all.filter((s) => !old.includes(s))]);
  }

  /** 保存配置并换上新的 provider；失败时报告原因，旧的配置和 provider 继续用 */
  async function applyConfig(updates: Env, replacing?: string): Promise<boolean> {
    // 传一份拷贝：apply 成功之前插件用的还是旧的那份（失败时状态栏显示的就是实际在用的）
    await updateEnvFile(envFile, updates, { ...opts.env() });
    try {
      await opts.apply();
    } catch (err) {
      report(`Saved to ${envFile}, but the configuration is incomplete: ${errorText(err)}`);
      return false;
    }
    const info = providerInfo(opts.env());
    await remember(replacing).catch((err) => report(`Could not save the model list to ${modelsFile}: ${errorText(err)}`));
    report(`Model: ${info.model} (${info.kind}${info.baseURL ? `, ${info.baseURL}` : ""}). Saved to ${envFile}.`);
    return true;
  }

  /** 换成保存过的服务 s 上的模型 m：服务的变量和模型的设置写进 .env，模型没设的设置删掉 */
  function useSaved(s: SavedService, m: SavedModel): Promise<boolean> {
    const kind = providerKind(s.env);
    if (!isBuiltinKind(kind)) {
      report(`The saved service ${describeService(s)} is not one of the built-in providers.`);
      return Promise.resolve(false);
    }
    const updates: Env = {};
    for (const k of serviceKeys(kind)) updates[k] = s.env[k];
    for (const k of MODEL_SETTINGS) updates[k] = m.settings[k];
    updates.JADE_PROVIDER = kind;
    updates[MODEL_KEY[kind]] = m.name;
    return applyConfig(updates);
  }

  /**
   * 在当前的服务上换成 model：用过的带上它自己的设置；新的模型沿用输出上限和思考力度，
   * 上下文窗口不沿用（不同模型差别很大），按模型名推断
   */
  async function switchModel(model: string): Promise<boolean> {
    const env = opts.env();
    const id = serviceId(env);
    const service = (await savedServices()).find((s) => serviceId(s.env) === id);
    const saved = service?.models.find((m) => m.name === model);
    if (service && saved) return useSaved(service, saved);
    const kind = providerKind(env);
    if (!isBuiltinKind(kind)) {
      report(`JADE_PROVIDER must be one of ${PROVIDERS.map((p) => p.kind).join(", ")}; set the model in ${envFile}.`);
      return false;
    }
    return applyConfig({ [MODEL_KEY[kind]]: model, JADE_CONTEXT_WINDOW: undefined });
  }

  /** 选模型：服务能列出模型时从列表里选，否则手动输入 */
  async function chooseModel(env: Env, current: string | undefined, saved: string[] = []): Promise<string | undefined> {
    const models = await listModels(env, opts.fetch);
    if (models.length > 0) {
      const OTHER = "\0other";
      const picked = await ui.select(
        {
          title: "Choose a model",
          options: [...models.map((m) => ({ label: m, value: m, ...(m === current ? { hint: "current" } : saved.includes(m) ? { hint: "saved" } : {}) })), { label: "Enter a name…", value: OTHER }],
        },
        opts.signal,
      );
      if (picked !== OTHER) return picked;
    }
    return (await ui.input({ title: "Model name", ...(current ? { initial: current } : {}) }, opts.signal)) || undefined;
  }

  async function configureProvider(): Promise<boolean> {
    const env = opts.env();
    const current = hasProvider(env) ? providerInfo(env) : undefined;
    const currentId = hasProvider(env) ? serviceId(env) : undefined;
    const kindName = await ui.select(
      {
        title: "Which service should jade use?",
        options: PROVIDERS.map((p) => ({ label: p.label, value: p.kind, hint: p.kind === current?.kind ? `${p.hint} · current` : p.hint })),
      },
      opts.signal,
    );
    if (!kindName || !isBuiltinKind(kindName)) return false;
    const kind: ProviderKind = kindName;
    const same = kind === current?.kind;

    let baseURL: string | undefined = env[URL_KEY[kind]];
    if (kind !== "anthropic") {
      const fallback = kind === "openai" ? "https://api.openai.com/v1" : "";
      const answer = await ui.input({ title: "Base URL", initial: baseURL ?? fallback, placeholder: "https://example.com/v1" }, opts.signal);
      if (answer === undefined) return false;
      if (kind === "openai-compat" && !answer) {
        report("A base URL is required.");
        return false;
      }
      baseURL = answer || undefined;
    }

    // 已知的密钥：当前服务的，或者保存过的同一个地址的服务的（最近用过的那个）
    const sameAddress = (e: Env) => {
      const i = providerInfo(e);
      return i.kind === kind && (i.baseURL ?? "") === (providerInfo({ JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL }).baseURL ?? "");
    };
    const services = await savedServices();
    const known = current && sameAddress(env) ? env[KEY_KEY[kind]] : services.find((s) => sameAddress(s.env))?.env[KEY_KEY[kind]];
    const answer = await ui.input(
      {
        title: "API key",
        mask: true,
        placeholder: known ? "leave empty to keep the saved key" : kind === "openai-compat" ? "leave empty if the service needs none" : "",
      },
      opts.signal,
    );
    if (answer === undefined) return false;
    const key = answer || known;

    const serviceEnv: Env = { JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, [KEY_KEY[kind]]: key };
    if (kind === "openai-compat") {
      // 额外的请求参数跟着服务走：同一个服务保留，换了服务用保存过的那份
      const saved = services.find((s) => serviceId(s.env) === serviceId(serviceEnv));
      serviceEnv.OPENAI_COMPAT_EXTRA_BODY = saved ? saved.env.OPENAI_COMPAT_EXTRA_BODY : sameAddress(env) ? env.OPENAI_COMPAT_EXTRA_BODY : undefined;
    }
    const target = services.find((s) => serviceId(s.env) === serviceId(serviceEnv));
    const model = await chooseModel({ ...env, ...serviceEnv }, same ? current?.model : undefined, target?.models.map((m) => m.name));
    if (!model) return false;

    // 用过的模型带上它自己的设置
    const saved = target?.models.find((m) => m.name === model);
    if (target && saved) return useSaved({ ...target, env: { ...target.env, ...pick(serviceEnv, serviceKeys(kind)) } }, saved);

    const updates: Env = { ...serviceEnv, [MODEL_KEY[kind]]: model, JADE_CONTEXT_WINDOW: undefined };
    // 思考力度的取值每种服务不同
    if (!same) updates.JADE_EFFORT = undefined;
    // 其他服务常常默认只给 4096 个输出 token，带思考的模型很容易用完
    if (kind !== "anthropic" && !env.JADE_MAX_TOKENS) {
      const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: "32K" }, opts.signal);
      if (max === undefined || !tokensInput("Output limit", max)) return false;
      if (max) updates.JADE_MAX_TOKENS = max;
    }
    // 同一个地址只换了密钥：原来的服务下的模型归到新的密钥下
    const rekeyed = same && currentId !== undefined && sameAddress(env) && key !== env[KEY_KEY[kind]];
    return applyConfig(updates, rekeyed ? currentId : undefined);
  }

  /** 当前模型自己的设置（切换模型时跟着换）：输出上限、思考力度、上下文窗口、限速、能不能看图 */
  async function configureSettings() {
    const env = opts.env();
    const info = providerInfo(env);
    const efforts = isBuiltinKind(info.kind) ? EFFORTS[info.kind] : undefined;
    const action = await ui.select(
      {
        title: `Settings for ${info.model}`,
        options: [
          { label: "Output limit per reply", value: "max", hint: env.JADE_MAX_TOKENS ? `${env.JADE_MAX_TOKENS} tokens` : "service default" },
          ...(efforts ? [{ label: "Reasoning effort", value: "effort", hint: env.JADE_EFFORT ?? (info.kind === "anthropic" ? "high (default)" : "service default") }] : []),
          { label: "Context window", value: "window", hint: `${contextWindow(info.model, env)} tokens${env.JADE_CONTEXT_WINDOW ? "" : " (default)"}` },
          { label: "Requests per minute", value: "rpm", hint: env.JADE_RPM ? `${env.JADE_RPM}/min` : "no limit (slows down after being rate limited)" },
          { label: "Can see images", value: "vision", hint: visionHint(env, info.kind) },
        ],
      },
      opts.signal,
    );
    if (action === "max") {
      const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: env.JADE_MAX_TOKENS ?? "32K" }, opts.signal);
      if (max !== undefined && tokensInput("Output limit", max)) await applyConfig({ JADE_MAX_TOKENS: max || undefined });
    } else if (action === "effort" && efforts) {
      const DEFAULT = "\0default";
      const effort = await ui.select(
        {
          title: "Reasoning effort",
          options: [...efforts.map((e) => ({ label: e, value: e, ...(e === env.JADE_EFFORT ? { hint: "current" } : {}) })), { label: "Default", value: DEFAULT, hint: info.kind === "anthropic" ? "high" : "service default" }],
        },
        opts.signal,
      );
      if (effort !== undefined) await applyConfig({ JADE_EFFORT: effort === DEFAULT ? undefined : effort });
    } else if (action === "rpm") {
      const n = await ui.input({ title: "Requests per minute, e.g. 20 for most free models (empty for no limit)", initial: env.JADE_RPM ?? "" }, opts.signal);
      if (n === undefined) return;
      try {
        rpmFromEnv({ JADE_RPM: n });
      } catch (err) {
        return report(errorText(err));
      }
      await applyConfig({ JADE_RPM: n.trim() || undefined });
    } else if (action === "vision") {
      const DEFAULT = "\0default";
      const current = visionSetting(env);
      const choice = await ui.select(
        {
          title: "Can this model see images (screenshots, image files)?",
          options: [
            { label: "Yes", value: "on", hint: current === true ? "current" : "images are sent to the model" },
            { label: "No", value: "off", hint: current === false ? "current" : "images are replaced with a note" },
            { label: "Default", value: DEFAULT, hint: isBuiltinKind(info.kind) && info.kind !== "openai-compat" ? "yes" : "no" },
          ],
        },
        opts.signal,
      );
      if (choice === undefined) return;
      if (await applyConfig({ JADE_VISION: choice === DEFAULT ? undefined : choice })) {
        report(visionFromEnv(opts.env()) ? "Images will be sent to the model." : "Images will be replaced with a note.");
      }
    } else if (action === "window") {
      const n = await ui.input({ title: "Context window in tokens, e.g. 128000, 512K, 1M (empty to infer it from the model name, or 128K if unknown)", initial: env.JADE_CONTEXT_WINDOW ?? "" }, opts.signal);
      if (n !== undefined && tokensInput("Context window", n)) await applyConfig({ JADE_CONTEXT_WINDOW: n || undefined });
    }
  }

  /**
   * 从几个服务里选一个保存过的模型：只有一个服务时直接列它的模型，否则先选服务。
   * keep 过滤可选的模型；取消时返回 undefined
   */
  async function pickSaved(from: SavedService[], title: string, keep: (s: SavedService, m: SavedModel) => boolean = () => true): Promise<{ service: SavedService; model: SavedModel } | undefined> {
    const groups = from.map((s) => ({ service: s, models: s.models.filter((m) => keep(s, m)) })).filter((g) => g.models.length > 0);
    let group = groups[0];
    if (groups.length > 1) {
      const chosen = await ui.select(
        { title, options: groups.map((g, i) => ({ label: describeService(g.service), value: String(i), hint: modelNames(g.models) })) },
        opts.signal,
      );
      if (chosen === undefined) return undefined;
      group = groups[Number(chosen)];
    }
    if (!group) return undefined;
    const chosen = await ui.select(
      { title: `Model (${describeService(group.service)})`, options: group.models.map((m, i) => ({ label: m.name, value: String(i) })) },
      opts.signal,
    );
    if (chosen === undefined) return undefined;
    const model = group.models[Number(chosen)];
    return model && { service: group.service, model };
  }

  async function configureModel(arg: string | undefined) {
    const env = opts.env();
    const info = providerInfo(env);
    // 之前只有 .env 时配置的模型也记下来，之后换了不会丢
    await remember().catch(() => {});
    const currentId = serviceId(env);
    const services = await savedServices();
    /** 保存过的、不是当前的模型，按服务分组：当前服务的在前 */
    const others = [...services.filter((s) => serviceId(s.env) === currentId), ...services.filter((s) => serviceId(s.env) !== currentId)].flatMap((s) =>
      s.models.filter((m) => !(serviceId(s.env) === currentId && m.name === info.model)).map((m) => ({ service: s, model: m })),
    );
    if (arg) {
      // 保存过的模型按名字切换（当前服务的优先），否则换当前服务的模型
      const saved = others.find((o) => o.model.name === arg);
      return void (await (saved ? useSaved(saved.service, saved.model) : switchModel(arg)));
    }
    // 主菜单只管切换：保存过的模型全部直接列出（当前的在最前，然后是同一服务的），选中就换；
    // 添加模型、当前模型的设置、删除各占一项，细节进子菜单再看
    const here = describeService({ env: isBuiltinKind(providerKind(env)) ? pick(env, serviceKeys(providerKind(env) as ProviderKind)) : {}, models: [] });
    const multi = services.length > 1;
    const action = await ui.select(
      {
        title: "Switch model",
        options: [
          { label: info.model, value: "current", hint: multi ? `current · ${here}` : "current" },
          ...others.map((o, i) => ({ label: o.model.name, value: `saved:${i}`, ...(multi ? { hint: describeService(o.service) } : {}) })),
          { label: "Add a model…", value: "add", hint: "from this service or another one" },
          { label: `Settings for ${info.model}…`, value: "settings", hint: settingsSummary(env, info.kind, contextWindow(info.model, env)) },
          ...(others.length ? [{ label: "Remove a saved model…", value: "forget" }] : []),
        ],
      },
      opts.signal,
    );
    if (action?.startsWith("saved:")) {
      const o = others[Number(action.slice(6))]!;
      await useSaved(o.service, o.model);
    } else if (action === "add") {
      const where = await ui.select(
        {
          title: "Add a model from",
          options: [
            { label: "This service", value: "model", hint: here },
            { label: "Another service…", value: "provider", hint: "or change this one's base URL / API key" },
          ],
        },
        opts.signal,
      );
      if (where === "model") {
        const saved = services.find((s) => serviceId(s.env) === currentId)?.models.map((m) => m.name);
        const model = await chooseModel(env, info.model, saved);
        if (model && model !== info.model) await switchModel(model);
      } else if (where === "provider") await configureProvider();
    } else if (action === "settings") await configureSettings();
    else if (action === "forget") {
      const owners = services.filter((s) => others.some((o) => o.service === s));
      const gone = await pickSaved(owners, "Remove a model from which service?", (s, m) => !(serviceId(s.env) === currentId && m.name === info.model));
      if (!gone) return;
      const id = serviceId(gone.service.env);
      // 服务下没有模型了就连服务（和它的密钥）一起删掉；认不出的服务原样保留
      const rest = (await readSavedServices(modelsFile))
        .map((s) => (serviceId(s.env) === id ? { ...s, models: s.models.filter((m) => m.name !== gone.model.name) } : s))
        .filter((s) => s.models.length > 0);
      await writeSavedServices(modelsFile, rest);
      report(`Removed ${gone.model.name} (${describeService(gone.service)}).`);
    }
  }

  return { provider: configureProvider, model: configureModel };
}
