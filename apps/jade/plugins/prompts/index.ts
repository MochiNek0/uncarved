// jade/prompts：在 context.build 里生成系统提示词。其他插件经 prompts@1 往里加段落。

import type { ContentSource, SystemSegment } from "uncarved";
import { definePlugin } from "../../src/api.ts";
import type { Models } from "../models/index.ts";
import { allInstructions, environment, mainPrompt } from "./prompts.ts";

/** prompts@1 */
export interface Prompts {
  /**
   * 往系统提示词里加一段，排在主体、环境信息和指令文件之后，返回撤销函数；调用方的作用域关闭时自动撤销。
   * stable（默认 true）的段落排在 volatile 的前面：会变的段落放在后面，前面的才能命中提示缓存。
   * 项目层插件加的段落标为不可信；untrusted 为 true 时也标为不可信（内容来自外部，例如 MCP 服务的说明、仓库里的 skill）
   */
  add(section: { text: string; stable?: boolean; untrusted?: boolean }): () => void;
}

interface Section {
  plugin: string;
  text: string;
  stable: boolean;
  trusted: boolean;
}

const ID = "jade/prompts";

/** 其他插件加的段落。模块每个进程只加载一次，进程级和会话级共用 */
const sections: Section[] = [];

function segment(text: string, trust: SystemSegment["trust"] = "trusted", stability: SystemSegment["stability"] = "stable", by = ID, source?: ContentSource): SystemSegment {
  return { text, stability, origin: { by: "plugin", id: by, ...(source ? { source } : {}) }, trust };
}

export default definePlugin({
  process(ctx) {
    ctx.provide("prompts@1", (caller): Prompts => ({
      add({ text, stable = true, untrusted = false }) {
        if (typeof text !== "string" || !text) throw new Error("prompts.add: text must be a non-empty string");
        const s: Section = { plugin: caller.plugin, text, stable, trusted: caller.layer !== "project" && untrusted !== true };
        sections.push(s);
        const remove = () => {
          const i = sections.indexOf(s);
          if (i !== -1) sections.splice(i, 1);
        };
        caller.onDispose(remove);
        return remove;
      },
    }));
  },

  async session(ctx) {
    const models = ctx.service<Models>("models@1");
    const [env, instructions] = await Promise.all([environment(ctx.cwd), allInstructions(ctx.home, ctx.cwd)]);
    const fixed = [segment(env), ...instructions.map((i) => segment(i.text, i.trust, "stable", ID, i.source))];

    ctx.kernel.hook({
      kind: "transform",
      point: "context.build",
      fn: (req) => {
        const main = segment(mainPrompt(new Set(req.tools.map((t) => t.name))));
        const model = models?.current();
        // 说成"配置的模型"：服务商的别名、路由背后实际回复的可能是别的模型
        const modelLine = model?.model
          ? [segment(`Jade is configured to use the model "${model.model}" via ${model.via}. If the user asks which model you are, answer with this rather than guessing from your training.`)]
          : [];
        const extra = [...sections.filter((s) => s.stable), ...sections.filter((s) => !s.stable)].map((s) =>
          segment(s.text, s.trusted ? "trusted" : "untrusted", s.stable ? "stable" : "volatile", s.plugin),
        );
        return { ...req, system: [main, ...fixed, ...modelLine, ...extra, ...req.system] };
      },
    });
  },
});
