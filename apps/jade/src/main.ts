#!/usr/bin/env -S bun --no-env-file
// jade：基于 uncarved 内核的编程 Agent 命令行宿主。
//
// 宿主负责内核不管的事：配置目录、会话索引、项目层插件的确认、审批界面、渲染、中断。
// 不读当前目录的 .env（见 config.ts）：模型配置放在 $JADE_HOME/.env。
// 交互运行时用终端界面（ui/tui.tsx），-p 和非交互运行时逐行输出（ui/screen.ts）。

import { mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { JsonlLogStore, JsonlTrustStore } from "@uncarved/store-jsonl";
import {
  readAll,
  Runtime,
  RuntimeBusy,
  UntrustedPlugin,
  type Block,
  type Plugin,
  type Provider,
  type UserInput,
} from "uncarved";
import { realpathSync } from "node:fs";
import { expandCommand, loadCommands } from "./commands.ts";
import { discoverPlugins, loadPlugin, resolvePlugins, type LoadedPlugin, type PluginBundle, type SessionControl } from "./plugins/loader.ts";
import { readPluginSettings } from "./plugins/install.ts";
import { PLUGIN_HELP, pluginCli, UsageError } from "./plugin-cli.ts";
import { describeServer, loadMcpConfig, McpClient, mcpTrustHash } from "./mcp.ts";
import { loadSkills } from "./skills.ts";
import { hasProvider, loadEnvFile, parseTokens, updateEnvFile } from "./config.ts";
import { collectProviders, createJade, type Jade } from "./distro.ts";
import { firstAnswer } from "./respond.ts";
import { describeRule, MODES, POLICY_KEY, type AllowRule, type Mode, type PolicySettings } from "./plugins/policy.ts";
import { compactThreshold, contextWindowFromEnv, contextWindowInfo, isContextOverflow } from "./context.ts";
import { InputHistory } from "./history.ts";
import { attachMentions, mentionCandidates } from "./mentions.ts";
import { repoRoot } from "./plugins/prompts.ts";
import { isBuiltinKind, isRateLimit, pluginProvider, providerFromEnv, providerInfo, providerKind, RateGate, registerProviders, rpmFromEnv, switchable, withRetry } from "./provider.ts";
import { ago, discardIfEmpty, matchSession, SessionIndex } from "./sessions.ts";
import { display } from "./tools/fs.ts";
import type { ApproveSubagent, SubagentApproval } from "./tools/task.ts";
import type { Question } from "./tools/ask.ts";
import type { Check } from "./plugins/checks.ts";
import { bold, dim, green, plainScreen, red, safeScreen, yellow, type CommandInfo, type Screen } from "./ui/screen.ts";
import { configurator } from "./ui/configure.ts";
import { reviewer } from "./plugins/review.ts";
import { clip, shortPath } from "./ui/render.ts";
import { transcript } from "./ui/transcript.ts";
import { run, VERSION } from "./sys.ts";
import { autoUpdate, autoUpdateEnabled, detectInstall, newerVersion, updateCli } from "./update.ts";

const HELP = `Usage: jade [options] [prompt]
       jade plugin <list|add|update|remove|enable|disable>   (jade plugin --help)
       jade update [--check]   upgrade jade to the latest version on npm

  -p, --print <prompt>   run one prompt and exit
  -c, --continue         continue the most recent session in this directory
  -r, --resume [id]      resume a session by id, or pick one from a list
  -m, --mode <mode>      permission mode for this run: ${MODES.join(" | ")} (default: the last mode you switched to, or ask)
      --cwd <dir>        working directory (default: current directory)
  -v, --version
  -h, --help

Type / in the session for commands; /model configures the model.
Model settings are read from $JADE_HOME/.env, and data lives in $JADE_HOME (default ~/.jade).
Instructions are read from AGENTS.md (or CLAUDE.md) in $JADE_HOME and from the repository root down to the working directory.`;

/** 会话里的命令：/help、输入 / 时的菜单都从这里取 */
const COMMANDS: CommandInfo[] = [
  { name: "help", about: "list the commands and keys" },
  { name: "model", args: "[name]", about: "switch between saved models, or add one and configure its provider, API key and output limit" },
  { name: "mode", args: `[${MODES.join("|")}]`, about: "show or change the permission mode" },
  { name: "plugins", about: "built-in and installed plugins: their tools, hooks and commands, and the hook execution order" },
  { name: "exit", about: "quit (the session stays resumable)" },
];
/** 运行中也立即执行的命令（不碰运行时，或者只读；/mode 运行中先记在 pendingMode） */
const INSTANT = new Set(["help", "model", "mode", "plugins", "exit"]);
/** 内置插件提供的命令（/memory 在 jade/memory 里，等等）：名字保留给它们，自定义命令不能占用 */
const BUILTIN_PLUGIN_COMMANDS = ["memory", "checks", "mcp", "skills", "compact", "clear", "resume", "retry", "undo", "search"];

const KEYS = `Keys: enter send · \\ or alt+enter new line · ↑↓ history · @ reference a file · esc interrupt (twice to also clear queued messages) · shift+tab cycle ask/auto/plan · ctrl+c twice to exit
      mouse wheel or PgUp/PgDn scroll the conversation · ctrl+home/ctrl+end jump to the top/bottom · click ▸ expands an item (ctrl+o the latest one) · click in the input moves the cursor · shift+drag selects text
While jade is working you can keep typing: messages are queued and sent when the current turn ends.`;

/** 终端界面启动时最多等 MCP 服务连接这么久，没连上的在后台接着连 */
const MCP_STARTUP_WAIT_MS = 5000;

/** 回复被输出上限截断后，自动让模型接着做的次数（每条用户消息） */
const MAX_CONTINUES = 3;
const CONTINUE_NOTE =
  "Your previous reply was cut off because it reached the output token limit. Continue from where you stopped. " +
  "If you were writing a large file or edit, split it into several smaller write_file/edit_file calls.";

// ---------- 参数 ----------

const argv = process.argv.slice(2);
if (argv[0] === "plugin" || argv[0] === "plugins") {
  const home = process.env.JADE_HOME ?? path.join(os.homedir(), ".jade");
  const here = process.cwd();
  try {
    const root = realPath(await repoRoot(here));
    process.exit(await pluginCli(argv.slice(1), { home, cwd: here, root, trust: new JsonlTrustStore(path.join(home, "trust.jsonl")) }));
  } catch (err) {
    console.error(`jade plugin: ${err instanceof Error ? err.message : String(err)}${err instanceof UsageError ? `\n\n${PLUGIN_HELP}` : ""}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
if (argv[0] === "update") process.exit(await updateCli(argv.slice(1)));
const opts: { print?: string; cont?: boolean; resume?: string; mode?: Mode; cwd?: string; prompt: string[] } = { prompt: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const value = () => {
    const v = argv[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-v" || a === "--version") {
    console.log(VERSION);
    process.exit(0);
  } else if (a === "-p" || a === "--print") opts.print = value();
  else if (a === "-c" || a === "--continue") opts.cont = true;
  // 不带 id 时从列表里选
  else if (a === "-r" || a === "--resume") opts.resume = argv[i + 1] === undefined || argv[i + 1]!.startsWith("-") ? "" : argv[++i]!;
  else if (a === "-m" || a === "--mode") {
    const m = value();
    if (!(MODES as readonly string[]).includes(m)) fail(`unknown mode ${m}`);
    opts.mode = m as Mode;
  } else if (a === "--cwd") opts.cwd = value();
  else if (a.startsWith("-")) fail(`unknown option ${a}`);
  else opts.prompt.push(a);
}

function fail(msg: string): never {
  console.error(`jade: ${msg}\n\n${HELP}`);
  process.exit(2);
}

/** 解析符号链接和 Windows 短文件名，和 git 给出的仓库根目录可以比较 */
function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function gitBranch(dir: string): Promise<string | undefined> {
  try {
    const { code, stdout } = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    return code === 0 ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------- 配置与界面 ----------

const cwd = path.resolve(opts.cwd ?? process.cwd());
if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) fail(`${cwd} is not a directory`);
const home = process.env.JADE_HOME ?? path.join(os.homedir(), ".jade");
const envFile = path.join(home, ".env");
await loadEnvFile(envFile);

/** 新会话的权限模式：-m 只管这一次；没给时用上次在会话里切换到的模式（JADE_MODE，见 rememberMode），都没有时是 ask */
const savedMode = process.env.JADE_MODE?.trim();
const badSavedMode = savedMode && !(MODES as readonly string[]).includes(savedMode) ? savedMode : undefined;
if (savedMode && !badSavedMode) opts.mode ??= savedMode as Mode;

const tui = Boolean(process.stdin.isTTY && process.stdout.isTTY) && opts.print === undefined;
// 终端界面依赖 ink 和 react，加载要几百毫秒，只在真的用到时才导入；现在就开始加载，和下面读配置、跑 git 同时进行
const tuiModule = tui ? import("./ui/tui.tsx") : undefined;
const branchFound = tui ? gitBranch(cwd) : undefined;
// provider 要动态导入 SDK（一百多毫秒），和终端界面一起加载；出错时在下面创建界面之后再报。
// JADE_PROVIDER 选的是插件提供的服务时，等插件加载完再创建（pluginProviderPending）
const pluginProviderPending = hasProvider() && !isBuiltinKind(providerKind());
const providerEarly = hasProvider() && !pluginProviderPending ? providerFromEnv() : undefined;
providerEarly?.catch(() => {});
if (!hasProvider() && !tui) {
  console.error(
    `jade: no model is configured.\n\n` +
      `Run jade in a terminal and use /model, or put one of these in ${envFile} (or set them in the shell):\n` +
      `  OPENAI_COMPAT_BASE_URL=…  OPENAI_COMPAT_API_KEY=…  OPENAI_COMPAT_MODEL=…   (any /chat/completions service)\n` +
      `  OPENAI_API_KEY=…  [OPENAI_BASE_URL=…  OPENAI_MODEL=…]                     (OpenAI Responses API)\n` +
      `  ANTHROPIC_API_KEY=…  [ANTHROPIC_MODEL=…]                                  (Claude)\n` +
      `  JADE_PROVIDER=<kind>  plus the settings that plugin documents             (a model service from a plugin)`,
  );
  process.exit(2);
}

// 写错时直接报错：NaN 会让"是否超过阈值"永远为假，每次请求都压缩
let compactTokens: number | undefined;
try {
  compactTokens = process.env.JADE_COMPACT_TOKENS ? parseTokens("JADE_COMPACT_TOKENS", process.env.JADE_COMPACT_TOKENS) : undefined;
} catch (err) {
  fail(errorText(err));
}
/** 模型的上下文窗口：JADE_CONTEXT_WINDOW，/model 改配置后更新 */
let contextWindow = 0;
try {
  contextWindow = contextWindowFromEnv();
} catch (err) {
  fail(errorText(err));
}
/** 压缩阈值：JADE_COMPACT_TOKENS，否则由上下文窗口推出 */
const compactAt = () => compactTokens ?? compactThreshold(contextWindow);

const modelLabel = () => (hasProvider() ? providerInfo().model || "(no model)" : "(no model)");

// 界面在启动过程中就已经可以输入；启动完成前提交的内容先存着，完成后再处理
let ready = false;
const early: string[] = [];

const inputs = new InputHistory(path.join(home, "history.jsonl"), cwd);

/** $JADE_HOME/plugins.json 里停用的插件和内置插件（id） */
const disabledPlugins = new Set((await readPluginSettings(home)).disabled);
const repo = realPath(await repoRoot(cwd));
/**
 * 第三方插件：先只读清单，不执行代码。按 id 停用的、id 重复的在这里就去掉，不加载，也不读它们带的内容；
 * 清单读不了的在 loadPlugins 里报告
 */
const resolved = await resolvePlugins(await discoverPlugins({ home, root: repo, cwd: realPath(cwd) }), disabledPlugins);
const foundPlugins = resolved.plugins;
const bundled = (pick: (b: PluginBundle) => string[]) => foundPlugins.flatMap((f) => pick(f.info.bundle).map((dir) => ({ plugin: f.id, dir, layer: f.layer })));

/** 自定义命令（$JADE_HOME/commands、.jade/commands、插件带的 commands/）；和内置命令同名的不生效 */
const builtinNames = new Set([...COMMANDS.map((c) => c.name), ...BUILTIN_PLUGIN_COMMANDS]);
/** 宿主自己处理的命令（/help、/model 等）：插件的同名命令永远不生效 */
const hostNames = new Set(COMMANDS.map((c) => c.name));
const customLoaded = await loadCommands({ home, root: repo, cwd: realPath(cwd), plugins: bundled((b) => b.commands) });
const shadowed = customLoaded.filter((c) => builtinNames.has(c.name));
const customs = new Map(customLoaded.filter((c) => !builtinNames.has(c.name)).map((c) => [c.name, c]));
const ALL_COMMANDS: CommandInfo[] = [
  ...COMMANDS,
  ...[...customs.values()].map((c) => ({ name: c.name, args: c.args, about: `${c.description} (${c.plugin ? `plugin ${c.plugin}` : c.layer})` })),
];

// 插件、工具输出和模型的文字都经过这里显示：只留颜色，去掉能搅乱终端的控制序列
const screen: Screen = safeScreen(tuiModule
  ? (await tuiModule).tuiScreen({
      status: { cwd: shortPath(cwd), branch: await branchFound, model: modelLabel(), mode: opts.mode ?? "ask" },
      version: VERSION,
      commands: ALL_COMMANDS,
      history: await inputs.load(),
      handlers: {
        submit: (text) => {
          inputs.add(text).catch(() => {});
          if (ready) onSubmit(text);
          else early.push(text);
        },
        interrupt: () => ready && interrupt(),
        exit: () => (ready ? void quit() : process.exit(130)),
        files: () => mentionCandidates(cwd),
        dismissSuggestion: () => ready && clearSuggestion(),
        cycleMode: () => ready && cycleMode(),
        key: (spec) => ready && pluginKey(spec),
      },
    })
  : plainScreen({ interactive: Boolean(process.stdin.isTTY) }));

/** 压缩、子 Agent 和主循环共用；/model 改配置后换掉里面的实现 */
const provider = switchable({
  id: "unconfigured",
  complete: () => Promise.reject(new Error("no model is configured; use /model")),
});

/** /model 的交互：改配置后换掉 provider、更新上下文窗口和状态栏 */
const configure = configurator({
  screen,
  envFile,
  modelsFile: path.join(home, "models.json"),
  apply: async () => {
    provider.set(retrying(await providerFromEnv()));
    contextWindow = contextWindowFromEnv();
  },
  contextWindow: () => contextWindow,
  onApplied: () => screen.status({ model: modelLabel() }),
});

// 还没配置模型时，等插件加载完再问（见下面 registerProviders 之后）：插件提供的服务也要列出来
if (providerEarly) {
  try {
    provider.set(retrying(await providerEarly));
  } catch (err) {
    await screen.close();
    fail(errorText(err));
  }
}

/**
 * 外面包一层重试和限速。限速对这个服务的所有请求（主 Agent、子 Agent、压缩）共用：
 * JADE_RPM 设了上限时把请求平均分布在一分钟里；被限流时所有请求一起等，而不是各自去撞
 */
function retrying(inner: Provider) {
  /** 状态行正显示着排队或等待重试：请求发出后换回来 */
  let waiting = false;
  const gate = new RateGate({
    rpm: rpmFromEnv(),
    onWait: (ms) => {
      if (ms < 1000) return;
      waiting = true;
      screen.busy(`Pacing requests (${gate.rpm ? `${+gate.rpm.toFixed(1)}/min` : "rate limited"}, ${seconds(ms)})`);
    },
    onLearn: (rpm) =>
      screen.log(dim(`[rate limited: spacing requests to ${rpm} per minute from now on; set the exact limit with /model → requests per minute]`)),
  });
  return withRetry(inner, {
    gate,
    onRequest: () => {
      if (waiting && running) screen.busy("Waiting for the model");
      waiting = false;
    },
    onRetry: ({ attempt, retries, delayMs, error }) => {
      const why = isRateLimit(error) ? "rate limited" : clip(error.message.replace(/\s+/g, " "), tui ? 60 : 160);
      // 终端界面只在状态行显示，不在对话里每次重试刷一行；重试用完仍然失败时照常报错
      if (!tui) screen.log(yellow(`[${why} · retry ${attempt}/${retries} in ${seconds(delayMs)}]`));
      waiting = true;
      screen.busy(`Waiting to retry (${why} · ${attempt}/${retries}, ${seconds(delayMs)})`);
    },
  });
}

const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000) ? `${Math.round((ms % 60_000) / 1000)}s` : ""}` : `${Math.max(1, Math.round(ms / 1000))}s`);

const store = new JsonlLogStore(path.join(home, "sessions"));
const trust = new JsonlTrustStore(path.join(home, "trust.jsonl"));
const index = new SessionIndex(path.join(home, "index.jsonl"));

/** 正在结束进程外插件：这时它们退出是预期的，不提示 */
let pluginsClosing = false;
// 插件、skill、MCP 服务同时加载：MCP 服务启动可能要好几秒。确认对话框一个接一个：MCP 的排在插件的后面
const pluginsLoading = loadPlugins();
const mcpConnecting = connectMcp(pluginsLoading);
const skillsLoading = loadSkills({ home, root: repo, cwd: realPath(cwd), plugins: bundled((b) => b.skills) });
const pluginSources = await pluginsLoading;
const skillsLoaded = await skillsLoading;
for (const w of skillsLoaded.warnings) screen.log(yellow(`[warning] ${w}`));
const skills = skillsLoaded.skills;
const mcpClients = await mcpConnecting;
/**
 * 运行中切换的权限模式：这一轮正占着日志，写不进去。关卡先按它判断（下一个工具调用就生效），
 * 这一轮结束后再记进日志（flushPendingMode）
 */
let pendingMode: Mode | undefined;
/** 当前配置的模型和服务，写进系统提示词，用户问起时模型照这个回答；/model 改了配置后下一次请求就是新的 */
function currentModel(): { name: string; via: string } | undefined {
  if (!hasProvider()) return undefined;
  const info = providerInfo();
  let host: string | undefined;
  try {
    host = info.baseURL ? new URL(info.baseURL).host : undefined;
  } catch {}
  if (!isBuiltinKind(info.kind)) {
    let via = `the ${info.kind} provider`;
    try {
      via = pluginProvider(info.kind)?.def.via?.(process.env) || via;
    } catch {}
    return { name: info.model, via };
  }
  const api = { anthropic: "the Anthropic API", openai: "the OpenAI Responses API", "openai-compat": "an OpenAI-compatible API" }[info.kind];
  return { name: info.model, via: host ? `${api} at ${host}` : api };
}
/** 插件用 ctx.status 设置的状态栏段落，按插件的 id */
const pluginStatus = new Map<string, string>();
/** 第几套插件实例；换会话之后旧实例设置的状态不再显示 */
let jadeGeneration = 0;
function setPluginStatus(plugin: string, text: string | undefined) {
  const line = text === undefined ? "" : stripVTControlCharacters(String(text)).replace(/\s+/g, " ").trim();
  if (line) pluginStatus.set(plugin, clip(line, 40));
  else pluginStatus.delete(plugin);
  screen.status({ plugins: [...pluginStatus].map(([p, t]) => ({ plugin: p, text: t })) });
}

// 模型放临时脚本、测试数据的目录，整个进程共用一个（换会话时提示词不变，不影响缓存）。
// 写成正斜杠：Windows 上 Git Bash、Python、Node 都认 C:/Users/...，而 /tmp 在它们之间不是同一个地方
const scratch = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-"))).replaceAll("\\", "/");

/** 每个会话用一套新的插件实例：插件里有按会话记的状态（例如压缩、重复调用的计数） */
const makeJade = (mode?: Mode) => {
  const generation = ++jadeGeneration;
  pluginStatus.clear();
  screen.status({ plugins: [] });
  return createJade({
    cwd,
    home,
    store,
    provider,
    mode,
    model: currentModel,
    extensions: pluginSources,
    disabled: disabledPlugins,
    mcp: mcpClients,
    skills,
    compactTokens: compactAt,
    scratch,
    approveSubagent,
    // 不能交互时（-p）没有人回答，不提供这个工具
    askUser: screen.interactive ? askUser : undefined,
    sharedRules: (): AllowRule[] => [...settings().rules, ...pendingRules],
    pendingMode: () => pendingMode,
    // auto 模式的审查用当前的模型；rt 换会话时跟着换，所以每次取
    review: reviewer({ provider, cwd, scratch, messages: () => rt.state.messages }),
    approveCheck: process.env.JADE_CHECKS === "off" ? undefined : approveCheck,
    checkConfirmed: (c) => trust.has(checkHash(c)),
    checksUnavailable: process.env.JADE_CHECKS === "off" ? "Edit-time checks are turned off by JADE_CHECKS=off." : undefined,
    onStatus: (plugin, text) => generation === jadeGeneration && setPluginStatus(plugin, text),
    // 换会话后旧的插件实例不能再改输入框、发消息
    input: screen.draft && {
      text: () => screen.draft!.text(),
      insert: (text) => void (generation === jadeGeneration && screen.draft!.insert(String(text))),
      set: (text) => void (generation === jadeGeneration && screen.draft!.set(String(text))),
    },
    send: screen.draft && ((plugin, text) => void (generation === jadeGeneration && pluginSend(plugin, text))),
  });
};

const warn = (list: string[]) => {
  for (const w of list) screen.log(yellow(`[warning] ${w}`));
};
// 插件提供的模型服务是插件模块导出的，加载时就读到了，不用创建插件实例：先注册、配置好模型，再创建插件，
// 插件的工厂函数里也能用 ctx.complete。只注册一次，之后的会话共用（provider 是整个进程的）
const collected = collectProviders(pluginSources);
warn([...collected.warnings, ...registerProviders(collected.providers)]);
if (!hasProvider()) {
  // 第一次运行：插件已经加载，/model 的服务列表里也有插件提供的
  screen.log(bold("Welcome to jade.") + " No model is configured yet; let's set one up.");
  if (!(await configure.provider())) {
    await closePlugins();
    await screen.close();
    process.exit(2);
  }
} else if (pluginProviderPending) {
  try {
    provider.set(retrying(await providerFromEnv()));
    contextWindow = contextWindowFromEnv();
  } catch (err) {
    // 例如提供这个服务的插件被删掉、停用或者没加载成功：原因在上面插件的警告里
    await providerUnavailable(errorText(err));
  }
  screen.status({ model: modelLabel() });
}
let jade: Jade = await makeJade(opts.mode);
warn(jade.warnings);

/** 选的模型服务用不了：终端界面里直接进 /model 换一个服务，不然用户只能手改 .env；不能交互时报错退出 */
async function providerUnavailable(message: string): Promise<void> {
  if (tui) {
    screen.log(red(`[error] ${message}`));
    screen.log("Choose another model with /model.");
    if (await configure.provider()) return;
    await closePlugins();
    await screen.close();
    process.exit(2);
  }
  await closePlugins();
  await screen.close();
  fail(message);
}
if (badSavedMode) screen.log(yellow(`[warning] JADE_MODE=${badSavedMode} is not a mode (${MODES.join(", ")}); starting in ${opts.mode ?? "ask"}`));
for (const c of shadowed) screen.log(yellow(`[warning] custom command ${display(cwd, c.file)} is ignored: /${c.name} is a built-in command`));
// 插件的命令加进菜单（名字在各个会话的实例之间不变）。内置命令和 .jade/commands 里的同名命令优先
// skill 也可以当命令用：/<skill 名> [要做的事]。内置命令和自定义命令优先
const skillCommands = new Map<string, (typeof skills)[number]>();
for (const sk of skills) {
  const name = sk.name.toLowerCase();
  if (builtinNames.has(name) || customs.has(name)) continue;
  skillCommands.set(name, sk);
  ALL_COMMANDS.push({ name: sk.name, args: "[task]", about: `${clip(sk.description.replace(/\s+/g, " "), 80)} (skill)` });
}
// 内置插件的命令排在宿主命令后面；第三方插件的命令排在最后
const builtinPluginCommands: CommandInfo[] = [];
for (const [name, { plugin, command: c, builtin }] of jade.commands) {
  if (builtin) {
    builtinPluginCommands.push({ name: c.name, args: c.args, about: c.description ?? "" });
    continue;
  }
  // 内置插件的命令名（/clear、/undo…）在 jade.commands 里内置插件优先：这里还是第三方的，说明那个内置插件被代替或停用了，
  // 第三方插件可以提供它
  if (hostNames.has(name) || customs.has(name) || skillCommands.has(name)) {
    const what = hostNames.has(name) ? "a built-in command" : customs.has(name) ? "a custom command" : "a skill";
    screen.log(yellow(`[warning] command /${c.name} of plugin ${plugin} is ignored: ${what} has that name`));
    continue;
  }
  ALL_COMMANDS.push({ name: c.name, args: c.args, about: `${c.description ?? ""} (plugin ${plugin})`.trim() });
}
ALL_COMMANDS.splice(COMMANDS.length, 0, ...builtinPluginCommands);

/**
 * 第三方插件：$JADE_HOME/plugins/<name>/（用户层）和 .jade/plugins/<name>/（项目层）。
 * 项目层的首次加载及内容变化后要用户确认（7.1）。加载失败的跳过并提示，不影响启动
 */
async function loadPlugins(): Promise<LoadedPlugin[]> {
  for (const { found, error } of resolved.broken) screen.log(yellow(`[skipped] plugin ${display(cwd, found.dir)}: ${errorText(error)}`));
  for (const w of resolved.warnings) screen.log(yellow(`[skipped] ${w}`));
  const out: LoadedPlugin[] = [];
  for (const f of foundPlugins) {
    try {
      const unsupported = f.info.bundle.unsupported;
      if (unsupported.length) screen.log(dim(`[note] plugin ${f.id}: jade does not support its ${unsupported.join(" and ")} yet; they are ignored`));
      out.push(
        await loadPlugin(f, {
          trust,
          confirm: async ({ path: p, hash, files, command }) =>
            (await screen.select(
              `Project plugin ${display(cwd, p)} is new or changed. Load and run it?`,
              [
                { label: "No", value: false },
                { label: "Yes, load it", value: true },
              ],
              {
                body: dim(
                  `${command ? `runs: ${command}\n` : ""}sha256 ${hash.slice(0, 12)}, ${files.length} files:\n${files.map((f) => `  ${f}`).join("\n")}`,
                ),
              },
            )) ?? false,
          onExit: (p, { code, signal }) => {
            if (!pluginsClosing) screen.log(yellow(`[warning] plugin ${p.id} exited (${signal ?? `code ${code}`}); its hooks fail until jade restarts. /plugins shows its stderr`));
          },
        }),
      );
    } catch (err) {
      const hint = f.layer === "project" && !tui && err instanceof UntrustedPlugin ? " (run jade interactively in this directory once to confirm it)" : "";
      screen.log(yellow(`[skipped] plugin ${display(cwd, f.dir)}: ${errorText(err)}${hint}`));
    }
  }
  return out;
}

/** 结束进程外插件的进程 */
async function closePlugins() {
  pluginsClosing = true;
  await Promise.all([...pluginSources.map((p) => p.close?.().catch(() => {})), ...mcpClients.map((c) => c.close().catch(() => {}))]);
}

/**
 * 连接 mcp.json 里配置的 MCP 服务。项目层（随仓库分发）的服务第一次启动前要用户确认，按配置内容记在 trust.jsonl；
 * 连不上的跳过并提示，不影响启动。所有服务并发连接，不用确认的立即开始连。
 * 启动时最多等 MCP_STARTUP_WAIT_MS：还没连上的在后台接着连，它们的工具从下一个会话（/clear）开始提供
 * （一个会话里的工具列表不变，否则提示缓存失效）。
 * dialogsAfter：在它完成之后才弹确认框，不和插件的确认框同时出现
 */
async function connectMcp(dialogsAfter: Promise<unknown>): Promise<McpClient[]> {
  const plugins = foundPlugins.flatMap((f) => {
    const mcp = f.info.bundle.mcp;
    return mcp ? [{ plugin: f.id, dir: f.dir, layer: f.layer, file: mcp.file, servers: mcp.servers }] : [];
  });
  const { servers, warnings } = await loadMcpConfig({ home, root: repo, cwd: realPath(cwd), plugins });
  for (const w of warnings) screen.log(yellow(`[warning] ${w}`));
  const clients: McpClient[] = [];
  const connecting: Promise<unknown>[] = [];
  for (const entry of servers) {
    if (entry.config.disabled) continue;
    if (entry.layer === "project") {
      const hash = mcpTrustHash(repo, entry);
      if (!(await trust.has(hash))) {
        if (tui) await dialogsAfter.catch(() => {});
        const ok = tui
          ? ((await screen.select(
              `MCP server "${entry.name}" from ${display(cwd, entry.file)} is new or changed. Start it?`,
              [
                { label: "No", value: false },
                { label: "Yes, start it", value: true },
              ],
              { body: dim(`${entry.config.command !== undefined ? "runs" : "connects to"}: ${describeServer(entry.config)}`) },
            )) ?? false)
          : false;
        if (!ok) {
          screen.log(yellow(`[skipped] MCP server ${entry.name}: not confirmed${tui ? "" : " (run jade interactively in this directory once to confirm it)"}`));
          continue;
        }
        await trust.add({ hash, path: entry.file, at: new Date().toISOString() });
      }
    }
    const client = new McpClient(entry, {
      cwd,
      onDisconnect: (c, why) => {
        if (!pluginsClosing) screen.log(yellow(`[warning] MCP server ${c.name} disconnected: ${why}. jade reconnects on its next tool call; /mcp shows details`));
      },
    });
    clients.push(client);
    connecting.push(client.connect().catch((err) => screen.log(yellow(`[warning] MCP server ${client.name} is unavailable: ${errorText(err)}`))));
  }
  if (clients.length === 0) return clients;
  screen.busy(`Connecting to ${clients.length} MCP server${clients.length > 1 ? "s" : ""}`);
  const all = Promise.all(connecting);
  // 不能交互时（-p）只运行这一次，没有"下一个会话"，照常等到每个服务连上或超时
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (tui) await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, MCP_STARTUP_WAIT_MS)))]);
  else await all;
  clearTimeout(timer);
  screen.busy(undefined);
  for (const c of clients.filter((x) => x.status === "connecting")) {
    screen.log(dim(`[MCP server ${c.name} is still starting; its tools are available from the next session (/clear) once it is connected]`));
    void c.connect().then(
      () => screen.log(dim(`[MCP server ${c.name} connected; its tools are available from the next session (/clear)]`)),
      () => {},
    );
  }
  return clients;
}

