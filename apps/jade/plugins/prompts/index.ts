// jade/prompts：在 context.build 里生成系统提示词。其他插件经 prompts@1 往里加段落。
// 也负责内核不写的、给模型看的说明：内容为空的错误工具结果在投影里补一句原因（results.ts）；
// 其他插件经 prompts@1 的 note 给模型留一句说明（notes.ts）。

import path from "node:path";
import type { ContentSource, LogEvent, SystemSegment } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Models } from "../models/index.ts";
import { Notes } from "./notes.ts";
import { allInstructions, environment, mainPrompt, realPath } from "./prompts.ts";
import { explainEmptyResults, whyEmpty, type Reasons, type Why } from "./results.ts";

/** prompts@1 */
export interface Prompts {
  /**
   * 往系统提示词里加一段，排在主体、环境信息和指令文件之后，返回撤销函数；调用方的作用域关闭时自动撤销。
   * stable（默认 true）的段落排在 volatile 的前面：会变的段落放在后面，前面的才能命中提示缓存。
   * 项目层插件加的段落标为不可信；untrusted 为 true 时也标为不可信（内容来自外部，例如 MCP 服务的说明、仓库里的 skill）
   */
  add(section: { text: string; stable?: boolean; untrusted?: boolean }): () => void;
  /**
   * 给模型留一句说明：下一次请求模型时以 "[Note from jade] …" 附在那个会话最后一条用户消息后面，并记进日志，
   * 之后的请求、恢复的会话里它都在同一个位置。用在命令里做了模型该知道的事（例如用户撤销了它改的文件）、
   * 又不该替用户发一条消息的时候。不发起新的一轮；会话没有再请求模型就关闭时，说明丢掉。
   * 项目层插件留的说明标为不可信
   */
  note(session: string, text: string): void;
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
/** 其他插件留给模型的说明 */
const notes = new Notes();

function segment(text: string, trust: SystemSegment["trust"] = "trusted", stability: SystemSegment["stability"] = "stable", by = ID, source?: ContentSource): SystemSegment {
  return { text, stability, origin: { by: "plugin", id: by, ...(source ? { source } : {}) }, trust };
}

/** 工作目录里的显示成相对路径，外面的显示绝对路径 */
function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
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
      note(session, text) {
        if (typeof session !== "string" || !session) throw new Error("prompts.note: session must be a session id");
        if (typeof text !== "string" || !text) throw new Error("prompts.note: text must be a non-empty string");
        notes.add(session, { plugin: caller.plugin, text, trusted: caller.layer !== "project" });
      },
    }));
  },

  async session(ctx) {
    const models = ctx.service<Models>("models@1");
    const [env, instructions] = await Promise.all([environment(ctx.cwd), allInstructions(ctx.home, ctx.cwd)]);
    const fixed = [segment(env), ...instructions.map((i) => segment(i.text, i.trust, "stable", ID, i.source))];
    // 告诉用户读了哪些指令文件，否则看不出它们生效了
    if (instructions.length > 0) ctx.service<UI>("ui@1")?.notify(`loaded instructions: ${instructions.map((i) => display(realPath(ctx.cwd), i.file)).join(", ")}`);

    // 内容为空的错误工具结果补上说明（results.ts）。原因记在 derived 里；同一批里可能有几个，
    // observe 并发执行、拿到的 derived 快照可能是旧的，所以在这里累积，每次记完整的一份。
    // 运行时不等 observe：紧接着的模型调用投影时记录可能还没落盘，所以投影也看这份累积的。
    // observe 在事件写入时就（以微任务）开始执行，早于之后的投影；下一轮之前记录一定已落盘，恢复会话时从 derived 读，
    // 所以投影只取决于日志，每次相同
    const reasonsKey = `${ID}/empty-results`;
    let reasons: Record<string, Why> | undefined;
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e: LogEvent, hook) => {
        const found = whyEmpty(e);
        if (!found) return;
        reasons ??= { ...((hook.derived[reasonsKey] as Reasons | undefined) ?? {}) };
        reasons[found.toolUseId] = found.why;
        await hook.record(reasonsKey, { ...reasons });
      },
    });
    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // 出错时跳过（不补说明），不让这一轮失败
      optional: true,
      fn: (messages, hook) => explainEmptyResults(messages, { ...(hook.derived[reasonsKey] as Reasons | undefined), ...reasons }, ID),
    });

    ctx.kernel.hook(notes.hook(ctx.session.id, `${ID}/notes`));
    await ctx.effect(() => () => notes.drop(ctx.session.id));

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
