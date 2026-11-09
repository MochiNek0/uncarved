// jade/mcp：配置的 MCP 服务的工具交给模型（声明只读的也经 task@1 交给子 Agent）；/mcp 查看状态、重连，
// /mcp add、/mcp remove 改配置文件（见 install.ts；终端里是 jade mcp add|remove）。
//
// 服务是进程级的资源：第一个会话打开时读配置、确认项目层的服务、连接，之后各会话共用；进程退出时（进程作用域关闭）全部关掉。
// 一个会话里的工具列表不变（否则提示缓存失效）：第一个会话最多等 STARTUP_WAIT_MS，没连上的在后台接着连，
// 它们的工具从下一个会话（/clear）开始提供。不能交互时（-p）只有这一个会话，照常等到每个服务连上或超时。
// 服务进程退出后，下一次调用它的工具时重新连接一次。

import path from "node:path";
import { definePlugin, type Cli, type ProcessContext, type UI } from "../../src/api.ts";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import type { Task } from "../task/index.ts";
import { describeServer, loadMcpConfig, McpClient, mcpTools, mcpTrustHash } from "./mcp.ts";
import { manageMcp, manageUsage } from "./install.ts";
import { bold, clip, dim, display, estimateTokens, green, realPath, red, repoRoot, splitArgs, TrustFile, yellow } from "./project.ts";

const ID = "jade/mcp";
/** 第一个会话最多等 MCP 服务连接这么久（能交互时），没连上的在后台接着连 */
const STARTUP_WAIT_MS = 5000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 本进程的 MCP 服务 */
class Servers {
  clients: McpClient[] = [];
  readonly #ctx: ProcessContext;
  #started?: Promise<void>;
  #closing = false;

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
    const trust = new TrustFile(path.join(ctx.home, "trust.jsonl"));
    const { servers, warnings } = await loadMcpConfig({ home: ctx.home, root, cwd });
    for (const w of warnings) this.notify(`${ID}: ${w}`, "warning");
    const ui = this.ui();
    const connecting: Promise<unknown>[] = [];
    for (const entry of servers) {
      if (entry.config.disabled) continue;
      if (entry.layer === "project") {
        // 项目层的服务随仓库分发，启动它就是执行仓库指定的命令：第一次启动前（配置变了也算）请用户确认
        const hash = mcpTrustHash(root, entry);
        if (!(await trust.has(hash))) {
          const ok = ui?.interactive
            ? (await ui.select(
                {
                  title: `MCP server "${entry.name}" from ${display(cwd, entry.file)} is new or changed. Start it?`,
                  detail: `${entry.config.command !== undefined ? "runs" : "connects to"}: ${describeServer(entry.config)}`,
                  options: [
                    { label: "No", value: "no" },
                    { label: "Yes, start it", value: "yes" },
                  ],
                },
                ctx.signal,
              )) === "yes"
            : false;
          if (!ok) {
            this.notify(`[skipped] MCP server ${entry.name}: not confirmed${ui?.interactive ? "" : " (run jade interactively in this directory once to confirm it)"}`, "warning");
            continue;
          }
          await trust.add(hash, entry.file);
        }
      }
      const client = new McpClient(entry, {
        cwd,
        onDisconnect: (c, why) => this.notify(`MCP server ${c.name} disconnected: ${why}. jade reconnects on its next tool call; /mcp shows details`, "warning"),
      });
      this.clients.push(client);
      connecting.push(client.connect().catch((err) => this.notify(`MCP server ${client.name} is unavailable: ${errorText(err)}`, "warning")));
    }
    if (this.clients.length === 0) return;
    const all = Promise.all(connecting);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (ui?.interactive) await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, STARTUP_WAIT_MS)))]);
    else await all;
    clearTimeout(timer);
    for (const c of this.clients.filter((x) => x.status === "connecting")) {
      this.notify(`MCP server ${c.name} is still starting; its tools are available from the next session (/clear) once it is connected`);
      void c.connect().then(
        () => this.notify(`MCP server ${c.name} connected; its tools are available from the next session (/clear)`),
        () => {},
      );
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
  }
}

