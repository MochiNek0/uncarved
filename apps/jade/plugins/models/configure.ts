// /model：选服务、填地址和密钥、选模型、改输出上限、思考力度、上下文窗口、限速和能不能看图。
// 配置写进 $JADE_HOME/.env；用过的服务和模型记在 $JADE_HOME/models.json 里（saved.ts），可以直接切回去。
//
// 从旧 jade 的 ui/configure.ts 移植。省掉了旧 jade 的"插件提供的模型服务"（新的 jade 还没有这种服务），
// 其余流程一样。

import { readFile, rm, writeFile } from "node:fs/promises";
import { hasProvider, parseTokens } from "./config.ts";
import { contextWindow } from "./context.ts";
import { EFFORTS, isBuiltinKind, jsonObject, KEY_KEY, listModels, MODEL_KEY, providerInfo, providerKind, rpmFromEnv, URL_KEY, visionFromEnv, type ProviderKind } from "./provider.ts";
import { MODEL_SETTINGS, readSavedServices, updateEnvFile, writeSavedServices, type Env, type SavedModel, type SavedService } from "./saved.ts";
import type { UI } from "@uncarved/jade-api";

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
const serviceKeys = (kind: ProviderKind) => ["JADE_PROVIDER", URL_KEY[kind], KEY_KEY[kind]];

const pick = (env: Env, keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
};

/** keys 里明确清掉（设成默认）的那些：空字符串表示"不设"，写进 models.json 时删掉；env 里没提到的不算 */
const blank = (env: Env, keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) if (k in env && env[k] === undefined) out[k] = "";
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

/** 保存过的、不是当前的模型，按服务分组：当前服务的在前 */
function otherModels(services: SavedService[], currentId: string | undefined, currentModel: string): { service: SavedService; model: SavedModel }[] {
  return [...services.filter((s) => serviceId(s.env) === currentId), ...services.filter((s) => serviceId(s.env) !== currentId)].flatMap((s) =>
    s.models.filter((m) => !(serviceId(s.env) === currentId && m.name === currentModel)).map((m) => ({ service: s, model: m })),
  );
}

/** Claude 不设输出上限时用的值：和 @uncarved/provider-anthropic 里的默认值一致（不从那里导入：加载它的 SDK 要一百多毫秒） */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 64000;