let resumeId = opts.resume;
if (resumeId === "") {
  if (!tui) {
    await screen.close();
    fail("--resume without an id needs a terminal to pick from; pass the id");
  }
  resumeId = await pickSession();
} else if (resumeId) resumeId = matchSession(await index.list(cwd), resumeId);
if (opts.cont) {
  resumeId = (await index.list(cwd))[0]?.id;
  if (!resumeId) {
    await screen.close();
    fail(`no session to continue in ${cwd}`);
  }
}

// /clear 换成新的运行时和会话
let rt = resumeId
  ? await Runtime.resume({ store, provider, plugins: jade.plugins, sessionId: resumeId })
  : await Runtime.create({ store, provider, plugins: jade.plugins });
let sessionId = rt.state.sessionId;

// 权限设置记在日志里（derived），关卡从那里读，恢复会话后仍然有效
// 主会话不会是 readonly（只给子 Agent 用；旧会话里记的 readonly 由关卡换成 plan）
// 只取这一项：rt.state 每次都拷贝整段历史，而这里调用得很频繁（子 Agent 的每次关卡判断都会调用）
const settings = () => jade.policy.settings({ [POLICY_KEY]: rt.derived(POLICY_KEY) }) as PolicySettings & { mode: Mode };
const saveSettings = async (next: PolicySettings) => {
  await rt.record(POLICY_KEY, next);
  pendingMode = undefined;
  screen.status({ mode: next.mode });
};

