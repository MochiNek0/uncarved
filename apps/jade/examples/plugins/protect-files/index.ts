// 示例：不让 Agent 改动某些文件。
// 用到 tool.gate（拒绝调用）和 ctx.emit（在界面上提示）。默认导出一个对象，不需要上下文时这样写就够了。

import type { JadePlugin } from "@uncarved/jade";

/** 不允许写入的路径：任意一段路径命中就拒绝 */
const PROTECTED = [/^\.env(\..*)?$/, /\.lock$/, /^package-lock\.json$/, /^\.git$/];

const plugin: JadePlugin = {
  id: "example/protect-files",
  version: "1.0.0",
  kernel: "^0.1",
  needs: ["gate:tool.gate", "log:emit"],
  hooks: [
    {
      kind: "gate",
      point: "tool.gate",
      timeoutMs: 1_000,
      async fn(call, ctx) {
        // 只看会改动文件的工具，并且只看带 path 参数的调用（write_file、edit_file）
        if (call.tool.effect !== "write") return { decision: "abstain" };
        const target = (call.input as { path?: unknown } | null)?.path;
        if (typeof target !== "string") return { decision: "abstain" };
        const hit = target.split(/[\\/]/).find((seg) => PROTECTED.some((re) => re.test(seg)));
        if (!hit) return { decision: "abstain" };
        // emit 一定要 await：hook 返回之后再写会被拒绝
        await ctx.emit("notice", { text: `blocked ${call.name} on ${target}`, level: "warning" });
        // reason 是给模型看的
        return { decision: "deny", reason: `${target} is protected by the project; do not modify it, tell the user what change is needed instead.` };
      },
    },
  ],
};

export default plugin;
