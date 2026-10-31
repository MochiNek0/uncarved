// 示例：给模型一个 git_diff 工具，再加两个斜杠命令。
// 默认导出工厂函数：jade 每个会话调用一次，传入工作目录、执行命令的 run 等上下文。
// 用 ctx.definePlugin 补上 kernel 和 needs，不用 import uncarved（项目层插件通常 import 不到它）。

import type { JadePluginFactory } from "@uncarved/jade";

const factory: JadePluginFactory = ({ cwd, run, definePlugin }) => {
  /** 在工作目录执行 git，返回输出；失败时抛错 */
  async function git(args: string, signal?: AbortSignal): Promise<string> {
    if (!run) throw new Error("no shell available");
    const r = await run(`git ${args}`, { cwd, timeoutMs: 30_000, signal });
    if (r.code !== 0) throw new Error(r.output.trim() || `git ${args} failed`);
    return r.output;
  }

  return definePlugin({
    id: "example/git-review",
    version: "1.0.0",
    tools: [
      {
        name: "git_diff",
        description: "Show uncommitted changes in the repository as a unified diff. Set staged to true to show only staged changes.",
        inputSchema: {
          type: "object",
          properties: { staged: { type: "boolean", description: "only staged changes" } },
          additionalProperties: false,
        },
        // read：只读，ask 模式下也不用问；safe：可以和其他只读工具并发
        effect: "read",
        concurrency: "safe",
        idempotent: true,
        async execute(input, ctx) {
          const staged = (input as { staged?: boolean } | null)?.staged === true;
          try {
            const diff = await git(`diff --no-color${staged ? " --staged" : ""}`, ctx.signal);
            return { content: diff.trim() ? diff : "(no changes)" };
          } catch (err) {
            return { content: err instanceof Error ? err.message : String(err), isError: true };
          }
        },
      },
    ],
    commands: [
      {
        name: "review",
        args: "[focus]",
        description: "ask the agent to review the uncommitted changes",
        // 返回 { prompt }：作为用户消息发给模型
        run: (focus) => ({
          prompt: `Review my uncommitted changes (use git_diff). Point out bugs first, then simplifications.${focus ? ` Focus on: ${focus}.` : ""}`,
        }),
      },
      {
        name: "branch",
        description: "show the current branch and the last commit",
        // 返回字符串：直接显示给用户，不发给模型
        run: async (_args, ctx) => (await git("log -1 --format=%D%n%h%x20%s", ctx.signal)).trim(),
      },
    ],
  });
};

export default factory;