/** 服务在初始化时给出的使用说明，放进系统提示词。来自外部，标为不可信 */
function instructions(clients: McpClient[]): string[] {
  return clients
    .filter((c) => c.status === "connected" && c.instructions)
    .map((c) => `# Instructions from the MCP server "${c.name}" (about its mcp__${c.name}__* tools)

${c.instructions}`);
}

/** 一个服务每次请求都带着的大约多少 token：发给模型的工具定义，加上它的使用说明。没连上时为 0 */
function serverTokens(c: McpClient): number {
  const tools = mcpTools([c]).reduce((n, t) => n + estimateTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema })), 0);
  return tools + instructions([c]).reduce((n, text) => n + estimateTokens(text), 0);
}

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
          return red(errorText(e));
        }
        // 只改配置文件，不用先连接
        if (words[0] === "add" || words[0] === "remove" || words[0] === "rm") {
          try {
            return await manageMcp(words, { home: ctx.home, cwd: ctx.cwd, cmd: "/mcp" });
          } catch (e) {
            return red(errorText(e));
          }
        }
        await servers.start();
        const clients = servers.clients;
        if (words[0] === "reconnect") {
          const c = clients.find((x) => x.name === words[1]);
          if (!c) return red(`usage: /mcp reconnect <name>; servers: ${clients.map((x) => x.name).join(", ") || "(none)"}`);
          await c.close();
          try {
            await c.connect();
            return green(`${c.name} connected, ${c.tools.length} tools; new tools are available from the next session (/clear)`);
          } catch (err) {
            return red(`${c.name}: ${errorText(err)}`);
          }
        }
        if (words.length > 0) return red(`usage: /mcp [reconnect <name>]\n${manageUsage("/mcp")}`);
        if (clients.length === 0) {
          return dim(`(no MCP servers) add one with /mcp add, or configure them in ${display(ctx.cwd, path.join(ctx.home, "mcp.json"))}, .mcp.json or .jade/mcp.json`);
        }
        const lines: string[] = [];
        let total = 0;
        for (const c of clients) {
          const state = c.status === "connected" ? green("connected") : c.status === "failed" ? red("failed") : yellow(c.status);
          const info = c.serverInfo?.name ? ` · ${c.serverInfo.name}${c.serverInfo.version ? ` ${c.serverInfo.version}` : ""}` : "";
          const tokens = serverTokens(c);
          total += tokens;
          lines.push(`${bold(c.name)} ${state} ${dim(`${c.entry.layer} · ${display(ctx.cwd, c.entry.file)} · ${describeServer(c.entry.config)}${info}${tokens ? ` · ≈${tokens} tokens` : ""}`)}`);
          if (c.error) lines.push(red(`  ${c.error}`));
          if (c.tools.length) lines.push(`  tools  ${c.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? dim(" (read)") : ""}`).join(", ")}`);
          if (c.status === "failed" && c.stderr.length) lines.push(dim(c.stderr.map((l) => `  │ ${clip(l, 200)}`).join("\n")));
        }
        if (total) lines.push(dim(`≈${total} tokens in every request (tool definitions and server instructions); remove or disable servers you do not use to save them`));
        return lines.join("\n");
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
    for (const tool of mcpTools(servers.clients)) ctx.kernel.tool(tool);
    // 子 Agent（jade/task）只拿声明了只读（readOnlyHint）的工具：另一套实例，和 jade/fs 一样
    const task = ctx.service<Task>("task@1");
    if (task) for (const tool of mcpTools(servers.clients, { readOnly: true })) task.tool(tool);
    const prompts = ctx.service<Prompts>("prompts@1");
    for (const text of instructions(servers.clients)) prompts?.add({ text, untrusted: true });
  },
});
