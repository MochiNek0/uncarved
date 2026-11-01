// /model：选服务、填地址和密钥、选模型、改输出上限、思考力度和上下文窗口。配置写进 $JADE_HOME/.env。
// 配置过的服务和模型都记在 $JADE_HOME/models.json 里：同一个服务（类型、地址、密钥都相同）下的模型放在一起，
// 每个模型带自己的设置。/model 可以直接切回去，换了服务或地址之前的也不会丢。

import { hasProvider, parseTokens, readSavedServices, updateEnvFile, writeSavedServices, type SavedModel, type SavedService } from "../config.ts";
import { EFFORTS, listModels, providerInfo, providerKind, rpmFromEnv, type ProviderKind } from "../provider.ts";
import { shortPath } from "./render.ts";
import { dim, green, red, type Screen } from "./screen.ts";

export interface ConfigureOptions {
  screen: Screen;
  envFile: string;
  /** 保存过的服务和模型（$JADE_HOME/models.json） */
  modelsFile: string;
  /** 按新的环境变量换上 provider、更新上下文窗口；配置不完整时抛出 */
  apply(): Promise<void>;
  /** 当前的上下文窗口（显示用） */
  contextWindow(): number;
  /** 配置成功后更新状态栏 */
  onApplied(): void;
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

const MODEL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_MODEL", openai: "OPENAI_MODEL", anthropic: "ANTHROPIC_MODEL" };
const KEY_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const URL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_BASE_URL", openai: "OPENAI_BASE_URL", anthropic: "ANTHROPIC_BASE_URL" };

/** 每个模型自己的设置：切换模型时一起换掉 */
const MODEL_SETTINGS = ["JADE_MAX_TOKENS", "JADE_EFFORT", "JADE_CONTEXT_WINDOW", "JADE_RPM"];

/** 一个服务包含的变量 */
const serviceKeys = (kind: ProviderKind) => [
  "JADE_PROVIDER",
  URL_KEY[kind],
  KEY_KEY[kind],
  ...(kind === "openai-compat" ? ["OPENAI_COMPAT_EXTRA_BODY"] : []),
];

type Env = Record<string, string | undefined>;

const pick = (env: Env, keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
};

/** 服务的类型、地址和密钥都相同的算同一个；配置无效时返回 undefined */
function serviceId(env: Env): string | undefined {
  try {
    const i = providerInfo(env);
    return `${i.kind}|${i.baseURL ?? ""}|${env[KEY_KEY[i.kind]] ?? ""}`;
  } catch {
    return undefined;
  }
}

/** 选择列表里服务的说明：类型和地址的主机名 */
function describeService(s: SavedService): string {
  const i = providerInfo(s.env);
  let host = i.baseURL ?? "";
  try {
    host = new URL(host).host;
  } catch {}
  return [i.kind, host].filter(Boolean).join(" · ");
}

/** 输入的 token 数：空表示不设；写错时报告并返回 false */
function tokensInput(screen: Screen, name: string, text: string): boolean {
  if (!text) return true;
  try {
    parseTokens(name, text);
    return true;
  } catch (err) {
    screen.log(red(errorText(err)));
    return false;
  }
}

/** 选择列表里一组模型的说明：前几个名字 */
function modelNames(models: SavedModel[]): string {
  const names = models.slice(0, 3).map((m) => m.name).join(", ");
  return models.length > 3 ? `${names} +${models.length - 3}` : names;
}

/** "2 services · 5 models" */
function countServices(services: SavedService[]): string {
  const n = services.reduce((sum, s) => sum + s.models.length, 0);
  return `${services.length} service${services.length > 1 ? "s" : ""} · ${n} model${n > 1 ? "s" : ""}`;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function configurator(opts: ConfigureOptions): Configure {
  const { screen, envFile, modelsFile } = opts;

  /** 保存过的、有效的服务，最近用过的在前 */
  const savedServices = async () => (await readSavedServices(modelsFile)).filter((s) => serviceId(s.env) !== undefined);

  /**
   * 把当前的服务和模型记下来，都放到最前面。
   * replacing：换了密钥的那个服务原来的 id，它下面的模型归到新的密钥下
   */
  async function remember(replacing?: string) {
    if (!hasProvider()) return;
    const id = serviceId(process.env);
    const model = providerInfo().model;
    if (!id || !model) return;
    const kind = providerKind();
    const services = await savedServices();
    const old = services.filter((s) => serviceId(s.env) === id || (replacing !== undefined && serviceId(s.env) === replacing));
    const models = old.flatMap((s) => s.models).filter((m, i, all) => m.name !== model && all.findIndex((x) => x.name === m.name) === i);
    const service: SavedService = {
      env: { ...pick(process.env, serviceKeys(kind)), JADE_PROVIDER: kind },
      models: [{ name: model, settings: pick(process.env, MODEL_SETTINGS) }, ...models],
    };
    await writeSavedServices(modelsFile, [service, ...services.filter((s) => !old.includes(s))]);
  }

  /** 保存配置并换上新的 provider；失败时报告原因，旧的 provider 继续用 */
  async function applyConfig(updates: Record<string, string | undefined>, replacing?: string): Promise<boolean> {
    await updateEnvFile(envFile, updates);
    try {
      await opts.apply();
    } catch (err) {
      screen.log(red(`Saved to ${shortPath(envFile)}, but the configuration is incomplete: ${errorText(err)}`));
      return false;
    }
    const info = providerInfo();
    opts.onApplied();
    await remember(replacing).catch((err) => screen.log(red(`Could not save the model list to ${shortPath(modelsFile)}: ${errorText(err)}`)));
    screen.log(green(`Model: ${info.model} (${info.kind}${info.baseURL ? `, ${info.baseURL}` : ""}). Saved to ${shortPath(envFile)}.`));
    return true;
  }

  /** 换成保存过的服务 s 上的模型 m：服务的变量和模型的设置写进 .env，模型没设的设置删掉 */
  function useSaved(s: SavedService, m: SavedModel): Promise<boolean> {
    const kind = providerKind(s.env);
    const updates: Record<string, string | undefined> = {};
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
    const id = serviceId(process.env);
    const service = (await savedServices()).find((s) => serviceId(s.env) === id);
    const saved = service?.models.find((m) => m.name === model);
    if (service && saved) return useSaved(service, saved);
    return applyConfig({ [MODEL_KEY[providerKind()]]: model, JADE_CONTEXT_WINDOW: undefined });
  }

  /** 选模型：服务能列出模型时从列表里选，否则手动输入 */
  async function chooseModel(env: Env, current: string | undefined, saved: string[] = []): Promise<string | undefined> {
    const models = await listModels(env);
    if (models.length > 0) {
      const OTHER = "\0other";
      const picked = await screen.select(
        "Choose a model",
        [
          ...models.map((m) => ({ label: m, value: m, hint: m === current ? "current" : saved.includes(m) ? "saved" : undefined })),
          { label: "Enter a name…", value: OTHER },
        ],
      );
      if (picked !== OTHER) return picked;
    }
    return (await screen.input("Model name", { initial: current })) || undefined;
  }

  async function configureProvider(): Promise<boolean> {
    const current = hasProvider() ? providerInfo() : undefined;
    const currentId = hasProvider() ? serviceId(process.env) : undefined;
    const kind = await screen.select(
      "Which service should jade use?",
      PROVIDERS.map((p) => ({ label: p.label, value: p.kind, hint: p.kind === current?.kind ? `${p.hint} · current` : p.hint })),
    );
    if (!kind) return false;
    const same = kind === current?.kind;

    let baseURL: string | undefined = process.env[URL_KEY[kind]];
    if (kind !== "anthropic") {
      const fallback = kind === "openai" ? "https://api.openai.com/v1" : "";
      const answer = await screen.input("Base URL", { initial: baseURL ?? fallback, placeholder: "https://example.com/v1" });
      if (answer === undefined) return false;
      if (kind === "openai-compat" && !answer) {
        screen.log(red("A base URL is required."));
        return false;
      }
      baseURL = answer || undefined;
    }

    // 已知的密钥：当前服务的，或者保存过的同一个地址的服务的（最近用过的那个）
    const sameAddress = (env: Env) => {
      const i = providerInfo(env);
      return i.kind === kind && (i.baseURL ?? "") === (providerInfo({ JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL }).baseURL ?? "");
    };
    const services = await savedServices();
    const known = current && sameAddress(process.env) ? process.env[KEY_KEY[kind]] : services.find((s) => sameAddress(s.env))?.env[KEY_KEY[kind]];
    const answer = await screen.input("API key", {
      mask: true,
      placeholder: known ? "leave empty to keep the saved key" : kind === "openai-compat" ? "leave empty if the service needs none" : "",
    });
    if (answer === undefined) return false;
    const key = answer || known;

    const serviceEnv: Env = { JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, [KEY_KEY[kind]]: key };
    if (kind === "openai-compat") {
      // 额外的请求参数跟着服务走：同一个服务保留，换了服务用保存过的那份
      const saved = services.find((s) => serviceId(s.env) === serviceId(serviceEnv));
      serviceEnv.OPENAI_COMPAT_EXTRA_BODY = saved ? saved.env.OPENAI_COMPAT_EXTRA_BODY : sameAddress(process.env) ? process.env.OPENAI_COMPAT_EXTRA_BODY : undefined;
    }
    const target = services.find((s) => serviceId(s.env) === serviceId(serviceEnv));
    const model = await chooseModel({ ...process.env, ...serviceEnv }, same ? current?.model : undefined, target?.models.map((m) => m.name));
    if (!model) return false;

    // 用过的模型带上它自己的设置
    const saved = target?.models.find((m) => m.name === model);
    if (target && saved) return useSaved({ ...target, env: { ...target.env, ...pick(serviceEnv, serviceKeys(kind)) } }, saved);

    const updates: Record<string, string | undefined> = { ...serviceEnv, [MODEL_KEY[kind]]: model, JADE_CONTEXT_WINDOW: undefined };
    // 思考力度的取值每种服务不同
    if (!same) updates.JADE_EFFORT = undefined;
    // 其他服务常常默认只给 4096 个输出 token，带思考的模型很容易用完
    if (kind !== "anthropic" && !process.env.JADE_MAX_TOKENS) {
      const max = await screen.input("Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", { initial: "32K" });
      if (max === undefined || !tokensInput(screen, "Output limit", max)) return false;
      if (max) updates.JADE_MAX_TOKENS = max;
    }
    // 同一个地址只换了密钥：原来的服务下的模型归到新的密钥下
    const rekeyed = same && currentId !== undefined && sameAddress(process.env) && key !== process.env[KEY_KEY[kind]];
    return applyConfig(updates, rekeyed ? currentId : undefined);
  }

  async function configureModel(arg: string | undefined) {
    const info = providerInfo();
    // 之前只有 .env 时配置的模型也记下来，之后换了不会丢
    await remember().catch(() => {});
    const currentId = serviceId(process.env);
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
    // 菜单里只列当前服务保存过的模型；其他服务的先选服务再选模型，配置的模型多时列表不会很长
    const here = others.filter((o) => serviceId(o.service.env) === currentId);
    const elsewhere = services.filter((s) => serviceId(s.env) !== currentId);
    const efforts = EFFORTS[info.kind];
    const action = await screen.select<string>(`Model: ${info.model} (${describeService({ env: process.env as Record<string, string>, models: [] })})`, [
      ...here.map((o) => ({ label: `Use ${o.model.name}`, value: `saved:${others.indexOf(o)}`, hint: "saved" })),
      ...(elsewhere.length
        ? [{ label: "Use a model from another service…", value: "service" as const, hint: countServices(elsewhere) }]
        : []),
      { label: "Add a model from this service", value: "model" as const, hint: `current: ${info.model}` },
      { label: "Add a service, or change the base URL or API key", value: "provider" as const, hint: info.baseURL },
      { label: "Output limit per reply", value: "max" as const, hint: process.env.JADE_MAX_TOKENS ? `${process.env.JADE_MAX_TOKENS} tokens` : "service default" },
      ...(efforts
        ? [{ label: "Reasoning effort", value: "effort" as const, hint: process.env.JADE_EFFORT ?? (info.kind === "anthropic" ? "high (default)" : "service default") }]
        : []),
      {
        label: "Context window",
        value: "window" as const,
        hint: `${opts.contextWindow()} tokens${process.env.JADE_CONTEXT_WINDOW ? "" : " (default)"}`,
      },
      {
        label: "Requests per minute",
        value: "rpm" as const,
        hint: process.env.JADE_RPM ? `${process.env.JADE_RPM}/min` : "no limit (slows down after being rate limited)",
      },
      ...(others.length ? [{ label: "Forget a saved model", value: "forget" as const }] : []),
    ]);
    if (action?.startsWith("saved:")) {
      const o = others[Number(action.slice(6))]!;
      await useSaved(o.service, o.model);
    } else if (action === "service") {
      const picked = await pickSaved(elsewhere, "Use a model from which service?");
      if (picked) await useSaved(picked.service, picked.model);
    } else if (action === "forget") {
      const owners = services.filter((s) => others.some((o) => o.service === s));
      const gone = await pickSaved(owners, "Forget a model from which service?", (s, m) => !(serviceId(s.env) === currentId && m.name === info.model));
      if (!gone) return;
      const id = serviceId(gone.service.env);
      // 服务下没有模型了就连服务（和它的密钥）一起删掉
      const rest = (await savedServices())
        .map((s) => (serviceId(s.env) === id ? { ...s, models: s.models.filter((m) => m.name !== gone.model.name) } : s))
        .filter((s) => s.models.length > 0);
      await writeSavedServices(modelsFile, rest);
      screen.log(dim(`Forgot ${gone.model.name} (${describeService(gone.service)}).`));
    } else if (action === "model") {
      const saved = services.find((s) => serviceId(s.env) === currentId)?.models.map((m) => m.name);
      const model = await chooseModel(process.env, info.model, saved);
      if (model && model !== info.model) await switchModel(model);
    } else if (action === "provider") await configureProvider();
    else if (action === "max") {
      const max = await screen.input("Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", { initial: process.env.JADE_MAX_TOKENS ?? "32K" });
      if (max !== undefined && tokensInput(screen, "Output limit", max)) await applyConfig({ JADE_MAX_TOKENS: max || undefined });
    } else if (action === "effort" && efforts) {
      const DEFAULT = "\0default";
      const effort = await screen.select("Reasoning effort", [
        ...efforts.map((e) => ({ label: e, value: e, hint: e === process.env.JADE_EFFORT ? "current" : undefined })),
        { label: "Default", value: DEFAULT, hint: info.kind === "anthropic" ? "high" : "service default" },
      ]);
      if (effort !== undefined) await applyConfig({ JADE_EFFORT: effort === DEFAULT ? undefined : effort });
    } else if (action === "rpm") {
      const n = await screen.input("Requests per minute, e.g. 20 for most free models (empty for no limit)", { initial: process.env.JADE_RPM ?? "" });
      if (n === undefined) return;
      try {
        rpmFromEnv({ JADE_RPM: n });
      } catch (err) {
        return screen.log(red(errorText(err)));
      }
      await applyConfig({ JADE_RPM: n.trim() || undefined });
    } else if (action === "window") {
      const n = await screen.input("Context window in tokens, e.g. 128000, 512K, 1M (empty to infer it from the model name, or 128K if unknown)", {
        initial: process.env.JADE_CONTEXT_WINDOW ?? "",
      });
      if (n !== undefined && tokensInput(screen, "Context window", n)) await applyConfig({ JADE_CONTEXT_WINDOW: n || undefined });
    }
  }

  /**
   * 从几个服务里选一个保存过的模型：只有一个服务时直接列它的模型，否则先选服务。
   * keep 过滤可选的模型；取消时返回 undefined
   */
  async function pickSaved(
    from: SavedService[],
    title: string,
    keep: (s: SavedService, m: SavedModel) => boolean = () => true,
  ): Promise<{ service: SavedService; model: SavedModel } | undefined> {
    const groups = from.map((s) => ({ service: s, models: s.models.filter((m) => keep(s, m)) })).filter((g) => g.models.length > 0);
    const group =
      groups.length === 1
        ? groups[0]
        : await screen.select(
            title,
            groups.map((g) => ({ label: describeService(g.service), value: g, hint: modelNames(g.models) })),
          );
    if (!group) return undefined;
    const model = await screen.select(
      `Model (${describeService(group.service)})`,
      group.models.map((m) => ({ label: m.name, value: m })),
    );
    return model && { service: group.service, model };
  }

  return { provider: configureProvider, model: configureModel };
}