/**
 * 用户切换的模式记进 $JADE_HOME/.env 的 JADE_MODE，之后新开的会话默认用它（恢复的会话仍用它自己记下的模式）。
 * yolo 不记：免得以后一打开就什么都不问；要默认 yolo 可以手动写 JADE_MODE=yolo 或用 -m yolo
 */
async function rememberMode(mode: Mode) {
  if (mode === "yolo" || process.env.JADE_MODE === mode) return;
  await updateEnvFile(envFile, { JADE_MODE: mode }).catch((err) =>
    screen.log(yellow(`[warning] could not remember the mode in ${envFile}: ${errorText(err)}`)),
  );
}

/** 换权限模式；运行时正在执行这一轮时先记在 pendingMode，关卡立即按它判断，这一轮结束后再写进日志 */
async function setMode(mode: Mode) {
  await rememberMode(mode);
  try {
    await saveSettings({ ...settings(), mode });
  } catch (err) {
    if (!(err instanceof RuntimeBusy)) throw err;
    pendingMode = mode;
    screen.status({ mode });
  }
}

/** 把运行中切换的模式写进日志 */
async function flushPendingMode() {
  if (pendingMode === undefined) return;
  try {
    await saveSettings(settings());
  } catch (err) {
    if (!(err instanceof RuntimeBusy)) screen.log(red(`[error] ${errorText(err)}`));
  }
}

