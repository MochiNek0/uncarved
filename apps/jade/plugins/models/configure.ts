// /model：选服务、填地址和密钥、选模型、改输出上限、思考力度、上下文窗口、限速、能不能看图和单价。
// 配置写进 $JADE_HOME/.env；用过的服务和模型记在 $JADE_HOME/models.json 里（saved.ts），可以直接切回去。
//
// 主菜单按服务分组列出全部模型，回车就切换；设置、单价、服务的名字、删除在 "Manage models…" 里。
// 新加的模型一律从默认设置开始，不沿用当前模型的。
//
// 从旧 jade 的 ui/configure.ts 移植。省掉了旧 jade 的"插件提供的模型服务"（新的 jade 还没有这种服务）。

import { readFile, rm, writeFile } from "node:fs/promises";
import { hasProvider, parseTokens } from "./config.ts";
import { contextWindow } from "./context.ts";
import { CURRENCIES, formatRates, formatRulePrices, formatWhen, parseRates, parseRulePrices, parseWhen, priceSummary, symbol, type Currency, type ModelPrice, type PriceRule } from "./price.ts";
import { EFFORTS, fallbacksFromEnv, isBuiltinKind, isOfficialAnthropic, jsonObject, KEY_KEY, listModels, MODEL_KEY, providerInfo, providerKind, rpmFromEnv, thinkingFromEnv, URL_KEY, visionFromEnv, type ProviderKind } from "./provider.ts";
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

/** JADE_FALLBACKS 设成了什么；没设或写错时 undefined */
function fallbacksSetting(env: Env): boolean | undefined {
  if (!env.JADE_FALLBACKS?.trim()) return undefined;
  try {
    return fallbacksFromEnv({ JADE_FALLBACKS: env.JADE_FALLBACKS });
  } catch {
    return undefined;
  }
}

function fallbacksHint(env: Env, baseURL: string | undefined): string {
  const v = fallbacksSetting(env);
  return v === undefined ? `${isOfficialAnthropic(baseURL) ? "on" : "off"} (default)` : v ? "on" : "off";
}

