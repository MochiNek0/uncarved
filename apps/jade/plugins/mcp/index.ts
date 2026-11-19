// jade/mcp：配置的 MCP 服务的工具交给模型（子 Agent 是核心开的子会话，本插件在里面另有一份）；/mcp 查看状态、重连，
// /mcp add、/mcp remove 改配置文件（见 install.ts；终端里是 jade mcp add|remove），jade 运行时马上启动、停掉服务。
//
// 服务是进程级的资源：第一个会话打开时读配置、确认项目层的服务、连接，之后各会话共用；进程退出时（进程作用域关闭）全部关掉。
// 会话里的工具跟着服务变：连上、服务通知工具列表变了（notifications/tools/list_changed）、/mcp add|remove|reconnect 之后，
// 从下一轮起生效（核心在两轮之间按新的工具表重挂会话，不用 /clear；代价是下一次请求的提示缓存失效）。
// 能交互时会话不等连上过的服务：每个服务上次连上时的工具记在 $JADE_HOME/state/mcp-tools.json（McpToolCache），还在连接时
// 先按它们提供，调用时再等连上；第一次用的服务最多等 STARTUP_WAIT_MS，等不到的连上后工具从下一轮起有。不能交互时（-p）通常只有一轮，照常等到每个服务连上或超时。
// 服务进程退出后，下一次调用它的工具时重新连接一次。

import path from "node:path";
import { definePlugin, type Cli, type ProcessContext, type Text, type Tool, type Trust, type UI } from "@uncarved/jade-api";
import type { Commands, Prompts } from "@uncarved/jade-api/services";
import { describeServer, loadMcpConfig, McpClient, mcpCacheKey, McpToolCache, mcpTools, mcpTrustHash, type McpServerEntry } from "./mcp.ts";
import { manageMcp, manageUsage } from "./install.ts";
import { bold, clip, dim, display, error, estimateTokens, lines as joinLines, ok, realPath, repoRoot, splitArgs, warn, withLegacyTrust } from "./project.ts";

const ID = "jade/mcp";
/** 能交互时，第一次用（没有记下工具）的服务最多等这么久；没连上的连上后从下一轮起有工具 */
const STARTUP_WAIT_MS = 5000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 启动时算好的东西，加服务（/mcp add）时还要用 */
interface Setup {
  cwd: string;
  root: string;
  trust: Trust;
  cache: McpToolCache;
}

/** 本进程的 MCP 服务 */
class Servers {
  clients: McpClient[] = [];
  readonly #ctx: ProcessContext;
  #started?: Promise<void>;
  #setup?: Setup;
  #closing = false;
  /** 服务给的工具或说明变了时通知的会话 */
  #watchers = new Set<() => void>();

  constructor(ctx: ProcessContext) {
    this.#ctx = ctx;
  }