// ---------- 渲染 ----------

const view = transcript({ screen, cwd, store, contextWindow: () => contextWindow, compactAt: () => compactAt(), canRetry: () => canRetry(), renderer: (tool) => jade.renderers.get(tool) });
rt.subscribe(view.onNotice);

// ---------- 审批 ----------

type Call = { toolUseId: string; name: string; input: unknown; reason?: string };

/**
 * 问用户是否允许一个调用；选了"总是允许"时交给 remember 记下规则。
 * 插件的 responder（例如发到手机上）和终端同时等，用先到的回答
 */
async function ask(c: Call, who: string, remember: (rule: AllowRule) => Promise<void> | void, signal?: AbortSignal): Promise<SubagentApproval> {
  const head = `${c.name}(${view.summary(c.name, c.input)})`;
  const remote = jade.responders.filter((r) => r.responder.approve);
  const unavailable = (): SubagentApproval => {
    screen.log(red(`✗ ${who}${head} denied: not running interactively`));
    return { approved: false, reason: "The user is not available to approve this action." };
  };
  if (!screen.interactive && !remote.length) return unavailable();
  const rule = jade.policy.ruleFor(c);
  const always = rule.command !== undefined ? "this exact command" : describeRule(rule);
  // 关卡给了理由的（例如 auto 模式下审查转给用户的），说明为什么要问
  const body = (c.reason ? `${yellow(c.reason)}\n\n` : "") + (await view.preview(c));
  const request = { title: `${who}${head}`, tool: c.name, input: c.input, preview: stripVTControlCharacters(body), reason: c.reason };
  type Reply = { approved: boolean; message?: string; always?: boolean; tell?: boolean };
  const { value, by } = await firstAnswer<Reply>(
    screen.interactive
      ? async (s) => {
          const answer = await screen.select(
            `Allow ${who}${head}?`,
            [
              { label: "Yes", value: "yes" as const },
              { label: `Yes, and always allow ${always} in this session`, value: "always" as const },
              { label: "No, and tell jade what to do instead", value: "no" as const },
            ],
            { body, signal: s },
          );
          return { approved: answer === "yes" || answer === "always", always: answer === "always", tell: answer === "no" };
        }
      : undefined,
    remote.map((r) => ({
      plugin: r.plugin,
      run: async (s) => {
        const reply = await r.responder.approve!(request, s);
        if (reply !== undefined && typeof reply?.approved !== "boolean") throw new Error("approve must return { approved: boolean } or undefined");
        return reply;
      },
    })),
    { signal, onError: responderFailed },
  );
  if (!value) return unavailable();
  if (value.always) await remember(rule);
  const said = (value.tell ? (await screen.input("What should jade do instead? (optional)", { signal })) : value.message)?.trim();
  const approved = value.approved;
  // 带上"用户拒绝了"这层前提，否则模型可能把用户的话当成命令的输出
  const reason = approved ? undefined : said ? `The user rejected this action and said: ${said}` : "The user rejected this action.";
  const via = by ? dim(` (via ${by})`) : "";
  // 主 Agent 的调用的结果之后接在这一行后面
  screen.log((approved ? green(`✓ ${who}${head}`) : red(`✗ ${who}${head}`)) + via + dim(reason ? ` — ${clip(reason, 200)}` : ""), {
    id: c.toolUseId,
    details: view.details(c.name, c.input),
  });
  return { approved, reason };
}

