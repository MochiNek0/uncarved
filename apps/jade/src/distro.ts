// 组装发行版：内核之外的功能都是插件。内置插件（见 plugins/builtins.ts）和第三方插件用同一套接口，
// 在这里拼成一份插件清单。宿主（main.ts）和测试都通过这里创建，内核本身不知道这些插件的存在。
//
// 用户可以停用内置插件（$JADE_HOME/plugins.json），第三方插件可以用 replaces 代替内置插件；jade/policy 两者都不行。

import path from "node:path";
import { checkCompat, definePlugin, subsetPlugin, type LogStore, type ModelRequest, type Plugin, type Provider, type Tool } from "uncarved";
import { budget } from "./plugins/budget.ts";
import { BUILTINS, BUILTIN_IDS, REQUIRED_IDS } from "./plugins/builtins.ts";
import { checks as checksPlugin, type ApproveCheck, type Check, type Checks } from "./plugins/checks.ts";
import { checksCommand, compactCommand, mcpCommand, mcpInstructions, memoryCommand, skillsCommand, withCounter, withSystem } from "./plugins/core.ts";
import { Memory, memoryTool } from "./memory.ts";
import { mcpTools, type McpClient } from "./mcp.ts";
import { skillTool, skillsPrompt, type Skill } from "./skills.ts";
import { compactor, type Compactor } from "./plugins/compact.ts";
import { COMMAND_NAME, JADE_VERSION, type HostContext, type JadePlugin, type LoadedPlugin, type PluginCommand, type Responder, type Suggester } from "./plugins/loader.ts";
import { policy, type AllowRule, type Mode, type Policy, type PolicyOptions } from "./plugins/policy.ts";
import { prompts, realPath, repoRoot } from "./plugins/prompts.ts";
import { repeats } from "./plugins/repeats.ts";
import { fsTools } from "./tools/fs.ts";
import { Checkpoints } from "./tools/checkpoint.ts";
import { shellTools } from "./tools/shell.ts";
import { taskTool, type ApproveSubagent, type SubagentControl } from "./tools/task.ts";
import { todoTool } from "./tools/todo.ts";
import { askUserTool, type AskUser } from "./tools/ask.ts";
import { webTools } from "./tools/web.ts";
import { screenshotTool } from "./tools/screenshot.ts";
import { visionFromEnv } from "./provider.ts";

const READ_ONLY = new Set(["read_file", "list_dir", "glob", "grep"]);
/** 子 Agent 也执行的第三方插件 hook */
const TOOL_HOOKS: ReadonlySet<string> = new Set(["tool.gate", "tool.before", "tool.after"]);
/** 子 Agent 一轮最多调用模型的次数（子 Agent 的提示词里写的是同一个数） */
const SUBAGENT_STEPS = 40;

export interface JadeOptions {
  cwd: string;
  /** 用户层配置目录 */
  home: string;
  store: LogStore;
  provider: Provider;
  mode?: Mode;
  /** 已经通过 loadProjectPlugin 确认过的项目层插件，原样加入 */
  projectPlugins?: Plugin[];
  /** 用 loadPlugin 加载的第三方插件（用户层和项目层），每次 createJade 创建一套新实例 */
  extensions?: LoadedPlugin[];
  /** 停用的插件：内置插件的 id，或者第三方插件的 id（第三方插件按目录名停用由宿主在加载前处理） */
  disabled?: Iterable<string>;
  /** 压缩阈值；传函数时每次投影前取值 */
  compactTokens?: number | (() => number);
  maxSteps?: number;
  /** 当前配置的模型，写进主 Agent 的系统提示词（见 prompts 的 model）；每次请求时取 */
  model?: () => { name: string; via: string } | undefined;
  /** 会话的临时目录：写进提示词让模型把临时文件放这里；关卡按工作目录对待，修改前不用先读 */
  scratch?: string;
  /** 测试用 */
  today?: string;
  /** 读取搜索服务配置用，默认 process.env；测试用 */
  env?: Record<string, string | undefined>;
  /** web 工具用的 fetch；测试用 */
  fetch?: typeof fetch;
  /** web 工具解析主机名用；测试用 */
  lookup?: (hostname: string) => Promise<string[]>;
  /** 截图用的浏览器；不给时按 JADE_BROWSER 和常见安装位置找，null 表示不提供截图工具 */
  browser?: string | null;
  /** ask_user 工具向用户提问；不给就不提供这个工具 */
  askUser?: AskUser;
  /** 子 Agent 要用户批准的调用（例如 web_fetch）交给宿主；不给就拒绝 */
  approveSubagent?: ApproveSubagent;
  /** 子 Agent 也遵守的"总是允许"规则（主会话的），每次判断时取 */
  sharedRules?: () => AllowRule[];
  /** 运行中切换、还没记进日志的权限模式（见 PolicyOptions.pendingMode） */
  pendingMode?: () => Mode | undefined;
  /** auto 模式下审查规则判断不了的调用（见 PolicyOptions.review）；不给时 auto 模式不审查 */
  review?: PolicyOptions["review"];
  /**
   * 编辑后检查的命令第一次运行前由宿主确认；不给就不做编辑后检查。
   * 检查会执行仓库里的代码，所以不能默认放行
   */
  approveCheck?: ApproveCheck;
  /** /checks 显示一条检查是否已经确认过 */
  checkConfirmed?: (check: Check) => Promise<boolean>;
  /** 没有 approveCheck 时 /checks 给出的原因 */
  checksUnavailable?: string;
  /** 已连接的 MCP 服务，它们的工具加进主会话（声明只读的也给子 Agent） */
  mcp?: McpClient[];
  /** loadSkills 找到的 skill */
  skills?: Skill[];
  /** 插件用 ctx.status 设置状态栏上自己的那一段；plugin 是插件的目录名，text 为 undefined 时去掉 */
  onStatus?(plugin: string, text: string | undefined): void;
}

