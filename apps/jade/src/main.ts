// jade 命令行入口：解析核心自己的参数，启动插件宿主，把控制权交给前端插件（3.4）。
// 核心自己只处理 jade plugins …、jade update、--safe、--version（以及把 jade remove x 这类漏了 plugins 的写法挡下来）；其余参数原样交给前端。

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { TrustOptions } from "uncarved";
import type { Frontend, UI } from "./api.ts";
import { PluginHost, type HostOptions } from "./host.ts";
import type { LayerRoot } from "./manifest.ts";
import { pluginsCommand } from "./rescue.ts";
import { FileTrustStore } from "./state.ts";
import { updateCli } from "./update.ts";

/** 连续两次 Ctrl+C 间隔不超过它时，核心直接退出（第 7 节） */
const DOUBLE_SIGINT_MS = 2000;

const USAGE = `usage: jade [--safe] [frontend options…]
       jade plugins [list | add <source> | update [id…] | remove <id> | enable <id> | disable <id>] [options]
       jade update [--check]   upgrade jade itself to the latest version on npm

  --safe        load only the plugins that come with jade
  -v, --version print the version

Run "jade plugins --help" for the install and update options.
Everything else is passed to the frontend plugin: "jade --help" shows the terminal interface's options,
"jade -p --help" the options for running one prompt.`;

/**
 * jade plugins 的子命令（含别名）：单独写在 jade 后面时多半是漏了 plugins。
 * update、upgrade 不在里面：jade update 升级 jade 本身，jade upgrade 多半也是想升级 jade
 */
const PLUGIN_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "ls", "add", "install", "remove", "rm", "uninstall", "enable", "disable"]);

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function version(): string {
  return JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "-v" || argv[0] === "--version") {
    console.log(version());
    return 0;
  }
  const cwd = process.cwd();
  const home = process.env.JADE_HOME || path.join(os.homedir(), ".jade");
  const roots: LayerRoot[] = [
    // 编译好的宿主（dist/*.js）用编译好的插件：Node 不给 node_modules 里的 .ts 去类型
    { layer: "bundled", root: path.join(pkgDir, import.meta.url.endsWith(".js") ? "plugins-dist" : "plugins") },
    { layer: "user", root: path.join(home, "plugins") },
    { layer: "project", root: path.join(cwd, ".jade", "plugins") },
  ];
  const safe = argv.includes("--safe");
  const rest = argv.filter((a) => a !== "--safe");
  const flags = rest.filter((a) => a.startsWith("-"));

  if (rest[0] === "plugins") {
    try {
      console.log(
        await pluginsCommand(rest.slice(1), {
          roots,
          home,
          flags,
          safe,
          trust: new FileTrustStore(path.join(home, "state", "trust.json")),
          log: (message) => console.error(`jade: ${message}`),
        }),
      );
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  // 不启动插件宿主：插件坏了也能升级 jade
  if (rest[0] === "update") return updateCli(rest.slice(1));
  if (rest[0] === "upgrade") {
    console.error(`jade: "upgrade" is not a jade command; did you mean "jade update"?\nTo send it to the model instead, type it inside jade.`);
    return 2;
  }
  if (rest[0] === "help") {
    console.log(USAGE);
    return 0;
  }
  // jade remove plugins x、jade add foo：前端会把它当成第一条消息发给模型（auto 模式下模型可能真去删东西）。
  // 带引号的消息（jade "add a test"）是一整个参数，不会和子命令名完全相同
  if (rest[0] !== undefined && PLUGIN_SUBCOMMANDS.has(rest[0])) {
    const args = rest.slice(1).filter((a) => a !== "plugins" && a !== "plugin");
    // 只有一个词时加引号还是同一个参数，只能进 jade 再输入
    const instead = rest.length > 1 ? `quote the whole message (jade "${rest.join(" ")}") or type it inside jade` : "type it inside jade";
    console.error(`jade: "${rest[0]}" is not a jade command; did you mean "${["jade plugins", rest[0], ...args].join(" ")}"?\nTo send it to the model instead, ${instead}.`);
    return 2;
  }

  // 前端起来之前，消息打到 stderr；之后交给 ui@1
  let host: PluginHost | undefined;
  const report = (message: string) => {
    try {
      const ui = host?.service<UI>("ui@1");
      if (ui) return ui.notify(message, "warning");
    } catch {
      // ui@1 的提供者坏了：退回 stderr
    }
    console.error(`jade: ${message}`);
  };
  const opts: HostOptions = {
    roots,
    home,
    cwd,
    flags,
    safe,
    config: { project: path.join(cwd, ".jade", "config.json") },
    report,
    ...(await trustOptions(home, roots)),
  };
  try {
    host = await PluginHost.start(opts);
  } catch (e) {
    // 例如手改坏了的 plugins.json：说清楚是哪个文件，不打一整段堆栈
    console.error(`jade: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const uninstall = host.installProcessHandlers();

  const ac = new AbortController();
  let lastSigint = 0;
  const onSigint = () => {
    const now = Date.now();
    if (now - lastSigint <= DOUBLE_SIGINT_MS) {
      // 不经过任何插件：插件出问题时用户一定能停下来
      host?.sessions.current?.abort(new Error("interrupted"));
      process.stderr.write("\njade: interrupted\n");
      process.exit(130);
    }
    lastSigint = now;
  };
  process.on("SIGINT", onSigint);

  let code = 1;
  try {
    const frontend = host.service<Frontend>("frontend@1");
    if (!frontend) {
      console.error(noFrontend(host, safe));
    } else {
      code = (await frontend.run({ argv: rest, sessions: host.sessions, signal: ac.signal })) ?? 0;
    }
  } catch (e) {
    console.error(`jade: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ac.abort();
    process.off("SIGINT", onSigint);
    await host.close();
    uninstall();
  }
  return code;
}

/** 没有前端时核心没有任何界面：打印出问题的插件，提示救援办法（3.2） */
function noFrontend(host: PluginHost, safe: boolean): string {
  const lines = ["jade: no frontend plugin could start."];
  for (const p of host.status()) {
    if (p.state === "active" || p.state === "disabled" || p.reason?.startsWith("frontend ")) continue;
    lines.push(`  ${p.id ?? p.dir} (${p.layer}): ${p.state}${p.reason ? `: ${p.reason}` : ""}`);
  }
  lines.push(safe ? "Run `jade plugins list` to see every plugin's state." : "Try `jade --safe`, or `jade plugins disable <id>` for the plugin that fails.");
  return lines.join("\n");
}

/**
 * 项目层插件的确认（第 7 节）：有带代码的项目层插件、且能在终端里问时才提供。
 * 确认记录存在 $JADE_HOME/state/trust.json，按插件目录内容的哈希，内容变了要重新确认
 */
async function trustOptions(home: string, roots: LayerRoot[]): Promise<{ trust?: TrustOptions }> {
  const project = roots.find((r) => r.layer === "project")!;
  if (!existsSync(project.root) || !process.stdin.isTTY || !process.stderr.isTTY) return {};
  const confirm: TrustOptions["confirm"] = async ({ path: dir, files }) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const shown = files.slice(0, 10).map((f) => `    ${f}`).join("\n") + (files.length > 10 ? `\n    … ${files.length - 10} more` : "");
      const answer = await rl.question(`jade: this project has a plugin at ${dir}:\n${shown}\nIt runs with your permissions. Load it? [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
  return { trust: { trust: new FileTrustStore(path.join(home, "state", "trust.json")), confirm } };
}

// 直接运行（bun src/main.ts）时；bin/jade.js 导入后自己调用 main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