  /** 用到时才取：ui@1 的提供者可能排在后面激活（3.3） */
  ui(): UI | undefined {
    try {
      return this.#ctx.service<UI>("ui@1");
    } catch {
      return undefined;
    }
  }

  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.#closing) return;
    try {
      this.ui()?.notify(text, level);
    } catch {
      // 前端已经关了
    }
  }

  /** 工具或说明变了时调用 fn，返回取消 */
  watch(fn: () => void): () => void {
    this.#watchers.add(fn);
    return () => void this.#watchers.delete(fn);
  }

  #changed(): void {
    if (this.#closing) return;
    for (const fn of [...this.#watchers]) {
      try {
        fn();
      } catch {
        // 一个会话同步失败不影响别的
      }
    }
  }

  /** 第一次调用时读配置、确认、连接；之后等同一次。失败时关掉已经建的连接，下次调用重来，免得一次失败让 MCP 一直用不了 */
  start(): Promise<void> {
    this.#started ??= this.#start().catch(async (e: unknown) => {
      await Promise.all(this.clients.splice(0).map((c) => c.close().catch(() => {})));
      this.#started = undefined;
      throw e;
    });
    return this.#started;
  }

  async #start(): Promise<void> {
    const ctx = this.#ctx;
    const cwd = realPath(ctx.cwd);
    const root = realPath(repoRoot(cwd));
    const setup: Setup = { cwd, root, trust: withLegacyTrust(ctx.require<Trust>("trust@1"), ctx.home), cache: new McpToolCache(ctx.home) };
    const [{ servers, warnings }] = await Promise.all([loadMcpConfig({ home: ctx.home, root, cwd }), setup.cache.load()]);
    this.#setup = setup;
    for (const w of warnings) this.notify(`${ID}: ${w}`, "warning");
    const connecting: Promise<unknown>[] = [];
    for (const entry of servers) {
      const added = await this.#add(entry, setup);
      // 能交互时，记下过工具的服务不等：先按上次的工具提供
      if (added && !(this.ui()?.interactive && added.client.known)) connecting.push(added.done);
    }
    // 不能交互时通常只有一轮，等到每个服务连上或超时。能交互时第一次用的服务最多等 STARTUP_WAIT_MS：
    // 等不到就先开始，它连上后工具从下一轮起有（pi 在第一条消息前等最多 10 秒，dsh 一直等）
    if (!this.ui()?.interactive) return void (await Promise.all(connecting));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(connecting), new Promise<void>((resolve) => (timer = setTimeout(resolve, STARTUP_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** 确认（项目层）、建连接、在后台连接；done 是连接的结果（不会 reject）。跳过时返回 undefined */
  async #add(entry: McpServerEntry, setup: Setup): Promise<{ client: McpClient; done: Promise<void> } | undefined> {
    if (entry.config.disabled) return undefined;
    const ui = this.ui();
    if (entry.layer === "project") {
      // 项目层的服务随仓库分发，启动它就是执行仓库指定的命令：第一次启动前（配置变了也算）请用户确认
      const hash = mcpTrustHash(setup.root, entry);
      if (!(await setup.trust.has(hash))) {
        const ok = ui?.interactive
          ? (await ui.select(
              {
                title: `MCP server "${entry.name}" from ${display(setup.cwd, entry.file)} is new or changed. Start it?`,
                detail: `${entry.config.command !== undefined ? "runs" : "connects to"}: ${describeServer(entry.config)}`,
                options: [
                  { label: "No", value: "no" },
                  { label: "Yes, start it", value: "yes" },
                ],
              },
              this.#ctx.signal,
            )) === "yes"
          : false;
        if (!ok) {
          this.notify(`[skipped] MCP server ${entry.name}: not confirmed${ui?.interactive ? "" : " (run jade interactively in this directory once to confirm it)"}`, "warning");
          return undefined;
        }
        await setup.trust.add(hash, entry.file);
      }
    }
    const client = new McpClient(entry, {
      cwd: setup.cwd,
      onDisconnect: (c, why) => this.notify(`MCP server ${c.name} disconnected: ${why}. jade reconnects on its next tool call; /mcp shows details`, "warning"),
      // 连上、重新列出工具之后：记进缓存，会话跟着增减工具
      // 工具没变也记：刷新时间，常用的服务不会因为工具一直没变被当作久没连上而清掉
      onTools: (c) => {
        const now = { tools: c.tools, ...(c.instructions ? { instructions: c.instructions } : {}) };
        void setup.cache.put(entry, now);
        c.known = now;
        this.#changed();
      },
      // 连不上（包括调用工具时的重连）：上次的工具不再提供
      onFailed: () => this.#changed(),
    });
    client.known = setup.cache.get(entry);
    this.clients.push(client);
    const done = client.connect().catch((err) => {
      this.notify(`MCP server ${client.name} is unavailable: ${errorText(err)}`, "warning");
    });
    // 包一层：async 函数直接返回 Promise 会被等到它完成
    return { client, done };
  }

  /**
   * 配置改了（/mcp add、/mcp remove）：去掉的服务关掉，新的（或改了的）启动。还没启动过时什么都不做，第一次启动会读新配置
   */
  async reload(): Promise<void> {
    if (!this.#started) return;
    await this.#started.catch(() => {});
    const setup = this.#setup;
    if (!setup) return;
    const { servers, warnings } = await loadMcpConfig({ home: this.#ctx.home, root: setup.root, cwd: setup.cwd });
    for (const w of warnings) this.notify(`${ID}: ${w}`, "warning");
    const wanted = new Set(servers.filter((e) => !e.config.disabled).map(mcpCacheKey));
    const gone = this.clients.filter((c) => !wanted.has(mcpCacheKey(c.entry)));
    this.clients = this.clients.filter((c) => !gone.includes(c));
    await Promise.all(gone.map((c) => c.close().catch(() => {})));
    const have = new Set(this.clients.map((c) => mcpCacheKey(c.entry)));
    for (const entry of servers) if (!have.has(mcpCacheKey(entry))) await this.#add(entry, setup);
    this.#changed();
  }

  /** 服务的工具变了（例如重连之后）：会话跟着增减 */
  touch(): void {
    this.#changed();
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
  }
}

/** 服务在初始化时给出的使用说明，放进系统提示词。来自外部，标为不可信 */
function instructions(c: McpClient): string | undefined {
  const text = c.offeredInstructions();
  return text
    ? `# Instructions from the MCP server "${c.name}" (about its mcp__${c.name}__* tools)

${text}`
    : undefined;
}

/** 一个服务每次请求都带着的大约多少 token：发给模型的工具定义，加上它的使用说明。没连上时为 0 */
function serverTokens(c: McpClient): number {
  const tools = mcpTools([c]).reduce((n, t) => n + estimateTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })), 0);
  return tools + estimateTokens(instructions(c) ?? "");
}

/** 连接对象的编号：服务重新加进来（/mcp add --force）后是新的连接，旧工具要换掉 */
const serial = new WeakMap<McpClient, number>();
let nextSerial = 1;
const serialOf = (c: McpClient) => serial.get(c) ?? (serial.set(c, nextSerial), nextSerial++);

/** 工具交给模型的样子；变了就要重新注册 */
const toolKey = (c: McpClient, t: Tool) => JSON.stringify([serialOf(c), t.description, t.inputSchema, t.effect, t.concurrency, t.idempotent]);

/** 当前进程的服务；process() 里创建，session() 里用 */
let current: Servers | undefined;

export default definePlugin({
  async process(ctx) {
    const servers = new Servers(ctx);
    current = servers;
    // 后台资源：进程作用域关闭时关掉所有服务（服务本身到第一个会话打开时才启动）
    await ctx.effect(() => () => servers.close());

    ctx.service<Commands>("commands@1")?.register({
      name: "mcp",
      args: "[reconnect <name> | add <name> … | remove <name>] [--project]",
      description: "MCP servers: status and tools; add or remove one",
      instant: true,
      async run(args) {
        let words: string[];
        try {
          words = splitArgs(args);
        } catch (e) {
          return error(errorText(e));
        }
        if (words[0] === "add" || words[0] === "remove" || words[0] === "rm") {
          let done: string;
          try {
            done = await manageMcp(words, { home: ctx.home, cwd: ctx.cwd, cmd: "/mcp", live: true });
          } catch (e) {
            return error(errorText(e));
          }
          try {
            await servers.reload();
          } catch (e) {
            return [done, "\n", error(`could not apply the change now: ${errorText(e)}; restart jade to apply it`)];
          }
          return done;
        }
        await servers.start();
        const clients = servers.clients;
        if (words[0] === "reconnect") {
          const c = clients.find((x) => x.name === words[1]);
          if (!c) return error(`usage: /mcp reconnect <name>; servers: ${clients.map((x) => x.name).join(", ") || "(none)"}`);
          await c.close();
          try {
            await c.connect();
            return ok(`${c.name} connected, ${c.tools.length} tools; changes to its tools apply from the next turn`);
          } catch (err) {
            servers.touch();
            return error(`${c.name}: ${errorText(err)}`);
          }
        }
        if (words.length > 0) return error(`usage: /mcp [reconnect <name>]\n${manageUsage("/mcp")}`);
        if (clients.length === 0) {
          return dim(`(no MCP servers) add one with /mcp add, or configure them in ${display(ctx.cwd, path.join(ctx.home, "mcp.json"))}, .mcp.json or .jade/mcp.json`);
        }
        const lines: Text[] = [];
        let total = 0;
        for (const c of clients) {
          const state = c.status === "connected" ? ok("connected") : c.status === "failed" ? error("failed") : warn(c.status);
          const info = c.serverInfo?.name ? ` · ${c.serverInfo.name}${c.serverInfo.version ? ` ${c.serverInfo.version}` : ""}` : "";
          const tokens = serverTokens(c);
          total += tokens;
          lines.push([bold(c.name), " ", state, " ", dim(`${c.entry.layer} · ${display(ctx.cwd, c.entry.file)} · ${describeServer(c.entry.config)}${info}${tokens ? ` · ≈${tokens} tokens` : ""}`)]);
          if (c.error) lines.push(error(`  ${c.error}`));
          const tools = c.offered();
          if (c.status === "connecting" && tools.length) lines.push(dim("  (tools from the last time jade connected; calls wait for the server)"));
          if (tools.length) lines.push(["  tools  ", tools.flatMap((t, k) => [...(k ? [", "] : []), t.name, ...(t.annotations?.readOnlyHint ? [dim(" (read)")] : [])])]);
          if (c.status === "failed" && c.stderr.length) lines.push(dim(c.stderr.map((l) => `  │ ${clip(l, 200)}`).join("\n")));
        }
        if (total) lines.push(dim(`≈${total} tokens in every request (tool definitions and server instructions); remove or disable servers you do not use to save them`));
        return joinLines(lines);
      },
    });
    // 终端里加、删服务：jade mcp add|remove …（cli@1，核心提供）。查看状态要连接服务，只在 /mcp 里有
    ctx.service<Cli>("cli@1")?.register({
      name: "mcp",
      run: (argv) => manageMcp(argv, { home: ctx.home, cwd: ctx.cwd, cmd: "jade mcp" }),
    });
  },

  async session(ctx) {
    const servers = current;
    if (!servers) return;
    await servers.start();
    const prompts = ctx.service<Prompts>("prompts@1");
    // 这个会话里注册了的工具、加了的说明；服务变了就按现在的增减（session() 之后注册的从下一轮起生效）
    const tools = new Map<string, { key: string; off: () => void }>();
    const notes = new Map<McpClient, { text: string; off: () => void }>();
    const refused = new Set<string>();
    const sync = () => {
      const want = new Map<string, { key: string; tool: Tool }>();
      for (const c of servers.clients) for (const t of mcpTools([c])) if (!want.has(t.name)) want.set(t.name, { key: toolKey(c, t), tool: t });
      for (const [name, r] of tools) {
        if (want.get(name)?.key === r.key) continue;
        r.off();
        tools.delete(name);
      }
      for (const [name, w] of want) {
        if (tools.has(name)) continue;
        try {
          tools.set(name, { key: w.key, off: ctx.kernel.tool(w.tool) });
        } catch (e) {
          // 和别的插件的工具重名之类：说一次
          if (!refused.has(name)) ctx.report(`tool ${name}: ${errorText(e)}`);
          refused.add(name);
        }
      }
      if (!prompts) return;
      for (const [c, n] of notes) {
        if (servers.clients.includes(c) && instructions(c) === n.text) continue;
        n.off();
        notes.delete(c);
      }
      for (const c of servers.clients) {
        const text = instructions(c);
        if (text && !notes.has(c)) notes.set(c, { text, off: prompts.add({ text, untrusted: true }) });
      }
    };
    sync();
    const unwatch = servers.watch(sync);
    await ctx.effect(() => unwatch);
  },
});
