// jade/web：web_fetch、web_search 工具和 /search 命令。
//
// 搜索服务的 API key 在 shell 的环境变量或 $JADE_HOME/.env 里（和 jade/models 同一个文件），/search 写进这个文件。
// web_search 总是注册，但只在配置了搜索服务时发给模型（context.build 里去掉）：这样 /search 设置之后当前会话立即能用，
// 不用重开会话；会话的工具清单在创建时就定了。

import path from "node:path";
import { definePlugin, type ScopeContext, type UI } from "../../src/api.ts";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import type { Renderers } from "../renderers/index.ts";
import type { Task } from "../task/index.ts";
import { envWithFile, updateEnvFile, type Env } from "./env.ts";
import { webRenderers } from "./renderers.ts";
import { parseOrder, parseResults, SEARCH_PROVIDERS, webTools } from "./web.ts";

// 设了 NO_COLOR（非空）或标准输出不是终端时不输出颜色，见 https://no-color.org
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const dim = (s: string) => (colors ? `\x1b[2m${s}\x1b[22m` : s);
const green = (s: string) => (colors ? `\x1b[32m${s}\x1b[39m` : s);

/**
 * API key 所在的环境：每次开会话时重新读，/search 改了之后原地更新。模块每个进程只加载一次，进程级的命令和会话级的工具共用
 */
let keys: Env | undefined;
/** 撤销当前会话里"web_search 没打开"的提示词段落；/search 打开搜索后调用 */
let offNote: (() => void) | undefined;

const envFile = (ctx: ScopeContext) => path.join(ctx.home, ".env");

/** 配置项，旧 jade 的环境变量 JADE_SEARCH、JADE_SEARCH_RESULTS 仍然有效（配置项优先）；不合法时抛错 */
function settings(ctx: ScopeContext, env: Env): { order?: string[]; results: number } {
  const fromConfig = ctx.config.search !== undefined && ctx.config.search !== null;
  const order = parseOrder(fromConfig ? ctx.config.search : env.JADE_SEARCH, fromConfig ? "jade/web config search" : "JADE_SEARCH");
  const counted = ctx.config.results !== undefined && ctx.config.results !== null;
  const results = parseResults(counted ? ctx.config.results : env.JADE_SEARCH_RESULTS, counted ? "jade/web config results" : "JADE_SEARCH_RESULTS");
  return { ...(order ? { order } : {}), results };
}

export default definePlugin({
  process(ctx) {
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) for (const r of webRenderers) renderers.tool(r);

    ctx.service<Commands>("commands@1")?.register({
      name: "search",
      description: "set up web search services (TinyFish, AnySearch, Tavily, Exa, Firecrawl, Jina)",
      async run(_args, c) {
        const file = envFile(ctx);
        const env = (keys ??= await envWithFile(file));
        const on = SEARCH_PROVIDERS.filter((p) => env[p.env]);
        const name = await c.ui.select(
          {
            title: on.length ? `Web search is on (${on.map((p) => p.name).join(", ")}; tried in order, the next one takes over on failure)` : "Web search is off",
            options: SEARCH_PROVIDERS.map((p) => ({ label: `${p.name}${env[p.env] ? " ✓" : ""}`, value: p.name, hint: p.signup })),
          },
          c.signal,
        );
        const p = SEARCH_PROVIDERS.find((x) => x.name === name);
        if (!p) return;
        // shell 里的变量盖过文件：改文件只在这个会话里看起来生效，下一个会话又变回 shell 里的值
        if (process.env[p.env]) return `${p.env} is set in your shell environment, which takes precedence over ${file}; change or unset it there.`;
        if (env[p.env]) {
          const choice = await c.ui.select(
            {
              title: p.name,
              options: [
                { label: "Change the API key…", value: "set" as const },
                { label: "Remove", value: "off" as const, hint: `removes ${p.env} from ${file}` },
              ],
            },
            c.signal,
          );
          if (!choice) return;
          if (choice === "off") {
            await updateEnvFile(file, { [p.env]: undefined }, env);
            return dim(`${p.name} removed.${on.length > 1 ? "" : " Web search is off."}`);
          }
        }
        const key = (await c.ui.input({ title: `${p.name} API key`, mask: true }, c.signal))?.trim();
        if (!key) return;
        await updateEnvFile(file, { [p.env]: key }, env);
        offNote?.();
        offNote = undefined;
        return green(`Web search is on with ${p.name}: web_search uses it, and web_fetch falls back to it when a page cannot be fetched directly.`);
      },
    });
  },

  async session(ctx) {
    const env = (keys = await envWithFile(envFile(ctx)));
    let opts: { order?: string[]; results: number };
    try {
      opts = settings(ctx, env);
    } catch (e) {
      // 写错的配置不让 web_fetch 也用不了：搜索按默认设置
      ctx.service<UI>("ui@1")?.notify(`${(e as Error).message}; using the default search settings`, "warning");
      opts = { results: parseResults(undefined, "") };
    }
    // keys 换成新的对象（新会话、/search 之前）时也取当前的那个
    const web = webTools({ ...opts, env: () => keys ?? env });
    for (const tool of web.tools) ctx.kernel.tool(tool);

    // 子 Agent（jade/task）也能查网页：另一套实例；web_search 只在配置了搜索服务时给它。
    // web_fetch 带 url 参数，子 Agent 每次都要问用户（URL 能把读到的内容带出去）。
    // jade/task 被隔离时它的服务已失效：子 Agent 没有 web 工具，web 工具本身照常
    try {
      const task = ctx.service<Task>("task@1");
      if (task) {
        const sub = webTools({ ...opts, env: () => keys ?? env });
        for (const tool of sub.tools) task.tool(tool, tool.name === "web_search" ? { when: () => sub.search().length > 0 } : {});
      }
    } catch {}

    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      fn: (req) => (web.search().length ? req : { ...req, tools: req.tools.filter((t) => t.name !== "web_search") }),
    });
    // 没有搜索时告诉模型用户可以打开它；有搜索时不用说
    offNote = undefined;
    if (web.search().length === 0 && ctx.service<Commands>("commands@1")) {
      const remove = ctx.service<Prompts>("prompts@1")?.add({ text: "- web_search is off; if you need to search the web, the user can turn it on with /search." });
      if (remove) {
        offNote = remove;
        // 会话关闭时段落随作用域撤销，这里只忘掉它
        await ctx.effect(() => () => {
          if (offNote === remove) offNote = undefined;
        });
      }
    }
  },
});
