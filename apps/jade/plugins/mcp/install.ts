// /mcp add|remove（终端里是 jade mcp add|remove）：往配置文件里加一个 MCP 服务或删掉它，不用手改 JSON。
//
// 不加 --project 写 $JADE_HOME/mcp.json，加了写 <工作目录>/.jade/mcp.json；文件里其他的内容原样保留。
// 这里只写配置，不启动服务：进程里的服务只在第一个会话打开时连接，新加的重启 jade 后生效。
// 项目层的服务照旧在第一次启动前请用户确认：命令不顺带记下确认。这个命令也有命令行的写法（jade mcp add），
// 模型能经 shell 跑它；如果加了就算确认，模型就能绕过确认。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkConfig, describeServer, type McpServerConfig } from "./mcp.ts";
import { display } from "./project.ts";

/** cmd 是 "/mcp" 或 "jade mcp" */
export const manageUsage = (cmd: string) => `usage: ${cmd} add <name> [--project] [--env KEY=VALUE]… [--force] [--] <command> [args…]
       ${cmd} add <name> --url <url> [--project] [--header "Name: value"]… [--force]
       ${cmd} remove <name> [--project]

  --project  write <cwd>/.jade/mcp.json instead of $JADE_HOME/mcp.json
  --env      an environment variable for a stdio server; values may use \${VAR}
  --header   an HTTP header for a --url server; values may use \${VAR}
  --force    replace a server with the same name
  Everything after <command> is passed to it unchanged, e.g. ${cmd} add fs npx -y @modelcontextprotocol/server-filesystem .`;

/** 不加 --project 写 $JADE_HOME/mcp.json，加了写 <工作目录>/.jade/mcp.json */
export const mcpConfigFile = (home: string, cwd: string, project: boolean) => (project ? path.join(cwd, ".jade", "mcp.json") : path.join(home, "mcp.json"));

/** add / remove，参数已经切好；返回给用户看的结果，用法错误或失败时抛错。cmd 用在提示里 */
export async function manageMcp(argv: readonly string[], env: { home: string; cwd: string; cmd: string }): Promise<string> {
  const usage = manageUsage(env.cmd);
  const [sub, ...tail] = argv;
  if (sub === "-h" || sub === "--help") return usage;
  if (sub === "add") {
    const { name, project, force, config } = parseAdd(tail, usage);
    const file = mcpConfigFile(env.home, env.cwd, project);
    await edit(file, (servers) => {
      if (servers[name] !== undefined && !force) throw new Error(`${display(env.cwd, file)} already has an MCP server named ${name}; add --force to replace it`);
      servers[name] = config;
    });
    return [
      `added MCP server ${name} to ${display(env.cwd, file)}: ${describeServer(config)}`,
      `restart jade to start it${project ? "; jade asks you to confirm it the first time" : ""}`,
    ].join("\n");
  }
  if (sub === "remove" || sub === "rm") {
    const project = tail.includes("--project");
    const rest = tail.filter((a) => a !== "--project");
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error(usage);
    const name = rest[0]!;
    const file = mcpConfigFile(env.home, env.cwd, project);
    await edit(file, (servers) => {
      if (servers[name] === undefined) throw new Error(`${display(env.cwd, file)} has no MCP server named ${name}`);
      delete servers[name];
    });
    return `removed MCP server ${name} from ${display(env.cwd, file)}; restart jade to stop it`;
  }
  throw new Error(usage);
}

function parseAdd(tail: readonly string[], usage: string): { name: string; project: boolean; force: boolean; config: McpServerConfig } {
  let name: string | undefined;
  let project = false;
  let force = false;
  let url: string | undefined;
  const envVars: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let command: string[] | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    const value = () => {
      const v = tail[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n${usage}`);
      return v;
    };
    if (a === "--") {
      command = tail.slice(i + 1);
      break;
    } else if (a === "--project") project = true;
    else if (a === "--force" || a === "-f") force = true;
    else if (a === "--url") url = value();
    else if (a === "--env" || a === "-e") {
      const v = value();
      const eq = v.indexOf("=");
      if (eq <= 0) throw new Error(`--env needs KEY=VALUE, got ${JSON.stringify(v)}`);
      envVars[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (a === "--header" || a === "-H") {
      const v = value();
      const colon = v.indexOf(":");
      if (colon <= 0) throw new Error(`--header needs "Name: value", got ${JSON.stringify(v)}`);
      headers[v.slice(0, colon).trim()] = v.slice(colon + 1).trim();
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${usage}`);
    else if (name === undefined) name = a;
    else {
      // 名字之后第一个不是选项的参数是服务的命令，后面的都原样交给它（npx -y … 里的 -y 不是 jade 的选项）
      command = tail.slice(i);
      break;
    }
  }
  if (name === undefined) throw new Error(usage);
  if (url !== undefined && command?.length) throw new Error(`give either --url or a command, not both\n${usage}`);
  if (url === undefined && !command?.length) throw new Error(`give a command or --url\n${usage}`);
  let config: McpServerConfig;
  if (url !== undefined) {
    // 含 ${VAR} 的地址要到读配置时才知道展开后是什么，那时再检查
    if (!/^https?:\/\//.test(url) && !url.includes("${")) throw new Error(`--url must start with http:// or https://`);
    if (Object.keys(envVars).length) throw new Error("--env is for servers started with a command; a --url server takes --header");
    config = { type: "http", url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    if (Object.keys(headers).length) throw new Error("--header is for --url servers; a command takes --env");
    const [cmd, ...args] = command!;
    config = { command: cmd!, ...(args.length ? { args } : {}), ...(Object.keys(envVars).length ? { env: envVars } : {}) };
  }
  const problem = checkConfig(name, config);
  if (problem) throw new Error(`MCP server ${JSON.stringify(name)}: ${problem}`);
  return { name, project, force, config };
}

/** 读配置文件、改 mcpServers、写回；文件坏了时报错，不覆盖 */
async function edit(file: string, change: (servers: Record<string, unknown>) => void): Promise<void> {
  let json: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // 还没有这个文件
  }
  if (text !== undefined && text.trim()) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}; fix it by hand first`);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${file}: expected { "mcpServers": { ... } }; fix it by hand first`);
  }
  const servers = (json.mcpServers ??= {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${file}: "mcpServers" is not an object; fix it by hand first`);
  change(servers);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(json, null, 2) + "\n");
}