export interface BuiltinState {
  id: string;
  about: string;
  required?: boolean;
  /** on：加载了；disabled：用户停用；replaced：被第三方插件代替 */
  state: "on" | "disabled" | "replaced";
  /** 代替它的插件 */
  by?: string;
}

export interface Jade {
  plugins: Plugin[];
  policy: Policy;
  /** jade/compact 停用或被代替时没有 */
  compact?: Compactor;
  /** write_file / edit_file 写入前的快照，供 /undo */
  checkpoints: Checkpoints;
  /** 跨会话的记忆；jade/memory 停用或被代替时没有 */
  memory?: Memory;
  /** 编辑后检查；没有 shell、宿主没给 approveCheck、jade/checks 停用时为 undefined */
  checks?: Checks;
  /** 每个内置插件的状态 */
  builtins: BuiltinState[];
  /** 成功加入本会话的第三方插件实例 */
  extensions: { source: LoadedPlugin; plugin: JadePlugin }[];
  /** 插件（内置的和第三方的）提供的斜杠命令，按小写的名字 */
  commands: Map<string, { plugin: string; command: PluginCommand; builtin: boolean }>;
  /** 用户层第三方插件提供的 responder，宿主问用户时和终端一起等 */
  responders: { plugin: string; responder: Responder }[];
  /** 预测下一条消息的插件（只用第一个提供 suggest 的） */
  suggester?: { plugin: string; suggest: Suggester };
  /** 用户消息发出前依次处理它的插件 */
  beforeSend: { plugin: string; fn: NonNullable<JadePlugin["beforeSend"]> }[];
  /** 主会话的工具；宿主用 read_file / list_dir 读取 @ 引用的文件 */
  tools: Tool[];
  /** 宿主退出时调用：杀掉后台 shell */
  shutdown(): void;
  /** 启动时要告诉用户的问题，例如找不到 shell */
  warnings: string[];
}

