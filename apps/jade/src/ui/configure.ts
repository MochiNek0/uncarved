// /model：选服务、填地址和密钥、选模型、改输出上限、思考力度和上下文窗口。配置写进 $JADE_HOME/.env。

import { hasProvider, updateEnvFile } from "../config.ts";
import { EFFORTS, listModels, providerInfo, type ProviderKind } from "../provider.ts";
import { shortPath } from "./render.ts";
import { green, red, type Screen } from "./screen.ts";

export interface ConfigureOptions {
  screen: Screen;
  envFile: string;
  /** 按新的环境变量换上 provider、更新上下文窗口；配置不完整时抛出 */
  apply(): void;
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function configurator(opts: ConfigureOptions): Configure {
  const { screen, envFile } = opts;

  /** 保存配置并换上新的 provider；失败时报告原因，旧的 provider 继续用 */
  async function applyConfig(updates: Record<string, string | undefined>): Promise<boolean> {
    await updateEnvFile(envFile, updates);
    try {
      opts.apply();
    } catch (err) {
      screen.log(red(`Saved to ${shortPath(envFile)}, but the configuration is incomplete: ${errorText(err)}`));
      return false;
    }
    const info = providerInfo();
    opts.onApplied();
    screen.log(green(`Model: ${info.model} (${info.kind}${info.baseURL ? `, ${info.baseURL}` : ""}). Saved to ${shortPath(envFile)}.`));
    return true;
  }

  /** 选模型：服务能列出模型时从列表里选，否则手动输入 */
  async function chooseModel(env: Record<string, string | undefined>, current: string | undefined): Promise<string | undefined> {
    const models = await listModels(env);
    if (models.length > 0) {
      const OTHER = "\0other";
      const picked = await screen.select(
        "Choose a model",
        [
          ...models.map((m) => ({ label: m, value: m, hint: m === current ? "current" : undefined })),
          { label: "Enter a name…", value: OTHER },
        ],
      );
      if (picked !== OTHER) return picked;
    }
    return (await screen.input("Model name", { initial: current })) || undefined;
  }

  async function configureProvider(): Promise<boolean> {
    const current = hasProvider() ? providerInfo() : undefined;
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

    const hasKey = Boolean(process.env[KEY_KEY[kind]]);
    const key = await screen.input("API key", { mask: true, placeholder: hasKey ? "leave empty to keep the current key" : "" });
    if (key === undefined) return false;

    const env = { ...process.env, JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, ...(key ? { [KEY_KEY[kind]]: key } : {}) };
    const model = await chooseModel(env, same ? current?.model : undefined);
    if (!model) return false;

    const updates: Record<string, string | undefined> = { JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, [MODEL_KEY[kind]]: model };
    if (key) updates[KEY_KEY[kind]] = key;
    // 其他服务常常默认只给 4096 个输出 token，带思考的模型很容易用完
    if (kind !== "anthropic" && !process.env.JADE_MAX_TOKENS) {
      const max = await screen.input("Output limit per reply in tokens (empty for the service default)", { initial: "32000" });
      if (max) updates.JADE_MAX_TOKENS = max;
    }
    return applyConfig(updates);
  }

  async function configureModel(arg: string | undefined) {
    const info = providerInfo();
    if (arg) return void (await applyConfig({ [MODEL_KEY[info.kind]]: arg }));
    const efforts = EFFORTS[info.kind];
    const action = await screen.select(`Model: ${info.model} (${info.kind})`, [
      { label: "Switch model", value: "model" as const, hint: `current: ${info.model}` },
      { label: "Change service, base URL or API key", value: "provider" as const, hint: info.baseURL },
      { label: "Output limit per reply", value: "max" as const, hint: process.env.JADE_MAX_TOKENS ? `${process.env.JADE_MAX_TOKENS} tokens` : "service default" },
      ...(efforts
        ? [{ label: "Reasoning effort", value: "effort" as const, hint: process.env.JADE_EFFORT ?? (info.kind === "anthropic" ? "high (default)" : "service default") }]
        : []),
      {
        label: "Context window",
        value: "window" as const,
        hint: `${opts.contextWindow()} tokens${process.env.JADE_CONTEXT_WINDOW ? "" : " (default)"}`,
      },
    ]);
    if (action === "model") {
      const model = await chooseModel(process.env, info.model);
      if (model) await applyConfig({ [MODEL_KEY[info.kind]]: model });
    } else if (action === "provider") await configureProvider();
    else if (action === "max") {
      const max = await screen.input("Output limit per reply in tokens (empty for the service default)", { initial: process.env.JADE_MAX_TOKENS ?? "32000" });
      if (max !== undefined) await applyConfig({ JADE_MAX_TOKENS: max || undefined });
    } else if (action === "effort" && efforts) {
      const DEFAULT = "\0default";
      const effort = await screen.select("Reasoning effort", [
        ...efforts.map((e) => ({ label: e, value: e, hint: e === process.env.JADE_EFFORT ? "current" : undefined })),
        { label: "Default", value: DEFAULT, hint: info.kind === "anthropic" ? "high" : "service default" },
      ]);
      if (effort !== undefined) await applyConfig({ JADE_EFFORT: effort === DEFAULT ? undefined : effort });
    } else if (action === "window") {
      const n = await screen.input("Context window in tokens (empty for the default 256000)", { initial: process.env.JADE_CONTEXT_WINDOW ?? "" });
      if (n !== undefined) await applyConfig({ JADE_CONTEXT_WINDOW: n || undefined });
    }
  }

  return { provider: configureProvider, model: configureModel };
}
