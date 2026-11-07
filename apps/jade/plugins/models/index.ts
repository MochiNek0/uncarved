// jade/models：按 $JADE_HOME/.env 和环境变量选模型服务（和旧 jade 的变量相同），外面包一层重试和限速。
// provider@1 给核心建会话用；models@1 给其他插件（压缩、子 Agent、提示词）调用模型、查看当前配置。
//
// /model 改了配置之后不用重开会话：provider@1 给核心的是一个转发到当前 provider 的壳（设计第 10 节），
// 下一次请求就用新的。

import path from "node:path";
import type { ModelRequest, ModelResponse, Provider } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Commands } from "../commands/index.ts";
import { contextWindow } from "./context.ts";
import { envWithFile, hasProvider, parseTokens } from "./config.ts";
import { configurator } from "./configure.ts";
import { isBuiltinKind, listModels, MODEL_KEY, providerFromEnv, providerInfo, providerKind, RateGate, rpmFromEnv, visionFromEnv, withRetry } from "./provider.ts";
import { readSavedServices, type Env } from "./saved.ts";

/** models@1 */
export interface Models {
  /** 当前配置的服务和模型；没有配置时 undefined。via 是给人看的服务说明，例如 "the Anthropic API" */
  current(): {
    kind: string;
    model: string;
    via: string;
    /** 上下文窗口（token） */
    contextWindow: number;
    /** 模型能不能看图片（JADE_VISION；不设时按服务推断） */
    vision: boolean;
    /** 每次回复的输出上限（JADE_MAX_TOKENS，含 .env 里的）；不设或写错时没有，用服务的默认值 */
    maxTokens?: number;
  } | undefined;
  /**
   * 完成一次请求，带重试和限速。默认用当前配置的模型（限速和会话共用）；
   * model 是 /model 保存过的模型名（$JADE_HOME/models.json），用它和它自己的设置，找不到时报错
   */
  complete(request: ModelRequest, options: { signal: AbortSignal; onDelta?: (delta: import("uncarved").Delta) => void; model?: string }): Promise<ModelResponse>;
  /** 服务提供的模型列表；不支持或出错时为空 */
  list(): Promise<string[]>;
  /** /model 保存过的模型名（complete 的 model 能用的那些），最近用过的在前 */
  saved?(): Promise<string[]>;
  /** 配置换了（/model）时调用，返回取消订阅。前端用它更新状态栏 */
  subscribe?(fn: () => void): () => void;
}