export async function createJade(opts: JadeOptions): Promise<Jade> {
  const { cwd, store, provider } = opts;
  const skills = opts.skills ?? [];
  const mcp = opts.mcp ?? [];
  const warnings: string[] = [];

  const disabled = new Set(opts.disabled ?? []);
  for (const id of REQUIRED_IDS) {
    if (disabled.has(id)) {
      warnings.push(`${id} cannot be disabled (it decides which tool calls need your approval); it stays on`);
      disabled.delete(id);
    }
  }
  const off = (id: string) => disabled.has(id);

  const checkpoints = new Checkpoints(path.join(opts.home, "checkpoints"));
  // run 也给插件和编辑后检查用，所以 jade/shell 停用时也创建，只是不把工具交给模型
  const shell = shellTools({ cwd });
  const root = await repoRoot(cwd);
  const host: HostContext = { jade: JADE_VERSION, cwd: realPath(cwd), root: realPath(root), home: opts.home, definePlugin, run: shell.run, complete: completer(provider), status: (plugin, text) => opts.onStatus?.(plugin, text) };

  // 第三方插件先创建：要先知道它们代替哪些内置插件
  const made = await createExtensions(opts.extensions ?? [], host, disabled, warnings);

  // ---------- 内置插件（jade/prompts 最后创建：它要知道最终有哪些工具） ----------
  const built = new Map<string, JadePlugin>();
  const add = (p: JadePlugin) => built.set(p.id, p);

  const pol = policy({ cwd, mode: opts.mode, pendingMode: opts.pendingMode, review: opts.review, readRoots: off("jade/skills") ? [] : skills.map((x) => x.dir), scratch: opts.scratch });
  add(pol.plugin);
  // 占位，组装完成后换成真正的提示词插件
  if (!off("jade/prompts")) add({ id: "jade/prompts", version: "0.3.0", kernel: "^0.1" });

  // 文件工具据此判断读取和修改是不是同一次回复里发出的
  const responses = { calls: 0 };
  if (!off("jade/fs")) add(withCounter({ id: "jade/fs", version: "0.1.0", kernel: "^0.1", tools: fsTools(cwd, { checkpoints, responses, scratch: opts.scratch }) }, responses));
  if (!off("jade/shell")) add({ id: "jade/shell", version: "0.1.0", kernel: "^0.1", tools: shell.tools });
  let web: Tool[] = [];
  let hasScreenshot = false;
  if (!off("jade/web")) {
    try {
      web = webTools({ env: opts.env, fetch: opts.fetch, lookup: opts.lookup }).tools;
    } catch (err) {
      warnings.push(`web tools are disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 截图只在模型能看图片时有用，否则截图到了模型那里只剩占位说明。/model 运行中会换模型、改 JADE_VISION，
    // 所以找到浏览器就注册，每次请求前按当时的设置决定发不发给模型，不用重启
    const canSee = () => {
      try {
        return visionFromEnv(opts.env ?? process.env);
      } catch {
        // 写错的 JADE_VISION 在创建 provider 时报错
        return false;
      }
    };
    const shot = opts.browser !== null ? screenshotTool({ cwd, browser: opts.browser, env: opts.env, available: canSee }) : undefined;
    hasScreenshot = shot !== undefined;
    add({
      id: "jade/web",
      version: "0.2.0",
      kernel: "^0.1",
      tools: shot ? [...web, shot] : web,
      ...(shot
        ? {
            needs: ["transform:context.build"],
            hooks: [
              {
                kind: "transform",
                point: "context.build",
                fn: (req: ModelRequest) => (canSee() ? req : { ...req, tools: req.tools.filter((t) => t.name !== shot.name) }),
              },
            ],
          }
        : {}),
    });
  }
  if (!off("jade/todo")) add({ id: "jade/todo", version: "0.1.0", kernel: "^0.1", tools: [todoTool()] });
  if (!off("jade/ask") && opts.askUser) add({ id: "jade/ask", version: "0.1.0", kernel: "^0.1", tools: [askUserTool(opts.askUser)] });

  let memory: Memory | undefined;
  if (!off("jade/memory")) {
    memory = new Memory(opts.home, root);
    const text = await memory.prompt();
    add(withSystem({ id: "jade/memory", version: "0.1.0", kernel: "^0.1", tools: [memoryTool(memory)], commands: [memoryCommand(memory)] }, text ? [{ text, trust: "trusted" }] : []));
  }

  /** 最终加载了的内置插件，子 Agent 据此决定给哪些工具；组装完成后才填上 */
  const kept = new Set<string>();
  /** 子 Agent 的提示词，组装完成后生成 */
  const subSystem: { plugin?: Plugin } = {};
  /** 第三方插件（项目层和用户层），组装完成后填上 */
  let thirdParty: Plugin[] = [];
  if (!off("jade/task")) {
    const subagentPlugins = subagent(opts, subSystem, () => ({
      fs: kept.has("jade/fs"),
      web: kept.has("jade/web") ? web : [],
      mcp: kept.has("jade/mcp") ? mcp : [],
      extensions: thirdParty,
    }));
    add({ id: "jade/task", version: "0.1.0", kernel: "^0.1", tools: [taskTool({ store, provider, plugins: subagentPlugins, approve: opts.approveSubagent })] });
  }

  if (!off("jade/skills")) {
    const list = skillsPrompt(skills);
    // 有随仓库分发的 skill 时这段是 untrusted
    const trust = skills.every((x) => x.layer === "user") ? "trusted" : "untrusted";
    add(
      withSystem(
        { id: "jade/skills", version: "0.1.0", kernel: "^0.1", tools: skills.length ? [skillTool(skills)] : [], commands: [skillsCommand(skills, { cwd, home: opts.home })] },
        list ? [{ text: list, trust }] : [],
      ),
    );
  }
  if (!off("jade/mcp")) {
    add(withSystem({ id: "jade/mcp", version: "0.1.0", kernel: "^0.1", tools: mcpTools(mcp), commands: [mcpCommand(mcp, { cwd, home: opts.home })] }, mcpInstructions(mcp)));
  }

  let checks: Checks | undefined;
  if (!off("jade/checks")) {
    checks =
      shell.run && opts.approveCheck
        ? checksPlugin({ cwd: realPath(cwd), root: realPath(root), home: opts.home, run: shell.run, approve: opts.approveCheck })
        : undefined;
    const command = checksCommand(checks, {
      cwd,
      home: opts.home,
      changed: async (sessionId) => [...new Set((await checkpoints.list(sessionId)).map((c) => c.path))],
      confirmed: opts.checkConfirmed,
      unavailable: opts.checksUnavailable ?? (shell.run ? "Edit-time checks are turned off." : "Edit-time checks need a shell; see the warning at startup."),
    });
    add(checks ? { ...checks.plugin, commands: [command] } : { id: "jade/checks", version: "0.1.0", kernel: "^0.1", commands: [command] });
  }
  let compact: Compactor | undefined;
  if (!off("jade/compact")) {
    compact = compactor({ provider, thresholdTokens: opts.compactTokens });
    add({ ...compact.plugin, commands: [compactCommand(compact)] });
  }
  if (!off("jade/budget")) add(budget({ maxSteps: opts.maxSteps }));
  if (!off("jade/repeats")) {
    // 自己数回复次数：不依赖 jade/fs 是否加载
    const own = { calls: 0 };
    add(withCounter(repeats({ responses: own, cwd }), own));
  }

  // ---------- 代替关系：被代替的内置插件让位，代替者的工具名可以和它重复 ----------
  const claims = (p: JadePlugin) => (p.replaces ?? []).filter((id) => BUILTIN_IDS.has(id) && !REQUIRED_IDS.has(id) && built.has(id));
  for (const { source, plugin } of made) {
    for (const id of plugin.replaces ?? []) {
      if (REQUIRED_IDS.has(id)) warnings.push(`plugin ${plugin.id} (${source.layer}): cannot replace ${id}; add a gate hook to make approvals stricter instead`);
      else if (!BUILTIN_IDS.has(id)) warnings.push(`plugin ${plugin.id} (${source.layer}): replaces unknown built-in plugin ${id}`);
    }
  }
  // 从"全部声明都生效"开始；被拒绝的插件声明的代替撤销，内置插件回来之后可能又拒绝别的插件，直到不再变化
  let replaced = new Set(made.flatMap((m) => claims(m.plugin)));
  let result: ReturnType<typeof accept>;
  for (;;) {
    result = accept(made, [...built.values()].filter((p) => !replaced.has(p.id)));
    const next = new Set(result.accepted.flatMap((m) => claims(m.plugin)));
    if (next.size === replaced.size) break;
    replaced = next;
  }
  warnings.push(...result.rejected);
  const added = result.accepted;
  const builtin = [...built.values()].filter((p) => !replaced.has(p.id));
  for (const p of builtin) kept.add(p.id);

  const allTools = [...builtin, ...added.map((a) => a.plugin)].flatMap((p) => p.tools ?? []);
  const toolNames = new Set(allTools.map((t) => t.name));
  const webNames = kept.has("jade/web") ? web.map((t) => t.name) : [];
  const at = builtin.findIndex((p) => p.id === "jade/prompts");
  // 子 Agent 的提示词和主 Agent 的同时生成：两者都要跑几个 git 命令
  const subPrompts = kept.has("jade/task") ? prompts({ cwd, home: opts.home, role: "subagent", today: opts.today, web: webNames }) : undefined;
  if (at >= 0) {
    builtin[at] = await prompts({
      cwd,
      home: opts.home,
      today: opts.today,
      // bash 由别的插件提供时不知道它用什么 shell，不写
      shell: toolNames.has("bash") ? (kept.has("jade/shell") ? (shell.executable ?? null) : undefined) : null,
      web: webNames,
      screenshot: hasScreenshot,
      checks: kept.has("jade/checks") && Boolean(checks),
      scratch: opts.scratch,
      tools: toolNames,
      model: opts.model,
    });
  }
  if (subPrompts) subSystem.plugin = await subPrompts;

  const builtins: BuiltinState[] = BUILTINS.map((b) => {
    if (kept.has(b.id)) return { ...b, state: "on" as const };
    const by = added.find((a) => claims(a.plugin).includes(b.id))?.plugin.id;
    return by ? { ...b, state: "replaced" as const, by } : { ...b, state: "disabled" as const };
  });

  thirdParty = [...(opts.projectPlugins ?? []), ...added.map((a) => a.plugin)];
  const suggesters = added.flatMap(({ plugin }) => (plugin.suggest ? [{ plugin: plugin.id, suggest: plugin.suggest }] : []));
  for (const extra of suggesters.slice(1)) warnings.push(`plugin ${extra.plugin}: suggest is ignored: plugin ${suggesters[0]!.plugin} already provides it`);
  const plugins = [...builtin, ...thirdParty];
  const commands = new Map<string, { plugin: string; command: PluginCommand; builtin: boolean }>();
  for (const p of [...builtin, ...added.map((a) => a.plugin)] as JadePlugin[]) {
    const isBuiltin = BUILTIN_IDS.has(p.id) && builtin.includes(p);
    for (const c of p.commands ?? []) {
      const taken = commands.get(c.name.toLowerCase());
      if (taken) warnings.push(`plugin ${p.id}: command /${c.name} is ignored: plugin ${taken.plugin} already provides it`);
      else commands.set(c.name.toLowerCase(), { plugin: p.id, command: c, builtin: isBuiltin });
    }
  }
  if (shell.unavailable && kept.has("jade/shell")) warnings.push(shell.unavailable);
  return {
    plugins,
    policy: pol,
    compact: kept.has("jade/compact") ? compact : undefined,
    checkpoints,
    memory: kept.has("jade/memory") ? memory : undefined,
    checks: kept.has("jade/checks") ? checks : undefined,
    builtins,
    extensions: added,
    commands,
    responders: added.flatMap(({ plugin }) => (plugin.responder ? [{ plugin: plugin.id, responder: plugin.responder }] : [])),
    suggester: suggesters[0],
    beforeSend: added.flatMap(({ plugin }) => (plugin.beforeSend ? [{ plugin: plugin.id, fn: plugin.beforeSend.bind(plugin) }] : [])),
    tools: allTools,
    shutdown: shell.shutdown,
    warnings,
  };
}

/**
 * 创建第三方插件的实例。有问题的插件跳过并给出警告，而不是让整个 jade 起不来：工厂出错、内核不兼容、命令格式不对。
 * 只带内容（skills、命令、MCP 配置）的插件没有实例，由宿主处理
 */
async function createExtensions(sources: LoadedPlugin[], host: HostContext, disabled: Set<string>, warnings: string[]) {
  const out: { source: LoadedPlugin; plugin: JadePlugin }[] = [];
  for (const source of sources) {
    if (!source.create) continue;
    const where = `plugin ${source.name} (${source.layer})`;
    let plugin: JadePlugin;
    try {
      plugin = await source.create(host);
      checkCompat(plugin);
    } catch (err) {
      warnings.push(`${where} is skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (disabled.has(plugin.id)) continue;
    if (plugin.replaces !== undefined && !(Array.isArray(plugin.replaces) && plugin.replaces.every((x) => typeof x === "string"))) {
      warnings.push(`${where} is skipped: "replaces" must be an array of plugin ids`);
      continue;
    }
    const commands = (plugin.commands ?? []).filter((c) => {
      const ok = c && typeof c.name === "string" && COMMAND_NAME.test(c.name) && typeof c.run === "function";
      if (!ok) warnings.push(`${where}: command ${JSON.stringify(c?.name)} is ignored: it needs a name of letters, digits, - and _, and a run function`);
      return ok;
    });
    // 原地修改而不是复制：内核只认加载器返回的那个项目层插件对象（宪法 7.1）
    if (plugin.commands) plugin.commands = commands;
    if (plugin.responder !== undefined) {
      const r = plugin.responder as Partial<Record<string, unknown>> | null;
      const ok = typeof r === "object" && r !== null && ["approve", "ask"].every((k) => r[k] === undefined || typeof r[k] === "function");
      // 项目层插件随仓库来，不能替用户批准它自己要做的事
      if (source.layer === "project") warnings.push(`${where}: responder is ignored: only user plugins can answer approvals`);
      else if (!ok) warnings.push(`${where}: responder is ignored: approve and ask must be functions`);
      if (source.layer === "project" || !ok) delete plugin.responder;
    }
    if (plugin.beforeSend !== undefined && typeof plugin.beforeSend !== "function") {
      warnings.push(`${where}: beforeSend is ignored: it must be a function`);
      delete plugin.beforeSend;
    }
    if (plugin.suggest !== undefined && typeof (plugin.suggest as { next?: unknown } | null)?.next !== "function") {
      warnings.push(`${where}: suggest is ignored: it needs a next function`);
      delete plugin.suggest;
    }
    out.push({ source, plugin });
  }
  return out;
}

/** 按顺序检查第三方插件的 id 和工具名不和已有的（留下的内置插件、排在前面的第三方插件）重复 */
function accept(made: { source: LoadedPlugin; plugin: JadePlugin }[], existing: Plugin[]) {
  const ids = new Set(existing.map((p) => p.id));
  const toolNames = new Set(existing.flatMap((p) => (p.tools ?? []).map((t) => t.name)));
  const accepted: typeof made = [];
  const rejected: string[] = [];
  for (const m of made) {
    const where = `plugin ${m.source.name} (${m.source.layer})`;
    if (ids.has(m.plugin.id)) {
      rejected.push(`${where} is skipped: another plugin already has the id ${m.plugin.id}`);
      continue;
    }
    const clash = (m.plugin.tools ?? []).find((t) => toolNames.has(t.name));
    if (clash) {
      rejected.push(`${where} is skipped: tool ${clash.name} already exists`);
      continue;
    }
    ids.add(m.plugin.id);
    for (const t of m.plugin.tools ?? []) toolNames.add(t.name);
    accepted.push(m);
  }
  return { accepted, rejected };
}

/** 子 Agent 的插件：只读工具（含 web 工具）、子 Agent 提示词、只读策略（加上主会话的规则）、压缩、步数上限。每次调用返回新实例 */
function subagent(
  opts: JadeOptions,
  system: { plugin?: Plugin },
  available: () => { fs: boolean; web: Tool[]; mcp: McpClient[]; extensions: Plugin[] },
): (control: SubagentControl) => Plugin[] {
  // 有哪些工具要到组装完成才知道，所以每次调用时再取
  return (control) => {
    const { fs, web, mcp, extensions } = available();
    const tools: Plugin = {
      id: "jade/tools-readonly",
      version: "0.1.0",
      kernel: "^0.1",
      tools: [...(fs ? fsTools(opts.cwd).filter((t) => READ_ONLY.has(t.name)) : []), ...web, ...mcpTools(mcp, { readOnly: true })],
    };
    const pol = policy({ cwd: opts.cwd, mode: "readonly", id: "jade/policy-subagent", rules: opts.sharedRules });
    // 大范围调研时读的文件多：没有压缩会撑爆上下文，前面的调研全部白做
    const compact = compactor({ provider: opts.provider, thresholdTokens: opts.compactTokens, id: "jade/compact-subagent" }).plugin;
    const steps = budget({ maxSteps: () => (control.wrapUp ? 1 : SUBAGENT_STEPS), id: "jade/budget-subagent" });
    // 第三方插件只带工具级的 hook（拦截、改写参数、给结果脱敏），子 Agent 读到的内容也经过它们；
    // 不带它们的工具、提示词和 observe hook（例如按轮次触发的功能不该被子 Agent 触发）
    const tooling = extensions
      .map((p) => subsetPlugin(p, { tools: () => false, hooks: (h) => TOOL_HOOKS.has(h.point) }))
      .filter((p) => p.hooks?.length);
    return [tools, ...(system.plugin ? [system.plugin] : []), pol.plugin, compact, steps, ...tooling];
  };
}

/** 插件上下文的 complete：用会话的 provider 发一次不带工具的请求 */
function completer(provider: Provider): HostContext["complete"] {
  const origin = { by: "plugin", id: "jade/extension" } as const;
  return async (req, signal) => {
    const res = await provider.complete(
      {
        system: req.system ? [{ text: req.system, stability: "stable", origin, trust: "trusted" }] : [],
        messages: [{ role: "user", content: [{ kind: "text", text: req.prompt, origin, trust: "untrusted" }] }],
        tools: [],
      },
      { signal, onDelta: req.onText && ((d) => void (d.kind === "text" && req.onText!(d.text))) },
    );
    return { text: res.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join(""), model: res.model, usage: res.usage };
  };
}
