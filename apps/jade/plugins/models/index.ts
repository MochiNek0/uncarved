// jade/models：按 $JADE_HOME/.env 和环境变量选模型服务（和旧 jade 的变量相同），外面包一层重试和限速。
// provider@1 给核心建会话用；models@1 给其他插件（压缩、子 Agent、提示词）调用模型、查看当前配置。
//
// /model 改了配置之后不用重开会话：provider@1 给核心的是一个转发到当前 provider 的壳（设计第 10 节），
// 下一次请求就用新的。

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ModelRequest, ModelResponse, Provider } from "uncarved";
import { definePlugin, type Notice, type UI, type Updater } from "@uncarved/jade-api";
import type { Commands, Models } from "@uncarved/jade-api/services";
import { contextWindow } from "./context.ts";
import { envWithFile, hasProvider, parseTokens } from "./config.ts";
import { configurator } from "./configure.ts";
import { isBuiltinKind, KEY_KEY, listModels, MODEL_KEY, providerFromEnv, providerInfo, providerKind, RateGate, rpmFromEnv, visionFromEnv, withRetry, type RetriedResponse, type RetryingProvider, type RetryOptions } from "./provider.ts";
import { priceAt } from "./price.ts";
import { MODEL_SETTINGS, parseSavedServices, readSavedServices, type Env, type SavedService } from "./saved.ts";

/** 进程级的配置交给会话里的提示用：有没有配好模型、有没有 /model、.env 在哪 */
let setup: { configured(): boolean; command: boolean; envFile: string } | undefined;
/** 没配模型的提示一个进程只说一次 */
let hinted = false;
/** 重试前、限速排队的等待在状态栏上倒计时：会话 id → 开始倒计时。等待发生在进程级的 provider 里，靠请求上 ext["jade/models"] 的会话 id 找到会话 */
const countdowns = new Map<string, (ms: number, label: string) => void>();
/** 请求上记的会话 id（见 session() 里的 model.before） */
const sessionOf = (request: ModelRequest) => (request.ext?.["jade/models"] as { session?: string } | undefined)?.session;
type RetryInfo = Parameters<NonNullable<RetryOptions["onRetry"]>>[0];
/** 重试前在会话里怎么显示：会话 id → 显示这一次重试。找不到会话的（子会话、-p）直接 notify */
const retryShows = new Map<string, (info: RetryInfo) => void>();
/** 重试的提示；next 是接下来做什么（"retrying in 5s"） */
const retryText = ({ attempt, retries, error }: RetryInfo, next: string) => `model request failed (${error.message}); ${next} (retry ${attempt}, at most ${retries})`;