export default definePlugin({
  async process(ctx) {
    const envFile = path.join(ctx.home, ".env");
    const modelsFile = path.join(ctx.home, "models.json");
    // 当前的模型配置。改配置时整份换掉（updateEnvFile 改的是这一份，apply 再从文件读一遍）
    let env = await envWithFile(envFile);
    const ui = ctx.service<UI>("ui@1");
    const watchers = new Set<() => void>();
    const notify = () => {
      for (const fn of watchers) {
        try {
          fn();
        } catch {
          // 订阅者的错不连累模型配置
        }
      }
    };

    const notConfigured = () =>
      new Error(
        `no model is configured. Run /model in a session, or put one of these in ${envFile} or the shell:\n` +
          "  ANTHROPIC_API_KEY=...                                  (Claude)\n" +
          "  OPENAI_API_KEY=...                                     (OpenAI)\n" +
          "  OPENAI_COMPAT_BASE_URL=... and OPENAI_COMPAT_MODEL=... (an OpenAI-compatible service)",
      );

    let made: Promise<Provider> | undefined;
    // 用创建时的这份配置：之后换了配置，新的一份自己建 provider
    const build = (snapshot: Env): Promise<Provider> => {
      return (async () => {
        const gate = new RateGate({ rpm: rpmFromEnv(snapshot), onLearn: (rpm) => ui?.notify(`rate limited: spacing requests to ${rpm} per minute from now on`, "warning") });
        return withRetry(await providerFromEnv(snapshot), {
          gate,
          onRetry: ({ attempt, retries, delayMs, error }) =>
            ui?.notify(`model request failed (${error.message}); retry ${attempt} of ${retries} in ${Math.round(delayMs / 1000)}s`, "warning"),
        });
      })();
    };

    // 第一次用时才创建：配置写错时错误出现在这一轮里，而不是让插件激活失败、连会话都打不开
    const provider = (): Promise<Provider> => {
      if (!hasProvider(env)) return Promise.reject(notConfigured());
      if (made) return made;
      const p = build(env);
      made = p;
      // 创建失败时下次重试（例如密钥刚写进 .env）
      p.catch(() => {
        if (made === p) made = undefined;
      });
      return p;
    };

    /** 保存过的模型的 provider，按配置缓存：models.json 里的密钥或设置改了就另建一份 */
    const savedProviders = new Map<string, Promise<Provider>>();
    const saved = async (name: string): Promise<Provider> => {
      for (const s of await readSavedServices(modelsFile)) {
        const m = s.models.find((x) => x.name === name);
        const kind = providerKind(s.env);
        if (!m || !isBuiltinKind(kind)) continue;
        const snapshot: Env = { ...s.env, ...m.settings, JADE_PROVIDER: kind, [MODEL_KEY[kind]]: m.name };
        const key = JSON.stringify(snapshot);
        const cached = savedProviders.get(key);
        if (cached) return cached;
        const p = build(snapshot);
        savedProviders.set(key, p);
        // 创建失败时下次重试
        p.catch(() => savedProviders.delete(key));
        return p;
      }
      // 只写在 .env 里、没保存过的当前模型
      if (hasProvider(env) && providerInfo(env).model === name) return provider();
      throw new Error(`model ${JSON.stringify(name)} is not one of the models saved by /model (${modelsFile})`);
    };

    const current: Provider["complete"] = (request, options) => provider().then((p) => p.complete(request, options));
    const complete: Models["complete"] = (request, { model, ...options }) => (model ? saved(model).then((p) => p.complete(request, options)) : current(request, options));

    // 转发的 provider：会话创建时固定的是这个壳，/model 之后下一次请求就用新的配置
    ctx.provide("provider@1", { id: "jade/models", complete: current } satisfies Provider);

    ctx.provide("models@1", {
      current() {
        if (!hasProvider(env)) return undefined;
        const info = providerInfo(env);
        let vision = true;
        try {
          vision = visionFromEnv(env);
        } catch {
          // 写错的 JADE_VISION 在创建 provider 时报错，这里当作不能看
          vision = false;
        }
        let maxTokens: number | undefined;
        try {
          maxTokens = env.JADE_MAX_TOKENS ? parseTokens("JADE_MAX_TOKENS", env.JADE_MAX_TOKENS) : undefined;
        } catch {
          // 写错的在创建 provider 时报错
        }
        return {
          kind: info.kind,
          model: info.model,
          via: via(info.kind, info.baseURL),
          contextWindow: contextWindow(info.model, env),
          vision,
          ...(maxTokens === undefined ? {} : { maxTokens }),
        };
      },
      complete,
      list: () => listModels(env),
      async saved() {
        const names = (await readSavedServices(modelsFile)).flatMap((s) => (isBuiltinKind(providerKind(s.env)) ? s.models.map((m) => m.name) : []));
        return [...new Set(names)];
      },
      subscribe(fn: () => void) {
        watchers.add(fn);
        return () => void watchers.delete(fn);
      },
    } satisfies Models);

    /** /model 写完配置之后：重新读 .env、换掉 provider；配置不完整时抛出，旧的配置和 provider 继续用 */
    const apply = async () => {
      const next = await envWithFile(envFile);
      const before = { env, provider: made };
      env = next;
      made = undefined;
      try {
        await provider();
      } catch (e) {
        env = before.env;
        made = before.provider;
        throw e;
      }
      notify();
    };

    ctx.service<Commands>("commands@1")?.register({
      name: "model",
      args: "[name]",
      description: "switch models, or add one with its provider, API key and limits",
      // 只改配置，不碰会话：模型工作时也立即执行
      instant: true,
      async run(args, c) {
        const configure = configurator({
          envFile,
          modelsFile,
          env: () => env,
          apply,
          report: (text) => c.print(text),
          ui: c.ui,
          signal: c.signal,
        });
        await configure.model(args.trim() || undefined);
      },
    });
  },
});

function via(kind: string, baseURL: string | undefined): string {
  const host = baseURL ? safeHost(baseURL) : undefined;
  if (kind === "anthropic") return host && host !== "api.anthropic.com" ? `the Anthropic API at ${host}` : "the Anthropic API";
  if (kind === "openai") return host && host !== "api.openai.com" ? `the OpenAI Responses API at ${host}` : "the OpenAI API";
  return host ? `an OpenAI-compatible API at ${host}` : `the ${kind} provider`;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