function responderFailed(plugin: string, err: unknown) {
  screen.log(yellow(`[warning] plugin ${plugin}: responder failed: ${err instanceof Error ? err.message : String(err)}`));
}

async function approvePending() {
  while (rt.state.phase === "awaiting") {
    for (const c of rt.state.batch.filter((x) => x.decision === "ask")) {
      const answer = await ask(c, "", async (rule) => {
        const s = settings();
        await saveSettings({ ...s, rules: [...s.rules, rule] });
      });
      await rt.send({ kind: "approval", toolUseId: c.toolUseId, ...answer });
    }
  }
}

/**
 * 子 Agent 审批时选了"总是允许"的规则：主会话这时正在执行 task 工具，日志写不进去，
 * 先在这里生效（sharedRules），这一轮结束后再记进日志
 */
const pendingRules: AllowRule[] = [];
/** 并行的子 Agent 一次只问一个 */
let subagentAsking: Promise<unknown> = Promise.resolve();

function approveSubagent(...[c, signal]: Parameters<ApproveSubagent>): Promise<SubagentApproval> {
  const turn = subagentAsking.then(() => {
    signal.throwIfAborted();
    // 中断时不再等用户回答，对话框和插件那边的请求一起关掉
    return ask(c, "sub-agent ", (rule) => void pendingRules.push(rule), signal);
  });
  subagentAsking = turn.catch(() => {});
  return turn;
}

/** ask_user：逐个问题让用户选一项，或者选"其他"自己输入；任何一个问题取消就算没有回答。插件的 responder 和终端同时等 */
async function askUser(questions: Question[], signal: AbortSignal): Promise<string[] | undefined> {
  const remote = jade.responders.filter((r) => r.responder.ask);
  if (!screen.interactive && !remote.length) return undefined;
  const OTHER = -1;
  const local = async (s: AbortSignal) => {
    const answers: string[] = [];
    for (const [i, q] of questions.entries()) {
      const title = questions.length > 1 ? `${q.question} (${i + 1}/${questions.length})` : q.question;
      const choice = await screen.select(
        title,
        [...q.options.map((o, k) => ({ label: o.label, value: k, hint: o.description })), { label: "Other (type your answer)", value: OTHER }],
        { signal: s },
      );
      if (choice === undefined) return undefined;
      const answer = choice === OTHER ? (await screen.input(q.question, { signal: s }))?.trim() : q.options[choice]!.label;
      if (!answer) return undefined;
      answers.push(answer);
      screen.log(dim(`  ${q.question} → `) + answer);
    }
    return answers;
  };
  const run = subagentAsking.then(async () => {
    const { value, by } = await firstAnswer<string[]>(
      screen.interactive ? local : undefined,
      remote.map((r) => ({
        plugin: r.plugin,
        run: async (s) => {
          const answers = await r.responder.ask!(questions, s);
          const ok = answers === undefined || (Array.isArray(answers) && answers.length === questions.length && answers.every((x) => typeof x === "string" && x.trim()));
          if (!ok) throw new Error(`ask must return one non-empty answer per question (${questions.length}) or undefined`);
          return answers;
        },
      })),
      { signal, onError: responderFailed },
    );
    if (value && by) questions.forEach((q, i) => screen.log(dim(`  ${q.question} → `) + value[i] + dim(` (via ${by})`)));
    return value;
  });
  subagentAsking = run.catch(() => {});
  return run;
}

/** 编辑后检查的确认记录：同一个目录里的同一条命令只问一次，记在 trust.jsonl */
const checkHash = (c: Check) => createHash("sha256").update(`jade-check\0${c.cwd}\0${c.command}`).digest("hex");
const confirmedChecks = new Set<string>();

/**
 * 编辑后检查的命令第一次运行前问用户：它会执行仓库里的代码（node_modules 里的 tsc、配置里的命令）。
 * yolo 模式不问；不能交互时不运行
 */
async function approveCheck(c: Check, signal: AbortSignal): Promise<boolean> {
  const hash = checkHash(c);
  // 每批修改都会问一次：确认过的记在内存里，不用每次重读、解析整份 trust.jsonl
  if (confirmedChecks.has(hash)) return true;
  if (await trust.has(hash)) {
    confirmedChecks.add(hash);
    return true;
  }
  if (settings().mode === "yolo") return true;
  if (!screen.interactive) return false;
  const run = subagentAsking.then(() => {
    signal.throwIfAborted();
    return abortable(
      screen.select(
        `Run ${c.name} after the agent edits files, and show it the problems found?`,
        [
          { label: "Yes, in this project from now on", value: true },
          { label: "No, not in this session", value: false },
        ],
        { body: `${c.command}\n${dim(`in ${display(cwd, c.cwd) || "."}${c.source === "config" ? " (from checks.json)" : " (detected)"}`)}` },
      ),
      signal,
    );
  });
  subagentAsking = run.catch(() => {});
  const ok = (await run) ?? false;
  if (ok) {
    await trust.add({ hash, path: c.cwd, at: new Date().toISOString() });
    confirmedChecks.add(hash);
  } else screen.log(dim(`[${c.name} will not run in this session; /checks on to ask again]`));
  return ok;
}

/** /checks：开关本会话的编辑后检查；不带参数时列出对本会话改过的文件会运行的检查 */
/** /<skill> 发给模型的消息：让它先加载这个 skill */
function skillMessage(name: string, args: string): string {
  return `Use the "${name}" skill${args.trim() ? ` for this: ${args.trim()}` : "."}`;
}

/** 正在执行的插件命令；esc 中断它们。instant 的命令可以在另一个命令的模型回合里执行，所以可能同时有几个 */
const commandAborts = new Set<AbortController>();
/** 插件命令经 session 发起的换会话、重试：命令被 esc 中断后也要等它收尾，再处理下一条输入 */
let sessionWork: Promise<unknown> | undefined;

/** 执行插件的斜杠命令，返回要发给模型的提示词（没有就是 undefined） */
async function pluginCommand(name: string, args: string): Promise<string | undefined> {
  const found = jade.commands.get(name.toLowerCase());
  if (!found) {
    screen.log(red(`unknown command /${name}; type / to see the commands`));
    return undefined;
  }
  const ac = new AbortController();
  commandAborts.add(ac);
  try {
    const result = await abortable(
      Promise.resolve(
        found.command.run(args, {
          sessionId,
          cwd,
          signal: ac.signal,
          derived: structuredClone(rt.state.derived),
          ui: {
            interactive: screen.interactive,
            log: (text) => screen.log(text),
            select: (title, choices, o) => screen.select(title, choices, o),
            input: (title, o) => screen.input(title, o),
          },
          note: (text) => void notes.push(text),
          // instant 的命令在模型工作时执行，不能换会话、写日志
          session: found.command.instant ? undefined : sessionControl(found.plugin),
        }),
      ),
      ac.signal,
    );
    if (typeof result === "string") {
      if (result) screen.log(result);
      return undefined;
    }
    if (result && typeof result === "object" && typeof result.prompt === "string") {
      // instant 的命令在模型工作时也会执行，不能再发一条消息
      if (found.command.instant) {
        screen.log(red(`[error] /${found.command.name} (plugin ${found.plugin}) is instant, so it cannot send a prompt`));
        return undefined;
      }
      return result.prompt.trim() ? result.prompt : undefined;
    }
    return undefined;
  } catch (err) {
    // 用户按 esc 中断的不算出错
    if (!ac.signal.aborted) screen.log(red(`[error] /${found.command.name} (plugin ${found.plugin}): ${errorText(err)}`));
    return undefined;
  } finally {
    // instant 的命令没有 session，不会发起 sessionWork；运行中的是别的命令发起的，不能替它等、替它清掉
    if (!found.command.instant) {
      await sessionWork?.catch(() => {});
      sessionWork = undefined;
    }
    commandAborts.delete(ac);
  }
}

/** 插件命令操作会话的接口；换会话后指向新的会话（rt、sessionId 每次现取） */
function sessionControl(plugin: string): SessionControl {
  const track = <T>(p: Promise<T>): Promise<T> => ((sessionWork = p), p);
  return {
    messages: () => structuredClone(rt.state.messages),
    record: async (key, value) => {
      if (key !== plugin && !key.startsWith(`${plugin}/`)) throw new Error(`plugin ${plugin} can only record keys "${plugin}" or "${plugin}/…", not ${JSON.stringify(key)}`);
      await rt.record(key, value);
    },
    list: async () => (await index.list(cwd)).map(({ id, title, at }) => ({ id, title, at })),
    clear: () => track(switchSession()),
    reload: () => track(reloadSession()),
    resume: (id) => track(switchSession(id)),
    retry: async () => {
      if (!canRetry()) return false;
      await track(drive({ kind: "retry" }));
      return true;
    },
  };
}

