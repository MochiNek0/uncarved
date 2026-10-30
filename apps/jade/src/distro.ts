// 组装发行版：把工具、提示词、权限、压缩、预算插件拼成一套插件清单。
// 宿主（main.ts）和测试都通过这里创建，内核本身不知道这些插件的存在。

import path from "node:path";
import type { LogStore, Plugin, Provider, Tool } from "uncarved";
import { budget } from "./plugins/budget.ts";
import { compactor, type Compactor } from "./plugins/compact.ts";
import { policy, type Mode, type Policy } from "./plugins/policy.ts";
import { prompts } from "./plugins/prompts.ts";
import { repeats } from "./plugins/repeats.ts";
import { fsTools } from "./tools/fs.ts";
import { Checkpoints } from "./tools/checkpoint.ts";
import { shellTools } from "./tools/shell.ts";
import { taskTool } from "./tools/task.ts";
import { todoTool } from "./tools/todo.ts";
import { webTools } from "./tools/web.ts";

const READ_ONLY = new Set(["read_file", "list_dir", "glob", "grep"]);

export interface JadeOptions {
  cwd: string;
  /** 用户层配置目录 */
  home: string;
  store: LogStore;
  provider: Provider;
  mode?: Mode;
  /** 已经通过 loadProjectPlugin 确认过的项目层插件 */
  projectPlugins?: Plugin[];
  /** 压缩阈值；传函数时每次投影前取值 */
  compactTokens?: number | (() => number);
  maxSteps?: number;
  /** 测试用 */
  today?: string;
  /** 读取搜索服务配置用，默认 process.env；测试用 */
  env?: Record<string, string | undefined>;
  /** web 工具用的 fetch；测试用 */
  fetch?: typeof fetch;
}

export interface Jade {
  plugins: Plugin[];
  policy: Policy;
  compact: Compactor;
  /** write_file / edit_file 写入前的快照，供 /undo */
  checkpoints: Checkpoints;
  /** 宿主退出时调用：杀掉后台 shell */
  shutdown(): void;
  /** 启动时要告诉用户的问题，例如找不到 shell */
  warnings: string[];
}

export async function createJade(opts: JadeOptions): Promise<Jade> {
  const { cwd, store, provider } = opts;

  const warnings: string[] = [];
  let web: Tool[] = [];
  try {
    web = webTools({ env: opts.env, fetch: opts.fetch }).tools;
  } catch (err) {
    warnings.push(`web tools are disabled: ${err instanceof Error ? err.message : String(err)}`);
  }
  const subagentPlugins = await subagent(opts, web);
  const checkpoints = new Checkpoints(path.join(opts.home, "checkpoints"));
  const shell = shellTools({ cwd });
  // 文件工具据此判断读取和修改是不是同一次回复里发出的
  const responses = { calls: 0 };
  const tools: Plugin = {
    id: "jade/tools",
    version: "0.2.0",
    kernel: "^0.1",
    needs: ["transform:model.before"],
    hooks: [
      {
        kind: "transform",
        point: "model.before",
        fn: () => {
          responses.calls++;
        },
      },
    ],
    tools: [
      ...fsTools(cwd, { checkpoints, responses }),
      ...shell.tools,
      ...web,
      todoTool(),
      taskTool({ store, provider, plugins: subagentPlugins }),
    ],
  };
  const extra = opts.projectPlugins ?? [];

  const pol = policy({ cwd, mode: opts.mode });
  const compact = compactor({ provider, thresholdTokens: opts.compactTokens });
  const plugins = [
    tools,
    await prompts({ cwd, home: opts.home, today: opts.today, shell: shell.executable ?? null, web: web.map((t) => t.name) }),
    pol.plugin,
    compact.plugin,
    budget({ maxSteps: opts.maxSteps }),
    repeats({ responses }),
    ...extra,
  ];
  if (shell.unavailable) warnings.push(shell.unavailable);
  return { plugins, policy: pol, compact, checkpoints, shutdown: shell.shutdown, warnings };
}

/** 子 Agent 的插件：只读工具（含 web 工具）、子 Agent 提示词、只读策略、步数上限。每次调用返回新实例 */
async function subagent(opts: JadeOptions, web: Tool[]): Promise<() => Plugin[]> {
  const system = await prompts({ cwd: opts.cwd, home: opts.home, role: "subagent", today: opts.today, web: web.map((t) => t.name) });
  return () => {
    const tools: Plugin = {
      id: "jade/tools-readonly",
      version: "0.1.0",
      kernel: "^0.1",
      tools: [...fsTools(opts.cwd).filter((t) => READ_ONLY.has(t.name)), ...web],
    };
    const pol = policy({ cwd: opts.cwd, mode: "readonly", id: "jade/policy-subagent" });
    return [tools, system, pol.plugin, budget({ maxSteps: 40, id: "jade/budget-subagent" })];
  };
}
