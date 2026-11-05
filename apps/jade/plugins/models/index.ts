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
import { envWithFile, hasProvider } from "./config.ts";
import { configurator } from "./configure.ts";
import { listModels, providerFromEnv, providerInfo, RateGate, rpmFromEnv, withRetry } from "./provider.ts";

/** models@1 */
export interface Models {
  /** 当前配置的服务和模型；没有配置时 undefined。via 是给人看的服务说明，例如 "the Anthropic API" */
  current(): { kind: string; model: string; via: string; /** 上下文窗口（token） */ contextWindow: number } | undefined;
  /** 用当前配置的模型完成一次请求（带重试和限速，和会话共用） */
  complete(request: ModelRequest, options: { signal: AbortSignal; onDelta?: (delta: import("uncarved").Delta) => void }): Promise<ModelResponse>;
  /** 服务提供的模型列表；不支持或出错时为空 */
  list(): Promise<string[]>;
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
    const build = (): Promise<Provider> => {
      // 用创建时的这份配置：之后换了配置，新的一份自己建 provider
      const snapshot = env;
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
      const p = build();
      made = p;
      // 创建失败时下次重试（例如密钥刚写进 .env）
      p.catch(() => {
        if (made === p) made = undefined;
      });
      return p;
    };

    const complete: Models["complete"] = (request, options) => provider().then((p) => p.complete(request, options));

    // 转发的 provider：会话创建时固定的是这个壳，/model 之后下一次请求就用新的配置
    ctx.provide("provider@1", { id: "jade/models", complete } satisfies Provider);

    ctx.provide("models@1", {
      current() {
        if (!hasProvider(env)) return undefined;
        const info = providerInfo(env);
        return { kind: info.kind, model: info.model, via: via(info.kind, info.baseURL), contextWindow: contextWindow(info.model, env) };
      },
      complete,
      list: () => listModels(env),
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