/** /plugins：内置插件的状态，每个第三方插件的来源、工具、hook、命令和带的内容；跳过的插件在启动时已经提示过 */
function showPlugins() {
  const width = Math.max(...jade.builtins.map((b) => b.id.length)) + 2;
  const lines: string[] = [bold("Built-in") + dim("  (jade plugin disable <id> turns one off)")];
  for (const b of jade.builtins) {
    const state = b.state === "replaced" ? yellow(` replaced by ${b.by}`) : b.state === "disabled" ? yellow(" disabled") : "";
    lines.push(`  ${b.id.padEnd(width)}${dim(b.about)}${state}`);
  }
  const contentOnly = pluginSources.filter((p) => p.kind === "content");
  lines.push("", bold("Installed") + dim("  (jade plugin add <git URL | npm package | directory>)"));
  if (jade.extensions.length === 0 && contentOnly.length === 0) {
    lines.push(dim(`  (none) put plugins in ${display(cwd, path.join(home, "plugins"))}/<name>/ or .jade/plugins/<name>/`));
  }
  const carried = (b: PluginBundle) =>
    [b.skills.length ? "skills" : "", b.commands.length ? "commands" : "", b.mcp ? "MCP servers" : ""].filter(Boolean).join(", ");
  for (const { source, plugin } of jade.extensions) {
    const exit = source.process?.exited;
    const state = source.kind === "process" ? (exit ? red(` exited (${exit.signal ?? `code ${exit.code}`})`) : green(" running")) : "";
    lines.push(`${bold(plugin.id)} ${plugin.version} ${dim(`${source.layer} · ${display(cwd, source.dir)} · ${source.kind === "process" ? `runs ${source.entry}` : source.entry}`)}${state}`);
    const tools = (plugin.tools ?? []).map((t) => `${t.name} (${t.effect})`);
    const hooks = [...new Set((plugin.hooks ?? []).map((h) => `${h.kind}:${h.point}`))];
    const cmds = (plugin.commands ?? []).map((c) => `/${c.name}`);
    if (tools.length) lines.push(`  tools     ${tools.join(", ")}`);
    if (hooks.length) lines.push(`  hooks     ${hooks.join(", ")}`);
    if (cmds.length) lines.push(`  commands  ${cmds.join(", ")}`);
    if (plugin.replaces?.length) lines.push(`  replaces  ${plugin.replaces.join(", ")}`);
    if (carried(source.info.bundle)) lines.push(`  carries   ${carried(source.info.bundle)}`);
    if (exit && source.process!.stderr.length) lines.push(dim(source.process!.stderr.map((l) => `  │ ${clip(l, 200)}`).join("\n")));
  }
  for (const p of contentOnly) {
    lines.push(`${bold(p.id)}${p.info.version ? ` ${p.info.version}` : ""} ${dim(`${p.layer} · ${display(cwd, p.dir)}`)}`);
    lines.push(`  carries   ${carried(p.info.bundle)}`);
  }
  lines.push("", bold("Hook execution order"));
  for (const p of ["context.project", "context.build", "model.before", "model.after", "tool.before", "tool.gate", "tool.after", "turn.continue", "event", "session.start", "session.end"]) {
    lines.push(`  ${p.padEnd(16)} ${rt.hookOrder(p).join(" → ") || dim("(none)")}`);
  }
  screen.log(lines.join("\n"));
}

async function savePendingRules() {
  if (pendingRules.length === 0) return;
  const s = settings();
  await saveSettings({ ...s, rules: [...s.rules, ...pendingRules.splice(0)] });
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

// ---------- 运行 ----------

/** 正在执行一轮对话（或一个需要独占运行时的命令） */
let running = false;
/** running 期间那段工作；退出时等它收尾 */
let work: Promise<void> | undefined;

/** 独占运行时执行 fn；同一时间只有一个 */
async function occupy(fn: () => Promise<void>) {
  running = true;
  work = fn();
  try {
    await work;
  } finally {
    running = false;
    work = undefined;
    interruptPending = false;
    screen.busy(undefined);
    await flushPendingMode();
  }
}

/**
 * 上一次打断的时间；正在收尾的这一轮结束、开始下一条排队的输入之前一直算"刚打断过"（interruptPending）。
 * 刚打断过时再按一次 esc，连排队的消息一起清掉
 */
let interruptedAt = 0;
let interruptPending = false;
/** 第二次 esc 算作"再按一次"的时间窗口（从打断的那一轮结束、开始下一条排队的输入算起） */
const SECOND_ESC_MS = 3000;

function interrupt() {
  if (!running) return;
  const again = interruptPending || Date.now() - interruptedAt < SECOND_ESC_MS;
  interruptedAt = Date.now();
  interruptPending = true;
  for (const ac of commandAborts) ac.abort(new Error("interrupted by user"));
  rt.abort("interrupted by user");
  screen.busy("Interrupting");
  if (queue.length === 0) return;
  if (again) {
    const n = queue.splice(0).length;
    screen.queued(queue);
    screen.log(dim(`[cleared ${n} queued message${n > 1 ? "s" : ""}]`));
  } else {
    screen.log(dim(`[${queue.length} queued message${queue.length > 1 ? "s" : ""} will still be sent; press esc again to clear ${queue.length > 1 ? "them" : "it"}]`));
  }
}

/**
 * 离开会话但保留它：写入 session.detached，插件的收尾写入完成后再退出（4.2）。
 * 没收到过输入的会话没什么可恢复的，删掉它的日志；返回会话是否保留了下来
 */
async function leave(): Promise<boolean> {
  abortKeys("the session ended");
  jade.shutdown();
  try {
    await rt.detach();
    return !(await discardIfEmpty(store, sessionId));
  } catch (err) {
    screen.log(red(`[error] ${errorText(err)}`));
    return true;
  } finally {
    // 会话收尾（session.detached 的 hook）用的还是这套实例，之后才让插件收尾
    warn(await jade.dispose());
  }
}

/** 关掉界面后再提示怎么恢复：终端界面退出备用屏幕后，里面的内容就看不到了 */
async function closeScreen() {
  await screen.close();
  if (rt.state.messages.length > 0) console.log(dim(`Resume with: jade --resume ${sessionId}`));
}

let quitting = false;
async function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  if (running) rt.abort("exiting");
  // 中断后等这一轮收尾，再写 session.detached；pump 看到 quitting 就不再取排队的输入
  await work?.catch(() => {});
  await leave();
  await closePlugins();
  await closeScreen();
  process.exit(code);
}

/**
 * 换成另一个会话：/clear 开始新会话，/resume 恢复 id 指定的会话。当前会话保持可恢复；
 * 新会话用一套新的插件和运行时，权限模式沿用（恢复的会话用它日志里的设置）。
 * 恢复失败时留在当前会话
 */
async function switchSession(id?: string) {
  await flushPendingMode();
  const mode = settings().mode;
  const current = { generation: jadeGeneration, status: [...pluginStatus] };
  const next = await makeJade(mode);
  let nextRt: Runtime;
  try {
    nextRt = id
      ? await Runtime.resume({ store, provider, plugins: next.plugins, sessionId: id })
      : await Runtime.create({ store, provider, plugins: next.plugins });
  } catch (err) {
    next.shutdown();
    warn(await next.dispose());
    // 留在当前会话：当前的插件实例继续能改输入框、发消息、设状态，状态栏换回它们设置的
    jadeGeneration = current.generation;
    pluginStatus.clear();
    for (const [p, t] of current.status) pluginStatus.set(p, t);
    screen.status({ plugins: current.status.map(([p, t]) => ({ plugin: p, text: t })) });
    return screen.log(red(`[error] could not resume ${id}: ${errorText(err)}`));
  }
  const kept = await leave();
  const old = sessionId;
  jade = next;
  rt = nextRt;
  rt.subscribe(view.onNotice);
  sessionId = rt.state.sessionId;
  view.reset();
  notes.length = 0;
  announcedMode = undefined;
  pendingRules.length = 0;
  screen.clear();
  screen.status({ session: sessionId, mode: settings().mode, context: undefined, cache: undefined, spent: undefined, speed: undefined });
  if (!id) return screen.log(dim(kept ? `Started a new session. The previous one can be resumed with /resume or: jade --resume ${old}` : "Started a new session."));
  if (!(await resumeSession())) {
    screen.log(dim("Starting a new session instead."));
    await switchSession();
  }
}

/**
 * 用新的插件实例继续当前会话：工具和系统提示词按现在的配置重新生成（例如 /search 改了搜索服务），对话内容不变。
 * 只在空闲时调用：插件命令的 session.reload（instant 命令没有 session）
 */
async function reloadSession() {
  await flushPendingMode();
  const next = await makeJade(settings().mode);
  abortKeys("the session was reloaded");
  jade.shutdown();
  await rt.detach();
  warn(await jade.dispose());
  jade = next;
  try {
    rt = await Runtime.resume({ store, provider, plugins: jade.plugins, sessionId });
  } catch (err) {
    screen.log(red(`[error] could not reload the session: ${errorText(err)}; starting a new one`));
    rt = await Runtime.create({ store, provider, plugins: jade.plugins });
    sessionId = rt.state.sessionId;
    view.reset();
    screen.status({ session: sessionId });
  }
  rt.subscribe(view.onNotice);
  await guarded(() => rt.recover());
}

