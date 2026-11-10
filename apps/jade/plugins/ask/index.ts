// jade/ask：ask_user 工具。模型拿不准、而答案会改变它要做的事时，先问用户再动手。
//
// 每个问题给几个选项让用户选，也可以自己输入回答。对话框经 ui@1，不再由宿主私下传入。
// 前端不能提问（-p、非终端）时不提供这个工具，提示词里也就不会提到它（jade/prompts 按工具是否存在取舍）。
// 从旧 jade 的 tools/ask.ts 和 main.ts 的 askUser 移植。

import type { Tool } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Renderers, ToolRenderer } from "@uncarved/jade-api/services";

export interface Question {
  question: string;
  options: { label: string; description?: string }[];
}

/** 问用户：每个问题一个回答；用户取消时返回 undefined */
export type AskUser = (questions: Question[], signal: AbortSignal) => Promise<string[] | undefined>;

const MAX_QUESTIONS = 4;
/** 选项的值是序号，"其他" 的值不会和它重复 */
const OTHER = "other";

export const DISMISSED =
  "The user dismissed the questions without answering. Do not ask again: proceed with your best judgment and state your assumptions, or end your turn.";

/** 回到上一个问题 */
const BACK = "back";

/**
 * 用 ui@1 逐个问题让用户选一项，或者选"其他"自己输入。第二个问题起可以回到上一个问题改答案（已经答过的选项标着）；
 * 自己输入时取消回到这个问题的选项。选项对话框取消就算没有回答。signal 中止时抛出
 */
export function askVia(ui: UI): AskUser {
  return async (questions, signal) => {
    if (!ui.interactive) return undefined;
    const answers: string[] = [];
    let i = 0;
    while (i < questions.length) {
      const q = questions[i]!;
      const previous = answers[i];
      const typed = previous !== undefined && !q.options.some((o) => o.label === previous) ? previous : undefined;
      const hint = (description: string | undefined, chosen: boolean) => {
        const text = [description, chosen ? "your answer" : undefined].filter(Boolean).join(" · ");
        return text ? { hint: text } : {};
      };
      const title = questions.length > 1 ? `${q.question} (${i + 1}/${questions.length})` : q.question;
      const choice = await ui.select(
        {
          title,
          options: [
            ...q.options.map((o, k) => ({ label: o.label, value: String(k), ...hint(o.description, o.label === previous) })),
            { label: "Other (type your answer)", value: OTHER, ...(typed ? { hint: `your answer: ${typed}` } : {}) },
            ...(i > 0 ? [{ label: "← Previous question", value: BACK }] : []),
          ],
        },
        signal,
      );
      signal.throwIfAborted();
      if (choice === undefined) return undefined;
      if (choice === BACK) {
        i--;
        continue;
      }
      const answer = choice === OTHER ? (await ui.input({ title: q.question, ...(typed ? { initial: typed } : {}) }, signal))?.trim() : q.options[Number(choice)]?.label;
      signal.throwIfAborted();
      // 自己输入时取消或什么都没写：回到这个问题重新选
      if (!answer) continue;
      answers[i] = answer;
      i++;
    }
    return answers;
  };
}

export function askUserTool(ask: AskUser): Tool {
  return {
    name: "ask_user",
    description:
      "Ask the user one to four questions and wait for the answers. Use it before starting work when the request is ambiguous in a way that changes what you would do " +
      "(scope, approach, a trade-off or preference only the user can decide). Do not ask about things you can find out from the code, docs or tools, " +
      "or that have a sensible default (pick it and say so). Each question offers 2-4 options; the user can also type their own answer. " +
      "Put your recommended option first.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The complete question, ending with a question mark" },
              // 模型常给每个问题加一个短标题，名字不定；收下但不用，免得整个调用被拒
              label: { type: "string", description: "Optional short tag; not shown" },
              header: { type: "string", description: "Optional short tag; not shown" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "1-5 words" },
                    description: { type: "string", description: "What choosing it means, trade-offs" },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    // 不碰文件和进程：所有模式（包括 plan）都不用批准
    effect: "read",
    concurrency: "exclusive",
    idempotent: false,
    async execute(input, ctx) {
      const questions = (input as { questions?: unknown }).questions as Question[] | undefined;
      if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return { content: `questions must have 1-${MAX_QUESTIONS} items`, isError: true };
      const bad = questions.find((q) => !Array.isArray(q?.options) || q.options.length < 2 || q.options.length > 4);
      if (bad) return { content: `each question needs 2-4 options ("${bad.question}" has ${Array.isArray(bad.options) ? bad.options.length : 0})`, isError: true };
      const answers = await ask(questions, ctx.signal);
      if (answers === undefined) return { content: DISMISSED };
      return { content: questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(no answer)"}`).join("\n\n") };
    },
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const args = (input: unknown) => (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;

export const askRenderer: ToolRenderer = {
  tool: "ask_user",
  summary: (input) => {
    const q = args(input).questions;
    return Array.isArray(q) && q.length === 1 ? clip(String((q[0] as { question?: unknown })?.question ?? ""), 120) : `${Array.isArray(q) ? q.length : 0} questions`;
  },
  // 结果显示用户的回答（旧 jade 每答一题在对话里记一行"问题 → 回答"）
  result: ({ text, isError }) => {
    if (isError) return undefined;
    if (text === DISMISSED) return { line: "dismissed" };
    const pairs = [...text.matchAll(/^Q: (.*)\nA: (.*)$/gm)].map((m) => ({ q: m[1]!, a: m[2]! }));
    if (!pairs.length) return undefined;
    return { line: clip(pairs.map((p) => p.a).join(" · "), 200), ...(pairs.length > 1 ? { details: pairs.map((p) => `${p.q} → ${p.a}`).join("\n") } : {}) };
  },
};

export default definePlugin({
  process(ctx) {
    ctx.service<Renderers>("renderers@1")?.tool(askRenderer);
  },
  session(ctx) {
    const ui = ctx.require<UI>("ui@1");
    if (ui.interactive) ctx.kernel.tool(askUserTool(askVia(ui)));
  },
});