/** JADE_THINKING 设成了什么；没设或写错时 undefined */
function thinkingSetting(env: Env): boolean | undefined {
  if (!env.JADE_THINKING?.trim()) return undefined;
  try {
    return thinkingFromEnv({ JADE_THINKING: env.JADE_THINKING });
  } catch {
    return undefined;
  }
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

/** 分组的标题：用户起的名字，否则类型和主机名 */
const groupOf = (s: SavedService) => s.name ?? describeService(s);

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** 按名字排好的服务 */
const sortedServices = (services: SavedService[]) => [...services].sort((a, b) => byName(groupOf(a), groupOf(b)));

interface Entry {
  service: SavedService;
  model: SavedModel;
  current: boolean;
}

/**
 * 保存过的全部模型：服务按名字排，同一个服务的模型按名字排，顺序不随最近用过哪个变。
 * 当前的模型不在 models.json 里时（不是内置的服务）单独放在最前
 */
function allModels(services: SavedService[], currentId: string | undefined, currentModel: string | undefined, current: () => Entry): Entry[] {
  const list = sortedServices(services).flatMap((s) =>
    [...s.models].sort((a, b) => byName(a.name, b.name)).map((m) => ({ service: s, model: m, current: currentId !== undefined && serviceId(s.env) === currentId && m.name === currentModel })),
  );
  return list.some((e) => e.current) ? list : [current(), ...list];
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
    // 单价和服务的名字不在 .env 里：从原来那份带过来
    const price = old.flatMap((s) => s.models).find((m) => m.name === model)?.price;
    const name = old.find((s) => s.name)?.name;
    const service: SavedService = {
      ...(name ? { name } : {}),
      env: { ...pick(env, serviceKeys(kind)), JADE_PROVIDER: kind },
      models: [{ name: model, settings: pick(env, MODEL_SETTINGS), ...(price ? { price } : {}) }, ...models],
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
  function useSaved(s: SavedService, m: SavedModel, replacing?: string): Promise<boolean> {
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
    return applyConfig(updates, replacing);
  }

  /**
   * 换成服务 serviceEnv 上的 model。from 下保存过这个模型时带上它自己的设置；新的模型一律从默认设置开始
   * （思考力度、额外请求参数各服务写法不同，限速、上下文窗口跟着模型走，沿用别的模型的容易错），
   * 只问输出上限：Claude 以外的服务常常默认只给 4096 个输出 token，带思考的模型很容易用完。
   * replacing：换了密钥的那个服务原来的 id
   */
  async function useModel(serviceEnv: Env, kind: ProviderKind, model: string, from?: SavedService, replacing?: string): Promise<boolean> {
    const saved = from?.models.find((m) => m.name === model);
    if (from && saved) return useSaved({ ...from, env: { ...from.env, ...pick(serviceEnv, serviceKeys(kind)) } }, saved, replacing);
    const updates: Env = { ...pick(serviceEnv, serviceKeys(kind)), JADE_PROVIDER: kind, [MODEL_KEY[kind]]: model };
    for (const k of MODEL_SETTINGS) updates[k] = undefined;
    if (kind !== "anthropic" && ui.interactive) {
      const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: "32K" }, opts.signal);
      if (max === undefined || !tokensInput("Output limit", max)) return false;
      if (max) updates.JADE_MAX_TOKENS = max;
    }
    return applyConfig(updates, replacing);
  }

  /** 在当前的服务上换成 model（/model <name>，名字不是保存过的模型） */
  async function switchModel(model: string): Promise<boolean> {
    const env = opts.env();
    const kind = providerKind(env);
    if (!isBuiltinKind(kind)) {
      report(`JADE_PROVIDER must be one of ${PROVIDERS.map((p) => p.kind).join(", ")}; set the model in ${envFile}.`);
      return false;
    }
    const id = serviceId(env);
    return useModel(env, kind, model, (await savedServices()).find((s) => serviceId(s.env) === id));
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
          options: [...models.map((m) => ({ label: m, value: m, ...(m === current ? { current: true } : saved.includes(m) ? { hint: "saved" } : {}) })), { label: "Enter a name…", value: OTHER }, { label: "Back", value: BACK }],
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
        options: PROVIDERS.map((p) => ({ label: p.label, value: p.kind, hint: p.hint, ...(p.kind === current?.kind ? { current: true } : {}) })),
      },
      opts.signal,
    );
    if (!kindName || !isBuiltinKind(kindName)) return false;
    const kind: ProviderKind = kindName;
    const same = kind === current?.kind;

    let baseURL: string | undefined = env[URL_KEY[kind]];
    // Anthropic 也能改地址（代理、兼容服务）：留空用官方地址。不预填官方地址：预填了回车就会把它写进
    // ANTHROPIC_BASE_URL，和以前没写地址时保存的同一个服务对不上（找不到保存过的密钥，models.json 里多出一份）
    const fallback = kind === "openai" ? "https://api.openai.com/v1" : "";
    const placeholder = kind === "anthropic" ? "empty for https://api.anthropic.com (SDK adds /v1)" : "https://example.com/v1";
    const url = await ui.input({ title: "Base URL", initial: baseURL ?? fallback, placeholder }, opts.signal);
    if (url === undefined) return false;
    if (kind === "openai-compat" && !url) {
      report("A base URL is required.");
      return false;
    }
    baseURL = url || undefined;

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
    // 同一个地址只换了密钥：原来的服务下的模型（带着各自的设置和单价）归到新的密钥下
    const rekeyed = same && sameAddress(env) && currentId !== undefined && key !== env[KEY_KEY[kind]];
    const target = services.find((s) => serviceId(s.env) === serviceId(serviceEnv)) ?? (rekeyed ? services.find((s) => serviceId(s.env) === currentId) : undefined);
    const model = await chooseModel({ ...env, ...serviceEnv }, same ? current?.model : undefined, target?.models.map((m) => m.name));
    if (!model) return false;
    return useModel(serviceEnv, kind, model, target, rekeyed ? currentId : undefined);
  }

  /** 加一个模型：选一个保存过的服务（或者新的服务），再选模型。加好了（成了当前的模型）返回 true */
  async function addModel(): Promise<boolean> {
    const currentId = serviceId(opts.env());
    const services = sortedServices(await savedServices());
    const where = await ui.select(
      {
        title: "Add a model from",
        options: [
          ...services.map((s, i) => ({ label: groupOf(s), value: `service:${i}`, hint: `${s.name ? `${describeService(s)} · ` : ""}${s.models.length} saved`, ...(serviceId(s.env) === currentId ? { current: true } : {}) })),
          { label: "Another service…", value: "provider", hint: "a new base URL or API key" },
          { label: "Back", value: "back" },
        ],
      },
      opts.signal,
    );
    if (where === "provider") return configureProvider();
    const s = where?.startsWith("service:") ? services[Number(where.slice(8))] : undefined;
    if (!s) return false;
    const kind = providerKind(s.env);
    if (!isBuiltinKind(kind)) return false;
    const model = await chooseModel(s.env, undefined, s.models.map((m) => m.name));
    return model ? useModel(s.env, kind, model, s) : false;
  }

  /** 要配置设置的模型：title 和 kind 是显示和按服务取值用的，read 读这个模型现在的设置变量，update 写回改动 */
  interface SettingsTarget {
    title: string;
    kind: string;
    model: string;
    /** 服务地址：Claude 的服务端回退默认开不开看它 */
    baseURL: string | undefined;
    read(): Promise<Env>;
    update(settings: Env): Promise<boolean>;
    /** 单价只存在 models.json 里，当前的模型也一样 */
    readPrice(): Promise<ModelPrice | undefined>;
    writePrice(price: ModelPrice | undefined): Promise<boolean>;
  }

  /**
   * 某个模型的设置（输出上限、思考力度、上下文窗口、限速、能不能看图，Claude 还有服务端回退，openai-compat 还有额外请求参数）。
   * 改完一项回到这个菜单接着改（重新读一遍，显示的是改过的值）；Back 或 Esc 才离开
   */
  async function configureSettings(target: SettingsTarget) {
    const { title, kind, model, baseURL } = target;
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
            ...(kind === "anthropic" ? [{ label: "Server-side fallback", value: "fallbacks", hint: fallbacksHint(env, baseURL) }] : []),
            ...(kind === "anthropic" ? [{ label: "Send thinking settings", value: "thinking", hint: thinkingSetting(env) === false ? "off" : `on${env.JADE_THINKING ? "" : " (default)"}` }] : []),
            ...(kind === "openai-compat" ? [{ label: "Extra request body", value: "extra", hint: env.OPENAI_COMPAT_EXTRA_BODY ? shorten(env.OPENAI_COMPAT_EXTRA_BODY) : "none" }] : []),
            { label: "Price", value: "price", hint: priceSummary(await target.readPrice()) },
            { label: "Back", value: "back" },
          ],
        },
        opts.signal,
      );
      if (action === undefined || action === "back") return;
      if (action === "price") {
        await configurePrice(target);
        continue;
      }
      // 每一项里按 Esc 或者输入有误：什么都不改，回到这个菜单
      if (action === "max") {
        const max = await ui.input({ title: "Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)", initial: env.JADE_MAX_TOKENS ?? "32K" }, opts.signal);
        if (max !== undefined && tokensInput("Output limit", max)) await target.update({ JADE_MAX_TOKENS: max || undefined });
      } else if (action === "effort" && efforts) {
        const DEFAULT = "\0default";
        const effort = await ui.select(
          {
            title: "Reasoning effort",
            options: [...efforts.map((e) => ({ label: e, value: e, ...(e === env.JADE_EFFORT ? { current: true } : {}) })), { label: "Default", value: DEFAULT, hint: kind === "anthropic" ? "high" : "service default" }],
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
      } else if (action === "fallbacks" && kind === "anthropic") {
        const DEFAULT = "\0default";
        const current = fallbacksSetting(env);
        const choice = await ui.select(
          {
            title: "Retry with another model on the service side when Claude refuses for safety reasons?",
            options: [
              { label: "On", value: "on", hint: current === true ? "current" : "official API only; most relays reject it" },
              { label: "Off", value: "off", hint: current === false ? "current" : "the field is not sent" },
              { label: "Default", value: DEFAULT, hint: isOfficialAnthropic(baseURL) ? "on (official API)" : "off (not the official API)" },
            ],
          },
          opts.signal,
        );
        if (choice !== undefined) await target.update({ JADE_FALLBACKS: choice === DEFAULT ? undefined : choice });
      } else if (action === "thinking" && kind === "anthropic") {
        const current = thinkingSetting(env);
        const choice = await ui.select(
          {
            title: "Send thinking and effort settings with each request?",
            options: [
              { label: "On", value: "on", hint: current !== false ? "current" : "adaptive thinking, effort high unless set" },
              { label: "Off", value: "off", hint: current === false ? "current" : "for services that reject the thinking field; the model decides itself" },
            ],
          },
          opts.signal,
        );
        if (choice !== undefined) await target.update({ JADE_THINKING: choice === "on" ? undefined : choice });
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

  /**
   * 改 models.json 里服务 service 的那一份（在文件里现在的内容上改：菜单打开之后 models.json 可能被别的会话改过）。
   * 找不到这个服务时报告并返回 false
   */
  async function editSaved(service: SavedService, fn: (s: SavedService) => SavedService): Promise<boolean> {
    const id = serviceId(service.env);
    const all = await readSavedServices(modelsFile);
    const i = id === undefined ? -1 : all.findIndex((s) => serviceId(s.env) === id);
    if (i === -1) {
      report(`Not saved: ${describeService(service)} is no longer in ${modelsFile}.`);
      return false;
    }
    await writeSavedServices(modelsFile, [...all.slice(0, i), fn(all[i]!), ...all.slice(i + 1)]);
    return true;
  }

  /** 改 models.json 里服务 service 下的模型 name；文件里还没有这个模型时以 fallback 为底加上 */
  const editSavedModel = (service: SavedService, fallback: SavedModel, fn: (m: SavedModel) => SavedModel) =>
    editSaved(service, (s) => {
      const i = s.models.findIndex((m) => m.name === fallback.name);
      const next = fn(s.models[i] ?? fallback);
      return { ...s, models: i === -1 ? [next, ...s.models] : [...s.models.slice(0, i), next, ...s.models.slice(i + 1)] };
    });

  /** 把模型的设置写进 models.json 里那一个模型；.env 不变（当前用的还是原来的模型）。改回默认值的设置从 settings 里删掉 */
  async function writeSavedModel(service: SavedService, model: SavedModel, settings: Env): Promise<boolean> {
    const ok = await editSavedModel(service, model, (m) => {
      const merged: Env = { ...m.settings, ...pick(settings, MODEL_SETTINGS), ...blank(settings, MODEL_SETTINGS) };
      return { ...m, settings: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string> };
    });
    if (ok) report(`Settings for ${model.name} (${groupOf(service)}) saved to ${modelsFile}.`);
    return ok;
  }

  /** 把模型的单价写进 models.json；undefined 删掉 */
  async function writePrice(service: SavedService, model: SavedModel, price: ModelPrice | undefined): Promise<boolean> {
    const ok = await editSavedModel(service, model, ({ price: _old, ...m }) => (price ? { ...m, price } : m));
    if (ok) report(price ? `Price of ${model.name}: ${priceSummary(price)}.` : `Removed the price of ${model.name}.`);
    return ok;
  }

  /** 保存过的模型在 models.json 里现在的样子；找不到时用 fallback 那份 */
  async function savedModel(service: SavedService, fallback: SavedModel): Promise<SavedModel> {
    const id = serviceId(service.env);
    const mine = id === undefined ? undefined : (await readSavedServices(modelsFile)).find((s) => serviceId(s.env) === id);
    return mine?.models.find((m) => m.name === fallback.name) ?? fallback;
  }

  /** 规则的价格在菜单里的样子："50% of the base price"，或者 "in ¥0.5 · out ¥2" */
  function ruleHint(rule: PriceRule, currency: Currency): string {
    if (rule.scale !== undefined) return `${formatRulePrices(rule)} of the base price`;
    const s = symbol(currency);
    const names = { input: "in", output: "out", cacheRead: "cache read", cacheWrite: "cache write" } as const;
    return (Object.keys(names) as (keyof typeof names)[]).flatMap((k) => (rule[k] === undefined ? [] : [`${names[k]} ${s}${rule[k]}`])).join(" · ");
  }

  const WHEN_TITLE =
    "When it applies: times like 00:30-08:30 (may cross midnight; several like 09:00-12:00,14:00-18:00), days like mon-fri or sat,sun, dates like 2026-12-01..2026-12-31, and a time zone like UTC+8 or Asia/Shanghai (default: this computer's). Any of them, in any order";
  const RULE_PRICE_TITLE = 'Price at those times: a share of the base price like 50%, or input output [cache read] [cache write] per million tokens ("-" keeps the base price)';

  /** 问一条规则的时间和价格（编辑时预填 rule 的）；Esc 或写错时 undefined */
  async function askRule(rule?: PriceRule): Promise<PriceRule | undefined> {
    const whenText = await ui.input({ title: WHEN_TITLE, initial: rule ? formatWhen(rule) : "", placeholder: "00:30-08:30 UTC+8" }, opts.signal);
    if (whenText === undefined) return undefined;
    let when: PriceRule;
    try {
      when = parseWhen(whenText);
    } catch (err) {
      report(errorText(err));
      return undefined;
    }
    if (Object.keys(when).length === 0) {
      report("Write when the price applies, for example 00:30-08:30 or sat,sun.");
      return undefined;
    }
    const pricesText = await ui.input({ title: RULE_PRICE_TITLE, initial: rule ? formatRulePrices(rule) : "", placeholder: "50%" }, opts.signal);
    if (pricesText === undefined) return undefined;
    try {
      return { ...when, ...parseRulePrices(pricesText) };
    } catch (err) {
      report(errorText(err));
      return undefined;
    }
  }

  /**
   * 一个模型的单价：货币、基础价和按时间的规则（从上往下第一条符合的算数）。
   * 改完一项回到这个菜单；Back 或 Esc 离开
   */
  async function configurePrice(target: SettingsTarget) {
    while (true) {
      const p = await target.readPrice();
      const rules = p?.rules ?? [];
      const action = await ui.select(
        {
          title: `Price of ${target.title} per million tokens`,
          options: [
            { label: "Base price", value: "base", hint: p ? `${symbol(p.currency)} ${formatRates(p)} (input output cache-read cache-write)` : "not set" },
            ...(p ? [{ label: "Currency", value: "currency", hint: `${p.currency} (${symbol(p.currency)})` }] : []),
            ...rules.map((r, i) => ({ label: formatWhen(r), value: `rule:${i}`, hint: ruleHint(r, p!.currency), group: "Time-based prices (the first that matches applies)" })),
            ...(p ? [{ label: "Add a time-based price…", value: "add", hint: "off-peak, weekend or promotional prices" }] : []),
            ...(p ? [{ label: "Remove the price", value: "clear" }] : []),
            { label: "Back", value: "back" },
          ],
        },
        opts.signal,
      );
      if (action === undefined || action === "back") return;
      if (action === "base") {
        // 第一次填时先选货币
        const currency = p?.currency ?? (await chooseCurrency());
        if (!currency) continue;
        const text = await ui.input(
          {
            title: `Price per million tokens in ${currency}: input output [cache read] [cache write], e.g. 3 15 0.3 3.75 (cache prices default to the input price${p ? "; empty removes the price" : ""})`,
            initial: p ? formatRates(p) : "",
          },
          opts.signal,
        );
        if (text === undefined) continue;
        if (!text.trim()) {
          if (p) await target.writePrice(undefined);
          continue;
        }
        try {
          const r = parseRates(text, false);
          const { cacheRead: _r, cacheWrite: _w, ...rest } = p ?? { currency, input: 0, output: 0 };
          await target.writePrice({ ...rest, currency, input: r.input!, output: r.output!, ...(r.cacheRead !== undefined ? { cacheRead: r.cacheRead } : {}), ...(r.cacheWrite !== undefined ? { cacheWrite: r.cacheWrite } : {}) });
        } catch (err) {
          report(errorText(err));
        }
      } else if (action === "currency" && p) {
        const currency = await chooseCurrency(p.currency);
        if (currency && currency !== p.currency) await target.writePrice({ ...p, currency });
      } else if (action === "add" && p) {
        const rule = await askRule();
        if (rule) await target.writePrice({ ...p, rules: [...rules, rule] });
      } else if (action === "clear" && p) {
        await target.writePrice(undefined);
      } else if (action.startsWith("rule:") && p) {
        const i = Number(action.slice(5));
        const rule = rules[i];
        if (!rule) continue;
        const what = await ui.select(
          {
            title: `${formatWhen(rule)}: ${ruleHint(rule, p.currency)}`,
            options: [
              { label: "Edit…", value: "edit" },
              ...(i > 0 ? [{ label: "Move up", value: "up", hint: "rules higher up win" }] : []),
              { label: "Remove", value: "remove" },
              { label: "Back", value: "back" },
            ],
          },
          opts.signal,
        );
        const next = [...rules];
        if (what === "edit") {
          const edited = await askRule(rule);
          if (!edited) continue;
          next[i] = edited;
        } else if (what === "up") next.splice(i - 1, 2, rule, rules[i - 1]!);
        else if (what === "remove") next.splice(i, 1);
        else continue;
        const { rules: _old, ...rest } = p;
        await target.writePrice(next.length ? { ...rest, rules: next } : rest);
      }
    }
  }

  async function chooseCurrency(current?: Currency): Promise<Currency | undefined> {
    return ui.select(
      {
        title: "Currency of the prices",
        options: CURRENCIES.map((c) => ({ label: c, value: c, hint: symbol(c), ...(c === current ? { current: true } : {}) })),
      },
      opts.signal,
    );
  }

  /** 把保存过的模型从 models.json 里删掉；服务下没有模型了就连服务（和它的密钥）一起删掉 */
  async function forgetModel(service: SavedService, model: SavedModel): Promise<void> {
    const id = serviceId(service.env);
    if (!id) return;
    const rest = (await readSavedServices(modelsFile))
      .map((s) => (serviceId(s.env) === id ? { ...s, models: s.models.filter((m) => m.name !== model.name) } : s))
      .filter((s) => s.models.length > 0);
    await writeSavedServices(modelsFile, rest);
    report(`Removed ${model.name} (${groupOf(service)}).`);
  }

  /** 给服务起名字（/model 里按它分组）；空的回到默认的类型和主机名 */
  async function renameService(service: SavedService): Promise<void> {
    const text = await ui.input({ title: `Name for this service, e.g. DeepSeek (empty for ${describeService(service)})`, initial: service.name ?? "" }, opts.signal);
    if (text === undefined) return;
    const name = text.trim();
    if (await editSaved(service, ({ name: _old, ...s }) => (name ? { name, ...s } : s))) report(name ? `Renamed ${describeService(service)} to ${name}.` : `${describeService(service)} has no name now.`);
  }

  /** 主菜单和管理菜单里一个模型的选项：分组是它的服务 */
  function entryOption(e: Entry, value: string, env: Env) {
    const settings = e.current ? pick(env, MODEL_SETTINGS) : e.model.settings;
    const kind = providerKind(e.service.env);
    const parts = [settingsSummary(settings, kind, contextWindow(e.model.name, settings)), e.model.price ? priceSummary(e.model.price) : ""];
    return { label: e.model.name, value, hint: parts.filter(Boolean).join(" · "), group: groupOf(e.service), ...(e.current ? { current: true } : {}) };
  }

  /** 全部模型（当前的那个的设置以 .env 为准） */
  async function entries(): Promise<Entry[]> {
    const env = opts.env();
    const kind = providerKind(env);
    const info = providerInfo(env);
    return allModels(await savedServices(), serviceId(env), info.model, () => ({
      service: { env: isBuiltinKind(kind) ? { ...pick(env, serviceKeys(kind)), JADE_PROVIDER: kind } : { JADE_PROVIDER: kind }, models: [] },
      model: { name: info.model, settings: pick(env, MODEL_SETTINGS) },
      current: true,
    }));
  }

  /**
   * 管理菜单里选中一个模型后：设置（含单价）、服务的名字、删掉它。当前的模型不能删（删掉了下次进 /model 又会被记回来）。
   * 从设置里出来回到这个菜单；删除、Back 或 Esc 回到管理菜单
   */
  async function pickModelAction(e: Entry): Promise<void> {
    const kind = providerKind(e.service.env);
    // 当前的模型改 .env 就好——applyConfig 里的 remember 会把改完的 .env 写回 models.json；
    // 其他保存过的模型只改 models.json 里的那一个。单价都只在 models.json 里
    const read = e.current ? async () => pick(opts.env(), MODEL_SETTINGS) : async () => (await savedModel(e.service, e.model)).settings;
    const saved = serviceId(e.service.env) !== undefined && e.service.models.length > 0;
    while (true) {
      const settings = await read();
      const model = await savedModel(e.service, e.model);
      const service = (await savedServices()).find((s) => serviceId(s.env) === serviceId(e.service.env)) ?? e.service;
      const action = await ui.select(
        {
          title: `${e.model.name} (${groupOf(service)})`,
          options: [
            { label: "Settings…", value: "settings", hint: [settingsSummary(settings, kind, contextWindow(e.model.name, settings)), model.price ? priceSummary(model.price) : ""].filter(Boolean).join(" · ") },
            ...(saved ? [{ label: "Service name…", value: "rename", hint: service.name ?? `not set (${describeService(service)})` }] : []),
            ...(e.current ? [] : [{ label: "Remove", value: "forget" }]),
            { label: "Back", value: "back" },
          ],
        },
        opts.signal,
      );
      if (action === "settings") {
        await configureSettings({
          title: e.model.name,
          kind,
          model: e.model.name,
          baseURL: providerInfo(e.service.env).baseURL,
          read,
          update: (updates) => (e.current ? applyConfig(updates) : writeSavedModel(e.service, e.model, updates)),
          readPrice: async () => (saved ? (await savedModel(e.service, e.model)).price : undefined),
          writePrice: (price) => (saved ? writePrice(e.service, e.model, price) : (report(`${e.model.name} is not saved in ${modelsFile}, so it cannot have a price.`), Promise.resolve(false))),
        });
        continue;
      }
      if (action === "rename") {
        await renameService(service);
        continue;
      }
      if (action === "forget") await forgetModel(e.service, e.model);
      return;
    }
  }

  /** 管理菜单：和主菜单一样分组列出全部模型，选中一个改它的设置、单价、服务的名字或删掉它。Back 或 Esc 回到主菜单 */
  async function manageModels(): Promise<void> {
    while (true) {
      const env = opts.env();
      const list = await entries();
      const action = await ui.select(
        { title: "Manage models", options: [...list.map((e, i) => entryOption(e, `model:${i}`, env)), { label: "Back", value: "back" }] },
        opts.signal,
      );
      const e = action?.startsWith("model:") ? list[Number(action.slice(6))] : undefined;
      if (!e) return;
      await pickModelAction(e);
    }
  }

  async function configureModel(arg: string | undefined) {
    const env = opts.env();
    // 还没有配置模型：没有"当前的服务"可以换模型，先选服务
    if (!hasProvider(env)) return void (await configureProvider());
    // 之前只有 .env 时配置的模型也记下来，之后换了不会丢
    await remember().catch(() => {});
    if (arg) {
      // 保存过的模型按名字切换（当前服务的优先），否则换当前服务的模型
      const list = (await entries()).filter((e) => !e.current && e.model.name === arg);
      const saved = list.find((e) => serviceId(e.service.env) === serviceId(env)) ?? list[0];
      return void (await (saved ? useSaved(saved.service, saved.model) : switchModel(arg)));
    }
    // 主菜单：保存过的模型按服务分组全部列出，回车就切换到它（选当前的什么都不做），然后结束 /model。
    // 加模型、管理模型做完回到这里；每一轮都重读：配置之后模型和它的设置可能都变了
    while (true) {
      const env = opts.env();
      const list = await entries();
      const action = await ui.select(
        {
          title: "Switch model",
          options: [
            ...list.map((e, i) => entryOption(e, `model:${i}`, env)),
            { label: "Add a model…", value: "add", hint: "from a saved service or a new one" },
            { label: "Manage models…", value: "manage", hint: "settings, prices, service names, remove" },
          ],
        },
        opts.signal,
      );
      if (action === undefined) return; // Esc：整个 /model 结束
      if (action.startsWith("model:")) {
        const e = list[Number(action.slice(6))];
        if (e && !e.current) await useSaved(e.service, e.model);
        return;
      }
      if (action === "add" && (await addModel())) return;
      if (action === "manage") await manageModels();
    }
  }

  return { provider: configureProvider, model: configureModel };
}