/** 从这个目录最近的会话里选一个（-r 不带 id 时）；取消或没有时返回 undefined */
async function pickSession(): Promise<string | undefined> {
  const all = (await index.list(cwd)).slice(0, 50);
  if (all.length === 0) {
    screen.log(dim(`No other sessions in ${shortPath(cwd)}.`));
    return undefined;
  }
  return screen.select(
    "Resume which session?",
    all.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${ago(s.at)} · ${s.id}` })),
  );
}

process.on("SIGINT", () => (running ? interrupt() : void quit(130)));

/** guarded 里最近一次抛出的错误；每次 guarded 开始时清掉 */
let lastThrown: string | undefined;

async function guarded(fn: () => Promise<void>) {
  view.turnFailed = false;
  view.lastError = undefined;
  lastThrown = undefined;
  try {
    await fn();
    await approvePending();
  } catch (err) {
    lastThrown = errorText(err);
    if (!view.turnFailed) screen.log(red(`[error] ${errorText(err)}`));
  } finally {
    screen.endStream();
  }
}

/** 宿主替用户告诉模型的事（例如 /undo），随下一条消息发出 */
const notes: string[] = [];

/** 最近一次告诉模型的权限模式；进入、离开计划模式时要随下一条消息告诉它 */
let announcedMode: Mode | undefined;
const PLAN_ON =
  "The session is now in plan mode. Investigate with read-only tools (and the task tool for broad searches); do not try to modify files " +
  "or run commands that change anything, such calls are denied. When you understand the task, reply with a concise, concrete plan: " +
  "the files to change and how, in order, any open questions, and how you will verify the result. Then stop and wait for the user's approval.";
const PLAN_OFF = "The session has left plan mode; you can now change files and run commands (subject to the user's approval settings).";

function announceMode() {
  const mode = settings().mode;
  if (mode === "plan" && announcedMode !== "plan") notes.push(PLAN_ON);
  else if (mode !== "plan" && announcedMode === "plan") notes.push(PLAN_OFF);
  announcedMode = mode;
}

/** Shift+Tab：ask → auto → plan → ask；yolo 也回到 ask。运行中也能切换，从下一个工具调用起生效 */
const CYCLE: Mode[] = ["ask", "auto", "plan"];
function cycleMode() {
  const i = CYCLE.indexOf(settings().mode as Mode);
  setMode(CYCLE[(i + 1) % CYCLE.length]!).catch((err) => screen.log(red(`[error] ${errorText(err)}`)));
}

/**
 * 计划模式下模型给出计划、这一轮正常结束后，问用户是否按计划执行。
 * 用户已经排了别的输入、或者不能交互时不问
 */
async function offerPlan() {
  // 这一轮中途才切到计划模式的，模型并不知道要给计划，不问
  if (settings().mode !== "plan" || announcedMode !== "plan" || view.lastEnd !== "end" || !screen.interactive || queue.length > 0) return;
  const last = rt.state.messages.at(-1);
  if (last?.role !== "assistant" || !last.content.some((b) => b.kind === "text" && b.text.trim())) return;
  const choice = await screen.select("Execute this plan?", [
    { label: "Yes, in auto mode", value: "auto" as const, hint: "edits and safe commands run without asking" },
    { label: "Yes, and ask before each edit", value: "ask" as const, hint: "mode ask" },
    { label: "No, keep planning", value: "plan" as const, hint: "type what to change" },
  ]);
  if (!choice || choice === "plan") return;
  await rememberMode(choice);
  await saveSettings({ ...settings(), mode: choice });
  screen.log(dim(`mode: ${choice}`));
  await say("The plan is approved. Implement it now.");
}
const hostNote = (text: string): Block => ({ kind: "text", text: `[Note from jade] ${text}`, origin: { by: "host" }, trust: "trusted" });

/** 本进程里已经记进会话索引的会话：每个会话每次运行只记一次，索引不随消息数增长 */
const indexed = new Set<string>();

async function say(text: string) {
  if (!indexed.has(sessionId)) {
    indexed.add(sessionId);
    await index.add({ id: sessionId, cwd, title: clip(text.replace(/\s+/g, " "), 80), at: new Date().toISOString() });
  }
  announceMode();
  const content: Block[] = notes.splice(0).map(hostNote);
  content.push({ kind: "text", text, origin: { by: "user" }, trust: "trusted" });
  // @ 引用的文件和目录：内容随消息发出，模型不用再读一遍
  const refs = await attachMentions(text, { cwd, tools: jade.tools, sessionId, signal: AbortSignal.timeout(30_000) });
  for (const f of refs.failed) screen.log(yellow(`[@${f.path} not attached: ${clip(f.reason, 200)}]`));
  if (refs.attached.length) screen.log(dim(`[attached ${refs.attached.map((p) => `@${p}`).join(", ")}]`));
  content.push(...refs.blocks);
  await drive({ kind: "message", content });
  await offerPlan();
  if (view.lastEnd === "end" && queue.length === 0) void suggestNext();
}

/**
 * 正在执行的插件快捷键。同一个键可以同时执行几次（例如按一下开始录音、再按一下结束，第一次的 run 一直等到结束）；
 * 换会话时全部中止，卡住的插件积压的请求也就到此为止
 */
const keyRuns = new Set<AbortController>();

/** 插件的快捷键：找到了就在后台执行，返回 true */
function pluginKey(spec: string): boolean {
  const found = jade.keys.get(spec);
  if (!found) return false;
  const ac = new AbortController();
  keyRuns.add(ac);
  Promise.resolve()
    .then(() => found.key.run({ key: spec, sessionId, signal: ac.signal }))
    .catch((err) => {
      if (!ac.signal.aborted) screen.log(yellow(`[warning] plugin ${found.plugin}: ${spec} failed: ${errorText(err)}`));
    })
    .finally(() => keyRuns.delete(ac));
  return true;
}

/** 中止正在执行的快捷键：它们属于的会话（输入框里的那份草稿、那套插件实例）不在了 */
function abortKeys(reason: string) {
  for (const ac of keyRuns) ac.abort(new Error(reason));
  keyRuns.clear();
}

/** 插件的 ctx.send：和用户在输入框里提交一样，先注明是哪个插件发的 */
function pluginSend(plugin: string, text: string) {
  if (typeof text !== "string" || !text.trim()) return;
  screen.log(dim(`[plugin ${plugin} sent this for you]`));
  if (ready) onSubmit(text);
  else early.push(text);
}

/** 用户输入的消息：先交给插件的 beforeSend（可能改写或不发），再发出 */
async function sendTyped(text: string) {
  for (const { plugin, fn } of jade.beforeSend) {
    try {
      // 插件卡住时不能一直不发：30 秒后按原文发出
      const signal = AbortSignal.timeout(30_000);
      const next = await abortable(Promise.resolve(fn(text, { sessionId, signal })), signal);
      if (next === undefined || next === text) continue;
      if (typeof next !== "string") throw new Error("beforeSend must return a string or undefined");
      if (!next.trim()) return screen.log(dim(`[plugin ${plugin} did not send the message]`));
      screen.log(dim(`[plugin ${plugin} changed the message]`), { details: next });
      text = next;
    } catch (err) {
      screen.log(yellow(`[warning] plugin ${plugin}: beforeSend failed, the message is sent as typed: ${errorText(err)}`));
    }
  }
  await say(text);
}

// ---------- 预测下一条消息 ----------

/** 正在进行的预测；提交新输入、按 Esc、开始新的预测时中止 */
let suggesting: AbortController | undefined;

function clearSuggestion() {
  suggesting?.abort();
  suggesting = undefined;
  screen.suggest(undefined);
}

/** 一轮正常结束后让插件预测用户的下一条消息，显示在输入框里（只在终端界面里） */
async function suggestNext() {
  const s = jade.suggester;
  if (!s || !tui) return;
  clearSuggestion();
  const ac = new AbortController();
  suggesting = ac;
  try {
    const r = s.suggest.next({ sessionId, messages: structuredClone(rt.state.messages) }, ac.signal);
    if (r && typeof (r as AsyncIterable<string>)[Symbol.asyncIterator] === "function") {
      let text = "";
      for await (const part of r as AsyncIterable<string>) {
        if (ac.signal.aborted) return;
        text += part;
        screen.suggest(text);
      }
    } else {
      const text = await r;
      if (!ac.signal.aborted && typeof text === "string") screen.suggest(text);
    }
  } catch (err) {
    if (!ac.signal.aborted) screen.log(yellow(`[warning] plugin ${s.plugin}: suggest failed: ${errorText(err)}`));
  } finally {
    if (suggesting === ac) suggesting = undefined;
  }
}

/** 上一轮在模型回复之前就失败了：最后一条消息还没有回复 */
const canRetry = () => rt.phase === "idle" && rt.state.messages.at(-1)?.role === "user";

async function drive(input: UserInput) {
  // 计时从这次输入开始，不接着上一条排队消息的
  screen.busy(undefined);
  screen.busy("Working");
  view.lastEnd = undefined;
  await guarded(() => rt.send(input));
  // 请求超出了上下文窗口（窗口估大了，或者一次读进来太多）：压缩后重试一次
  if (isContextOverflow(view.lastError ?? lastThrown) && canRetry()) {
    screen.log(
      yellow("[the request exceeded the model's context window; compacting the history and retrying]") +
        (contextWindowInfo().source === "env" ? "" : dim(`\n[jade assumed a ${contextWindow}-token window; set the real one with /model → context window]`)),
    );
    jade.compact?.request();
    await guarded(() => rt.send({ kind: "retry" }));
  }
  // 回复被输出上限截断：让模型接着做，而不是把半截任务丢给用户
  for (let i = 0; i < MAX_CONTINUES && view.lastEnd === "max_tokens"; i++) {
    screen.log(dim(`[asking the model to continue (${i + 1}/${MAX_CONTINUES})]`));
    view.lastEnd = undefined;
    await guarded(() => rt.send({ kind: "message", content: [hostNote(CONTINUE_NOTE)] }));
  }
  await savePendingRules().catch((err) => screen.log(red(`[error] ${errorText(err)}`)));
}

/** 恢复的会话里已有的内容：终端界面里重新显示对话，逐行输出时只统计用量 */
async function replayHistory() {
  await view.replay(await readAll(store, sessionId), tui);
}

/** 恢复会话：先显示之前的对话，处理插件变化（4.6），再继续日志里没做完的工作。插件变化后不能继续时返回 false */
async function resumeSession(): Promise<boolean> {
  await replayHistory();
  const held = rt.state.held;
  if (held) {
    screen.log(yellow(`Plugins changed since this session was last used: ${held.plugins.map((p) => `${p.id}@${p.version}`).join(", ")}`));
    if (held.resolution === "abort") {
      screen.log(red("A plugin requires this session to stop. Restore the previous plugins to continue."));
      return false;
    }
    const ok =
      (await screen.select("Continue with the new plugins? Pending tool calls will be re-checked.", [
        { label: "Yes, continue", value: true },
        { label: "No", value: false },
      ])) ?? false;
    await guarded(() => rt.send({ kind: "plugins", approved: ok }));
    if (!ok) return false;
  }
  await guarded(() => rt.recover());
  // 命令行明确给了 --mode 时覆盖日志里的设置
  if (opts.mode && opts.mode !== settings().mode) await saveSettings({ ...settings(), mode: opts.mode });
  screen.log(dim(`Resumed ${sessionId} (${rt.state.messages.length} messages, mode ${settings().mode})`));
  return true;
}

// ---------- 命令 ----------


const commandWidth = () => Math.max(...ALL_COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length)) + 2;

/** 执行命令；返回 false 表示退出 */
async function command(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "help":
      screen.log(ALL_COMMANDS.map((c) => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(commandWidth())}${dim(c.about)}`).join("\n"));
      screen.log(dim(KEYS));
      if (jade.keys.size)
        screen.log(dim(`Plugin keys: ${[...jade.keys].map(([k, { plugin, key }]) => `${k} ${key.description ?? ""} (${plugin})`.replace("  ", " ")).join(" · ")}`));
      break;
    case "model":
      await configure.model(rest[0]);
      break;
    case "mode": {
      let m = rest[0];
      if (!m) {
        m = await screen.select(
          "Permission mode",
          MODES.map((x) => ({ label: x, value: x, hint: x === settings().mode ? "current" : MODE_HINTS[x] })),
        );
        if (!m) break;
      }
      if (!(MODES as readonly string[]).includes(m)) screen.log(red(`unknown mode ${m}`));
      else await setMode(m as Mode);
      screen.log(`mode: ${settings().mode}${pendingMode ? dim(" (from the next tool call)") : ""}`);
      if (settings().rules.length) screen.log(dim(`always allowed in this session:\n${settings().rules.map((r) => `  ${describeRule(r)}`).join("\n")}`));
      break;
    }
    case "plugins":
      showPlugins();
      break;
    case "exit":
      return false;
    default: {
      const custom = customs.get(cmd!.toLowerCase());
      const skill = skillCommands.get(cmd!.toLowerCase());
      if (!custom && skill) {
        await say(skillMessage(skill.name, input.slice(1).replace(/^\S+\s*/, "")));
        break;
      }
      if (!custom) {
        const text = await pluginCommand(cmd!, input.slice(1).replace(/^\S+\s*/, ""));
        if (text !== undefined) await say(text);
        break;
      }
      const text = expandCommand(custom, input.slice(1).replace(/^\S+\s*/, ""));
      if (!text.trim()) {
        screen.log(red(`/${custom.name} is empty (${display(cwd, custom.file)})`));
        break;
      }
      await say(text);
    }
  }
  return true;
}

