// 组装发行版：把工具、提示词、权限、压缩、预算插件拼成一套插件清单。
// 宿主（main.ts）和测试都通过这里创建，内核本身不知道这些插件的存在。

import type { LogStore, Plugin, Provider } from "uncarved";
import { budget } from "./plugins/budget.ts";
import { compactor, type Compactor } from "./plugins/compact.ts";
import { policy, type Mode, type Policy } from "./plugins/policy.ts";
import { prompts } from "./plugins/prompts.ts";
import { fsTools } from "./tools/fs.ts";
import { shellTool } from "./tools/shell.ts";
import { taskTool } from "./tools/task.ts";

const READ_ONLY = new Set(["read_file", "list_dir", "glob", "grep"]);

export interface CoderOptions {
  cwd: string;
  /** 用户层配置目录 */
  home: string;
  store: LogStore;
  provider: Provider;
  mode?: Mode;
  /** 已经通过 loadProjectPlugin 确认过的项目层插件 */
  projectPlugins?: Plugin[];
  compactTokens?: number;
  maxSteps?: number;
  /** 测试用 */
  today?: string;
}

export interface Coder {
  plugins: Plugin[];
  policy: Policy;
  compact: Compactor;
}

export async function createCoder(opts: CoderOptions): Promise<Coder> {
  const { cwd, store, provider } = opts;

  const subagentPlugins = await subagent(opts);
  const tools: Plugin = {
    id: "coder/tools",
    version: "0.1.0",
    kernel: "^0.1",
    tools: [
      ...fsTools(cwd),
      shellTool({ cwd }),
      taskTool({ store, provider, plugins: subagentPlugins }),
    ],
  };
  const extra = opts.projectPlugins ?? [];

  const pol = policy({ cwd, mode: opts.mode });
  const compact = compactor({ provider, thresholdTokens: opts.compactTokens });
  const plugins = [
    tools,
    await prompts({ cwd, home: opts.home, today: opts.today }),
    pol.plugin,
    compact.plugin,
    budget({ maxSteps: opts.maxSteps }),
    ...extra,
  ];
  return { plugins, policy: pol, compact };
}

/** 子 Agent 的插件：只读工具、子 Agent 提示词、只读策略、步数上限。每次调用返回新实例 */
async function subagent(opts: CoderOptions): Promise<() => Plugin[]> {
  const system = await prompts({ cwd: opts.cwd, home: opts.home, role: "subagent", today: opts.today });
  return () => {
    const tools: Plugin = {
      id: "coder/tools-readonly",
      version: "0.1.0",
      kernel: "^0.1",
      tools: fsTools(opts.cwd).filter((t) => READ_ONLY.has(t.name)),
    };
    const pol = policy({ cwd: opts.cwd, mode: "readonly", id: "coder/policy-subagent" });
    return [tools, system, pol.plugin, budget({ maxSteps: 40, id: "coder/budget-subagent" })];
  };
}
