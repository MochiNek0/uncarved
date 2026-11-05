// jade/models：按 $JADE_HOME/.env 和环境变量选模型服务（和旧 jade 的变量相同），外面包一层重试和限速。
// provider@1 给核心建会话用；models@1 给其他插件（压缩、子 Agent、提示词）调用模型、查看当前配置。

import path from "node:path";
import type { Delta, ModelRequest, ModelResponse, Provider } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import { envWithFile, hasProvider } from "./config.ts";
import { listModels, providerFromEnv, providerInfo, RateGate, rpmFromEnv, withRetry } from "./provider.ts";

/** models@1 */
export interface Models {
  /** 当前配置的服务和模型；没有配置时 undefined。via 是给人看的服务说明，例如 "the Anthropic API" */
  current(): { kind: string; model: string; via: string } | undefined;
  /** 用当前配置的模型完成一次请求（带重试和限速，和会话共用） */
  complete(request: ModelRequest, options: { signal: AbortSignal; onDelta?: (delta: Delta) => void }): Promise<ModelResponse>;
  /** 服务提供的模型列表；不支持或出错时为空 */
  list(): Promise<string[]>;
}

export default definePlugin({
  async process(ctx) {
    const envFile = path.join(ctx.home, ".env");
    const env = await envWithFile(envFile);
    const ui = ctx.service<UI>("ui@1");
    const configured = hasProvider(env);

    let made: Promise<Provider> | undefined;
    const provider = (): Promise<Provider> => {
      if (!configured) {
        return Promise.reject(
          new Error(
            `no model is configured. Put one of these in ${envFile} or set them in the shell:\n` +
              "  ANTHROPIC_API_KEY=...                                  (Claude)\n" +
              "  OPENAI_API_KEY=...                                     (OpenAI)\n" +
              "  OPENAI_COMPAT_BASE_URL=... and OPENAI_COMPAT_MODEL=... (an OpenAI-compatible service)",
          ),
        );
      }
      // 第一次用时才创建：配置写错时错误出现在这一轮里，而不是让插件激活失败、连会话都打不开
      if (made) return made;
      made = (async () => {
        const gate = new RateGate({ rpm: rpmFromEnv(env), onLearn: (rpm) => ui?.notify(`rate limited: spacing requests to ${rpm} per minute from now on`, "warning") });
        return withRetry(await providerFromEnv(env), {
          gate,
          onRetry: ({ attempt, retries, delayMs, error }) =>
            ui?.notify(`model request failed (${error.message}); retry ${attempt} of ${retries} in ${Math.round(delayMs / 1000)}s`, "warning"),
        });
      })();
      // 创建失败时下次重试（例如密钥刚写进 .env）
      made.catch(() => {
        made = undefined;
      });
      return made;
    };

    const complete: Models["complete"] = async (request, options) => (await provider()).complete(request, options);
    ctx.provide("provider@1", { id: "jade/models", complete } satisfies Provider);
    ctx.provide("models@1", {
      current() {
        if (!configured) return undefined;
        const info = providerInfo(env);
        return { kind: info.kind, model: info.model, via: via(info.kind, info.baseURL) };
      },
      complete,
      list: () => listModels(env),
    } satisfies Models);
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