/** 选项说明里放不下的长文本截短 */
const shorten = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 模型设置那一项的简要说明，例如 "64K out · 1M ctx · images"；settings 是这个模型自己的设置变量 */
function settingsSummary(settings: Env, kind: string, window: number): string {
  const images = visionSetting({ JADE_VISION: settings.JADE_VISION }) ?? (isBuiltinKind(kind) && kind !== "openai-compat");
  return [
    settings.JADE_MAX_TOKENS && `${settings.JADE_MAX_TOKENS} out`,
    settings.JADE_EFFORT && `${settings.JADE_EFFORT} effort`,
    `${settings.JADE_CONTEXT_WINDOW ?? window} ctx`,
    settings.JADE_RPM && `${settings.JADE_RPM}/min`,
    images ? "images" : "no images",
  ]
    .filter(Boolean)
    .join(" · ");
}

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
    const before = await readFile(envFile, "utf8").catch(() => undefined);
    // 传一份拷贝：apply 成功之前插件用的还是旧的那份（失败时状态栏显示的就是实际在用的）
    await updateEnvFile(envFile, updates, { ...opts.env() });
    try {
      await opts.apply();
    } catch (err) {
      // 放回原来的 .env：不然这次会话还用旧的，下次启动却读到这份用不了的配置
      await (before === undefined ? rm(envFile, { force: true }) : writeFile(envFile, before)).catch(() => {});
      report(`Not saved: the configuration is incomplete: ${errorText(err)}`);
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
   * 在当前的服务上换成 model：用过的带上它自己的设置；新的模型沿用输出上限、思考力度和额外请求参数，
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

  /** 选模型：服务能列出模型时从列表里选，否则手动输入。选 Back 和取消一样返回 undefined */
  async function chooseModel(env: Env, current: string | undefined, saved: string[] = []): Promise<string | undefined> {
    const models = await listModels(env, opts.fetch);
    const BACK = "\0back";
    if (models.length > 0) {
      const OTHER = "\0other";
      const picked = await ui.select(
        {
          title: "Choose a model",
          options: [...models.map((m) => ({ label: m, value: m, ...(m === current ? { hint: "current" } : saved.includes(m) ? { hint: "saved" } : {}) })), { label: "Enter a name…", value: OTHER }, { label: "Back", value: BACK }],
        },
        opts.signal,
      );
      if (picked === BACK) return undefined;
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
    const target = services.find((s) => serviceId(s.env) === serviceId(serviceEnv));
    const model = await chooseModel({ ...env, ...serviceEnv }, same ? current?.model : undefined, target?.models.map((m) => m.name));
    if (!model) return false;

    // 用过的模型带上它自己的设置
    const saved = target?.models.find((m) => m.name === model);
    if (target && saved) return useSaved({ ...target, env: { ...target.env, ...pick(serviceEnv, serviceKeys(kind)) } }, saved);

    const updates: Env = { ...serviceEnv, [MODEL_KEY[kind]]: model, JADE_CONTEXT_WINDOW: undefined };
    // 换了服务的新模型从新服务的默认值开始：思考力度、额外请求参数各服务写法不同，限速、输出上限、
    // 能不能看图也是跟着服务和模型走的，沿用当前的容易错（例如免费服务的限速带到付费服务上）。
    // 同一个服务（只换了密钥）照旧沿用
    const sameService = same && sameAddress(env);
    if (!sameService) for (const k of MODEL_SETTINGS) updates[k] = undefined;
    // 其他服务常常默认只给 4096 个输出 token，带思考的模型很容易用完
    if (kind !== "anthropic" && !(sameService && env.JADE_MAX_TOKENS)) {
      const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: "32K" }, opts.signal);
      if (max === undefined || !tokensInput("Output limit", max)) return false;
      if (max) updates.JADE_MAX_TOKENS = max;
    }
    // 同一个地址只换了密钥：原来的服务下的模型归到新的密钥下
    const rekeyed = sameService && currentId !== undefined && key !== env[KEY_KEY[kind]];
    return applyConfig(updates, rekeyed ? currentId : undefined);
  }

  /** 要配置设置的模型：title 和 kind 是显示和按服务取值用的，read 读这个模型现在的设置变量，update 写回改动 */
  interface SettingsTarget {
    title: string;
    kind: string;
    model: string;
    read(): Promise<Env>;
    update(settings: Env): Promise<boolean>;
  }

  /**
   * 某个模型的设置（输出上限、思考力度、上下文窗口、限速、能不能看图，openai-compat 还有额外请求参数）。
   * 改完一项回到这个菜单接着改（重新读一遍，显示的是改过的值）；Back 或 Esc 才离开
   */
  async function configureSettings(target: SettingsTarget) {
    const { title, kind, model } = target;
    const efforts = isBuiltinKind(kind) ? EFFORTS[kind] : undefined;
    while (true) {
      const env = await target.read();
      const action = await ui.select(
        {
          title: `Settings for ${title}`,
          options: [
            { label: "Output limit per reply", value: "max", hint: env.JADE_MAX_TOKENS ? `${env.JADE_MAX_TOKENS} tokens` : kind === "anthropic" ? `${ANTHROPIC_DEFAULT_MAX_TOKENS} tokens (default)` : "service default" },
            ...(efforts ? [{ label: "Reasoning effort", value: "effort", hint: env.JADE_EFFORT ?? (kind === "anthropic" ? "high (default)" : "service default") }] : []),
            { label: "Context window", value: "window", hint: `${contextWindow(model, env)} tokens${env.JADE_CONTEXT_WINDOW ? "" : " (default)"}` },
            { label: "Requests per minute", value: "rpm", hint: env.JADE_RPM ? `${env.JADE_RPM}/min` : "no limit (slows down after being rate limited)" },
            { label: "Can see images", value: "vision", hint: visionHint(env, kind) },
            ...(kind === "openai-compat" ? [{ label: "Extra request body", value: "extra", hint: env.OPENAI_COMPAT_EXTRA_BODY ? shorten(env.OPENAI_COMPAT_EXTRA_BODY) : "none" }] : []),
            { label: "Back", value: "back" },
          ],
        },
        opts.signal,
      );
      if (action === undefined || action === "back") return;
      // 每一项里按 Esc 或者输入有误：什么都不改，回到这个菜单
      if (action === "max") {
        const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: env.JADE_MAX_TOKENS ?? "32K" }, opts.signal);
        if (max !== undefined && tokensInput("Output limit", max)) await target.update({ JADE_MAX_TOKENS: max || undefined });
      } else if (action === "effort" && efforts) {
        const DEFAULT = "\0default";
        const effort = await ui.select(
          {
            title: "Reasoning effort",
            options: [...efforts.map((e) => ({ label: e, value: e, ...(e === env.JADE_EFFORT ? { hint: "current" } : {}) })), { label: "Default", value: DEFAULT, hint: kind === "anthropic" ? "high" : "service default" }],
          },
          opts.signal,
        );
        if (effort !== undefined) await target.update({ JADE_EFFORT: effort === DEFAULT ? undefined : effort });
      } else if (action === "rpm") {
        const n = await ui.input({ title: "Requests per minute, e.g. 20 for most free models (empty for no limit)", initial: env.JADE_RPM ?? "" }, opts.signal);
        if (n === undefined) continue;
        try {
          rpmFromEnv({ JADE_RPM: n });
        } catch (err) {
          report(errorText(err));
          continue;
        }
        await target.update({ JADE_RPM: n.trim() || undefined });
      } else if (action === "vision") {
        const DEFAULT = "\0default";
        const current = visionSetting(env);
        const choice = await ui.select(
          {
            title: "Can this model see images (screenshots, image files)?",
            options: [
              { label: "Yes", value: "on", hint: current === true ? "current" : "images are sent to the model" },
              { label: "No", value: "off", hint: current === false ? "current" : "images are replaced with a note" },
              { label: "Default", value: DEFAULT, hint: isBuiltinKind(kind) && kind !== "openai-compat" ? "yes" : "no" },
            ],
          },
          opts.signal,
        );
        if (choice === undefined) continue;
        if (await target.update({ JADE_VISION: choice === DEFAULT ? undefined : choice })) {
          const on = choice === DEFAULT ? isBuiltinKind(kind) && kind !== "openai-compat" : choice === "on";
          report(on ? "Images will be sent to the model." : "Images will be replaced with a note.");
        }
      } else if (action === "window") {
        const n = await ui.input({ title: "Context window in tokens, e.g. 128000, 512K, 1M (empty to infer it from the model name, or 256K if unknown)", initial: env.JADE_CONTEXT_WINDOW ?? "" }, opts.signal);
        if (n !== undefined && tokensInput("Context window", n)) await target.update({ JADE_CONTEXT_WINDOW: n || undefined });
      } else if (action === "extra" && kind === "openai-compat") {
        const text = await ui.input(
          { title: 'JSON merged into every request for this model, e.g. {"enable_thinking":true} (empty for none)', initial: env.OPENAI_COMPAT_EXTRA_BODY ?? "" },
          opts.signal,
        );
        if (text === undefined) continue;
        if (text.trim()) {
          try {
            jsonObject("Extra request body", text);
          } catch (err) {
            report(errorText(err));
            continue;
          }
        }
        await target.update({ OPENAI_COMPAT_EXTRA_BODY: text.trim() || undefined });
      }
    }
  }

  /** 把模型的设置写进 models.json 里那一个模型；.env 不变（当前用的还是原来的模型）。改回默认值的设置从 settings 里删掉 */
  async function writeSavedModel(service: SavedService, model: SavedModel, settings: Env): Promise<boolean> {
    const id = serviceId(service.env);
    const all = await readSavedServices(modelsFile);
    const mine = id === undefined ? undefined : all.find((s) => serviceId(s.env) === id);
    if (!mine) {
      report(`Not saved: ${describeService(service)} is no longer in ${modelsFile}.`);
      return false;
    }
    const mineIndex = all.indexOf(mine);
    const modelIndex = mine.models.findIndex((m) => m.name === model.name);
    // 在文件里现在的设置上改：菜单打开之后 models.json 可能被别的会话改过
    const merged: Env = { ...(mine.models[modelIndex]?.settings ?? model.settings), ...pick(settings, MODEL_SETTINGS), ...blank(settings, MODEL_SETTINGS) };
    const next: SavedModel = { name: model.name, settings: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string> };
    const models = modelIndex === -1 ? [next, ...mine.models] : [...mine.models.slice(0, modelIndex), next, ...mine.models.slice(modelIndex + 1)];
    await writeSavedServices(modelsFile, [...all.slice(0, mineIndex), { ...mine, models }, ...all.slice(mineIndex + 1)]);
    report(`Settings for ${model.name} (${describeService(mine)}) saved to ${modelsFile}.`);
    return true;
  }

  /** 把保存过的模型从 models.json 里删掉；服务下没有模型了就连服务（和它的密钥）一起删掉 */
  async function forgetModel(service: SavedService, model: SavedModel): Promise<void> {
    const id = serviceId(service.env);
    if (!id) return;
    const rest = (await readSavedServices(modelsFile))
      .map((s) => (serviceId(s.env) === id ? { ...s, models: s.models.filter((m) => m.name !== model.name) } : s))
      .filter((s) => s.models.length > 0);
    await writeSavedServices(modelsFile, rest);
    report(`Removed ${model.name} (${describeService(service)}).`);
  }

  /**
   * 选中主菜单里一个模型后：切换、配置它（不用先切到它）、把它删掉或返回主菜单。
   * 当前的模型只能配置（切换没意义；删掉了下次进 /model 又会被记回来）。从设置里出来回到这个菜单；
   * 切换、删除、Back 或 Esc 回到主菜单
   */
  async function pickModelAction(o: { service: SavedService; model: SavedModel }, isCurrent: boolean): Promise<void> {
    const kind = providerKind(o.service.env);
    // 当前的模型改 .env 就好——applyConfig 里的 remember 会把改完的 .env 写回 models.json；
    // 其他保存过的模型只改 models.json 里的那一个
    const read = isCurrent ? async () => pick(opts.env(), MODEL_SETTINGS) : () => savedSettings(o.service, o.model);
    while (true) {
      const settings = await read();
      const action = await ui.select(
        {
          title: o.model.name,
          options: [
            ...(isCurrent
              ? []
              : [{ label: "Switch to it", value: "switch", hint: serviceId(o.service.env) === serviceId(opts.env()) ? "this service" : describeService(o.service) }]),
            { label: "Settings…", value: "settings", hint: settingsSummary(settings, kind, contextWindow(o.model.name, settings)) },
            ...(isCurrent ? [] : [{ label: "Remove", value: "forget" }]),
            { label: "Back", value: "back" },
          ],
        },
        opts.signal,
      );
      if (action === "settings") {
        await configureSettings({
          title: o.model.name,
          kind,
          model: o.model.name,
          read,
          update: (updates) => (isCurrent ? applyConfig(updates) : writeSavedModel(o.service, o.model, updates)),
        });
        continue;
      }
      // 用刚读到的设置切换：在这个菜单里改过的也带上
      if (action === "switch") await useSaved(o.service, { ...o.model, settings });
      else if (action === "forget") await forgetModel(o.service, o.model);
      return;
    }
  }

  /** 保存过的模型在 models.json 里现在的设置；找不到时用 fallback 那份 */
  async function savedSettings(service: SavedService, fallback: SavedModel): Promise<Record<string, string>> {
    const id = serviceId(service.env);
    const mine = id === undefined ? undefined : (await readSavedServices(modelsFile)).find((s) => serviceId(s.env) === id);
    return mine?.models.find((m) => m.name === fallback.name)?.settings ?? fallback.settings;
  }

  async function configureModel(arg: string | undefined) {
    const env = opts.env();
    // 还没有配置模型：没有"当前的服务"可以换模型，先选服务
    if (!hasProvider(env)) return void (await configureProvider());
    // 之前只有 .env 时配置的模型也记下来，之后换了不会丢
    await remember().catch(() => {});
    if (arg) {
      // 保存过的模型按名字切换（当前服务的优先），否则换当前服务的模型
      const saved = otherModels(await savedServices(), serviceId(env), providerInfo(env).model).find((o) => o.model.name === arg);
      return void (await (saved ? useSaved(saved.service, saved.model) : switchModel(arg)));
    }
    // 主菜单循环：保存过的模型全部直接列出（当前的在最前，然后是同一服务的），选中出一个子菜单
    // （切换 / 设置 / 删除 / 返回）；配置某个模型、把它删掉都不用先切到它，做完回到主菜单再选。
    // 每一轮都重读当前配置：切换、配置之后模型和它的设置可能都变了
    while (true) {
      const env = opts.env();
      const id = serviceId(env);
      const kind = providerKind(env);
      const kindKnown = isBuiltinKind(kind);
      const info = providerInfo(env);
      const here = describeService({ env: kindKnown ? pick(env, serviceKeys(kind as ProviderKind)) : {}, models: [] });
      const services = await savedServices();
      const multi = services.length > 1;
      const others = otherModels(services, id, info.model);
      const action = await ui.select(
        {
          title: "Switch model",
          options: [
            {
              label: info.model,
              value: "current",
              hint: `${multi ? `${here} · ` : ""}current · ${settingsSummary(env, info.kind, contextWindow(info.model, env))}`,
            },
            ...others.map((o, i) => ({
              label: o.model.name,
              value: `saved:${i}`,
              hint: `${multi ? `${describeService(o.service)} · ` : ""}${settingsSummary(o.model.settings, providerKind(o.service.env), contextWindow(o.model.name, o.model.settings))}`,
            })),
            { label: "Add a model…", value: "add", hint: "from this service or another one" },
          ],
        },
        opts.signal,
      );
      if (action === undefined) return; // Esc：整个 /model 结束
      if (action === "current") {
        const service = { env: kindKnown ? { ...pick(env, serviceKeys(kind as ProviderKind)), JADE_PROVIDER: kind } : { JADE_PROVIDER: kind }, models: [] };
        await pickModelAction({ service, model: { name: info.model, settings: pick(env, MODEL_SETTINGS) } }, true);
      } else if (action.startsWith("saved:")) {
        const o = others[Number(action.slice(6))];
        if (o) await pickModelAction(o, false);
      } else if (action === "add") {
        const where = await ui.select(
          {
            title: "Add a model from",
            options: [
              { label: "This service", value: "model", hint: here },
              { label: "Another service…", value: "provider", hint: "or change this one's base URL / API key" },
              { label: "Back", value: "back" },
            ],
          },
          opts.signal,
        );
        // 做完、Back、Esc 或没填完，都回到主菜单
        if (where === "model") {
          const saved = services.find((s) => serviceId(s.env) === id)?.models.map((m) => m.name);
          const model = await chooseModel(env, info.model, saved);
          if (model && model !== info.model) await switchModel(model);
        } else if (where === "provider") await configureProvider();
      }
    }
  }

  return { provider: configureProvider, model: configureModel };
}