const MODE_HINTS: Record<string, string> = {
  ask: "ask before edits and commands",
  auto: "edits in this directory run without asking; other commands are reviewed by the model, risky ones still ask",
  plan: "research read-only and propose a plan; edits start after you approve it",
  yolo: "never ask",
};

// ---------- 输入 ----------

/** 等待执行的输入：运行中提交的消息和需要独占运行时的命令排在这里，按顺序执行 */
const queue: string[] = [];

const echo = view.echo;

function onSubmit(text: string) {
  clearSuggestion();
  const name = text.startsWith("/") ? text.slice(1).split(/\s+/)[0]! : undefined;
  if (name !== undefined && (INSTANT.has(name) || instantPlugin(name))) {
    // 只读命令和 /model 不碰运行时状态，运行中也直接执行
    echo(text);
    if (name === "exit" || name === "quit") return void quit();
    return void command(text).catch((err) => screen.log(red(`[error] ${errorText(err)}`)));
  }
  queue.push(text);
  if (running) screen.queued(queue);
  void pump();
}

/** 解析到的是插件命令（不是同名的自定义命令或 skill），而且它声明了 instant */
function instantPlugin(name: string): boolean {
  const n = name.toLowerCase();
  const found = jade.commands.get(n);
  if (!found?.command.instant) return false;
  if (found.builtin) return true;
  return !hostNames.has(n) && !customs.has(n) && !skillCommands.has(n);
}

async function pump() {
  if (running) return;
  let exit = false;
  await occupy(async () => {
    while (queue.length > 0 && !quitting) {
      // 打断的那一轮已经结束：从现在起再给 SECOND_ESC_MS 的时间按第二次 esc
      if (interruptPending) interruptedAt = Date.now();
      interruptPending = false;
      const text = queue.shift()!;
      screen.queued(queue);
      echo(text);
      if (text.startsWith("/")) {
        try {
          if (!(await command(text))) {
            exit = true;
            return;
          }
        } catch (err) {
          screen.log(red(`[error] ${errorText(err)}`));
        }
      } else await sendTyped(text);
    }
  });
  if (exit) await quit();
}

/**
 * 有新版本时在后台升级，下次启动生效；JADE_AUTO_UPDATE=off 时只提示。
 * 每天最多查一次 npm；仓库里的开发版和 npm link 既不提示也不升级
 */
async function checkForUpdate() {
  const install = detectInstall();
  if (install.kind === "dev") return;
  const latest = await newerVersion(home).catch(() => undefined);
  if (!latest) return;
  const manual = () => screen.log(dim(`[jade ${latest} is available (you have ${VERSION}); run jade update]`));
  if (!autoUpdateEnabled()) return manual();
  const result = await autoUpdate(home, latest, { install }).catch(() => undefined);
  if (result?.status === "installed") screen.log(dim(`[jade ${latest} was installed in the background; restart jade to use it]`));
  else if (result?.status === "failed") screen.log(yellow(`[automatic update to jade ${latest} failed (see ${display(cwd, result.log)}); run jade update]`));
  else if (result?.why !== "busy") manual();
}

// ---------- 开始 ----------

if (resumeId) {
  let ok = false;
  await occupy(async () => void (ok = await resumeSession()));
  if (!ok) {
    await screen.close();
    process.exit(1);
  }
}
else if (tui) screen.log(dim("Type / for commands, /model to configure the model, esc to interrupt."));
else screen.log(dim(`jade · ${shortPath(cwd)} · ${modelLabel()} · mode ${settings().mode} · session ${sessionId}`));
screen.status({ mode: settings().mode, session: sessionId });

const first = opts.print ?? (opts.prompt.length > 0 ? opts.prompt.join(" ") : undefined);
if (tui) {
  // 之后由输入框驱动：onSubmit → pump
  ready = true;
  for (const text of [...(first ? [first] : []), ...early.splice(0)]) onSubmit(text);
  void checkForUpdate();
} else {
  // -p 也能用自定义命令和插件的命令（内置命令需要交互，不在这里处理）
  const name = first?.startsWith("/") ? first.slice(1).split(/\s+/)[0]!.toLowerCase() : undefined;
  const args = first?.slice(1).replace(/^\S+\s*/, "") ?? "";
  const custom = name !== undefined ? customs.get(name) : undefined;
  await occupy(async () => {
    const skill = name !== undefined && !custom ? skillCommands.get(name) : undefined;
    const text = custom ? expandCommand(custom, args) : skill ? skillMessage(skill.name, args) : name !== undefined && !hostNames.has(name) && jade.commands.has(name) && !jade.commands.get(name)!.builtin ? await pluginCommand(name, args) : first;
    if (text) await (name === undefined ? sendTyped(text) : say(text));
  });
  await leave();
  await closePlugins();
  await closeScreen();
}