export default definePlugin({
  async process(ctx) {
    const envFile = path.join(ctx.home, ".env");
    const modelsFile = path.join(ctx.home, "models.json");
    // 当前的模型配置。改配置时整份换掉（updateEnvFile 改的是这一份，apply 再从文件读一遍）
    let env = await envWithFile(envFile);
    hinted = false;
    setup = { configured: () => hasProvider(env), command: false, envFile };
    // 用的时候再取：jade/tui 也依赖这个插件（models@1），它在这之后才激活，这里取到的是 undefined，重试的提示就没人显示
    const ui = () => ctx.service<UI>("ui@1");
    /** 模型请求的 User-Agent：jade 和版本号，有的服务（例如基元律动的 clientApp）按它在用量里区分客户端 */
    const userAgent = () => {
      const version = ctx.service<Updater>("update@1")?.version;
      return version ? `jade/${version}` : "jade";
    };
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

    let made: Promise<RetryingProvider> | undefined;
    // 用创建时的这份配置：之后换了配置，新的一份自己建 provider
    const build = (snapshot: Env): Promise<RetryingProvider> => {
      return (async () => {
        const gate = new RateGate({ rpm: rpmFromEnv(snapshot), onLearn: (rpm) => ui()?.notify(`rate limited: spacing requests to ${rpm} per minute from now on`, "warning") });
        return withRetry(await providerFromEnv(snapshot, { "user-agent": userAgent() }), {
          gate,
          onWait: ({ delayMs, request }) => countdowns.get(sessionOf(request) ?? "")?.(delayMs, "rate limited, sending in"),
          onRetry: (info) => {
            const show = retryShows.get(sessionOf(info.request) ?? "");
            if (show) show(info);
            else ui()?.notify(retryText(info, `retrying in ${Math.round(info.delayMs / 1000)}s`), "warning");
          },
        });
      })();
    };

    // 第一次用时才创建：配置写错时错误出现在这一轮里，而不是让插件激活失败、连会话都打不开
    const provider = (): Promise<RetryingProvider> => {
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
    const savedProviders = new Map<string, Promise<RetryingProvider>>();
    const cachedBuild = (snapshot: Env): Promise<RetryingProvider> => {
      const key = JSON.stringify(snapshot);
      const cached = savedProviders.get(key);
      if (cached) return cached;
      const p = build(snapshot);
      savedProviders.set(key, p);
      // 创建失败时下次重试
      p.catch(() => savedProviders.delete(key));
      return p;
    };
    const saved = async (name: string): Promise<RetryingProvider> => {
      for (const s of await readSavedServices(modelsFile)) {
        const m = s.models.find((x) => x.name === name);
        const kind = providerKind(s.env);
        if (!m || !isBuiltinKind(kind)) continue;
        return cachedBuild({ ...s.env, ...m.settings, JADE_PROVIDER: kind, [MODEL_KEY[kind]]: m.name });
      }
      if (!hasProvider(env)) throw notConfigured();
      // 只写在 .env 里、没保存过的当前模型
      if (providerInfo(env).model === name) return provider();
      // 当前服务上的另一个模型（没保存过）：用这个服务的地址和密钥，不带当前模型自己的设置，用服务的默认值
      const kind = providerKind(env);
      if (!isBuiltinKind(kind)) throw new Error(`model ${JSON.stringify(name)} is not one of the models saved by /model (${modelsFile})`);
      const snapshot: Env = { ...env, JADE_PROVIDER: kind, [MODEL_KEY[kind]]: name };
      for (const k of MODEL_SETTINGS) delete snapshot[k];
      return cachedBuild(snapshot);
    };

    // models.json 里填的单价：jade/cost 每个回复都要查，是同步的，按文件的修改时间缓存（别的会话、手改文件也看得到）
    let priced: { mtime: number; services: SavedService[] } | undefined;
    const savedNow = (): SavedService[] => {
      let mtime: number;
      try {
        mtime = statSync(modelsFile).mtimeMs;
      } catch {
        return [];
      }
      if (priced?.mtime !== mtime) priced = { mtime, services: parseSavedServices(readFileSync(modelsFile, "utf8")) };
      return priced.services;
    };
    const price: NonNullable<Models["price"]> = (name, at) => {
      const services = savedNow();
      // 当前服务上的同名模型优先（不同服务上同一个模型可以不同价）
      const here = hasProvider(env) ? services.find((s) => isBuiltinKind(providerKind(s.env)) && sameService(s.env, env)) : undefined;
      const m = [...(here ? [here] : []), ...services].flatMap((s) => s.models).find((x) => x.name === name && x.price);
      return m?.price ? priceAt(m.price, at) : undefined;
    };

    const current: RetryingProvider["complete"] = (request, options) => provider().then((p) => p.complete(request, options));
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
      price,
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

    const commands = ctx.service<Commands>("commands@1");
    setup.command = commands !== undefined;
    commands?.register({
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

  session(ctx) {
    const ui = ctx.service<UI>("ui@1");
    // 还没配模型：告诉用户怎么配。/model 当场就能配好，不用重启；没有这条命令时只能改文件
    if (setup && !setup.configured() && !hinted && ui?.interactive) {
      hinted = true;
      const file = `put ANTHROPIC_API_KEY=... (or OPENAI_API_KEY=...) in ${setup.envFile}, then restart jade`;
      ui.notify(setup.command ? `No model is configured yet. Type /model to set one up, or ${file}.` : `No model is configured yet. To set one up, ${file}.`, "warning");
    }
    // 回复被输出上限截断：上限是这里的配置（JADE_MAX_TOKENS），只有这里知道怎么改
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "turn.ended" && (e.data as { reason?: string }).reason === "max_tokens" && setup?.command) {
          ui?.notify("if replies keep getting cut off, raise the output limit with /model", "info");
        }
      },
    });
    // 限速排队时（还有前端不能改写提示时的重试前）状态栏倒计时，不然几十秒里只看到"在请求"，像卡住了。子会话没有状态栏，不用做
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopCountdown = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      ctx.status?.(undefined);
    };
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch {
        // 前端不在了
      }
    };
    // 一个请求接连重试时只用一条提示（前端能原地改写时）：倒计时、第几次重试都改在这一条上，
    // 请求有了结果就停在结果上。之后的请求再重试是新的一条
    let retry: { notice: Notice; info: RetryInfo; timer?: ReturnType<typeof setInterval> } | undefined;
    const endRetry = (outcome: string, level: "info" | "warning") => {
      const r = retry;
      if (!r) return;
      retry = undefined;
      clearInterval(r.timer);
      safe(() => r.notice.update(`model request failed (${r.info.error.message}); ${outcome}`, level));
    };
    if (ctx.status) {
      const id = ctx.session.id;
      const countdown = (ms: number, label: string) => {
        stopCountdown();
        const until = Date.now() + ms;
        const tick = () => {
          const left = Math.ceil((until - Date.now()) / 1000);
          if (left <= 0) return stopCountdown();
          ctx.status?.({ text: `${label} ${left}s`, tone: "warn" });
        };
        timer = setInterval(tick, 1000);
        tick();
      };
      countdowns.set(id, countdown);
      retryShows.set(id, (info) => {
        const until = Date.now() + info.delayMs;
        const text = () => {
          const left = Math.ceil((until - Date.now()) / 1000);
          return retryText(info, left > 0 ? `retrying in ${left}s` : "retrying now");
        };
        let r = retry;
        if (r) {
          clearInterval(r.timer);
          r.info = info;
          const shown = r;
          safe(() => shown.notice.update(text(), "warning"));
        } else {
          const notice = ui?.notice?.(text(), "warning");
          // 前端不能改写：每次重试一条提示，倒计时放在状态栏上
          if (!notice) {
            ui?.notify(text(), "warning");
            return countdown(info.delayMs, "retrying in");
          }
          r = retry = { notice, info };
        }
        const shown = r;
        shown.timer = setInterval(() => {
          if (Date.now() >= until) clearInterval(shown.timer);
          safe(() => shown.notice.update(text(), "warning"));
        }, 1000);
      });
      ctx.signal.addEventListener("abort", () => {
        stopCountdown();
        clearInterval(retry?.timer);
        countdowns.delete(id);
        retryShows.delete(id);
      });
      // ext[provider id] 由那个 provider 解释（4.7），这里的 provider 就是 jade/models，别的 provider 不看
      ctx.kernel.hook({
        kind: "transform",
        point: "model.before",
        fn: (req) => ({ ...req, ext: { ...req.ext, "jade/models": { session: id } } }),
      });
      // 中断或失败时等待也就不算数了
      ctx.kernel.hook({
        kind: "observe",
        point: "event",
        fn: (e) => {
          if (e.type !== "turn.ended") return;
          stopCountdown();
          // 没等到成功这一轮就结束了（中断、重试次数用完）：倒计时不再算数
          endRetry("stopped retrying", "warning");
        },
      });
    }
    // 重试过的请求：把每次失败写进会话日志，事后能查到为什么慢、为什么重新输出（插件事件，不进上下文）
    ctx.kernel.hook({
      kind: "observe",
      point: "model.after",
      fn: async (res, hook) => {
        stopCountdown();
        const retries = (res as RetriedResponse).retries;
        if (!retries?.length) return;
        // 重试中的提示只说了"在重试"，成功了也要说一声，不然看起来像重试到一半没了
        const waited = Math.round(retries.reduce((ms, r) => ms + r.delayMs, 0) / 1000);
        const after = `${retries.length} ${retries.length === 1 ? "retry" : "retries"} (${waited}s of waiting)`;
        if (retry) endRetry(`succeeded after ${after}`, "info");
        else ui?.notify(`model request succeeded after ${after}`, "info");
        await hook.emit("retried", { retries });
      },
    });
  },
});

/** 两份配置是不是同一个服务：类型、地址、密钥都相同 */
function sameService(a: Env, b: Env): boolean {
  try {
    const x = providerInfo(a);
    const y = providerInfo(b);
    const kind = providerKind(a);
    return isBuiltinKind(kind) && x.kind === y.kind && (x.baseURL ?? "") === (y.baseURL ?? "") && a[KEY_KEY[kind]] === b[KEY_KEY[kind]];
  } catch {
    return false;
  }
}

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
