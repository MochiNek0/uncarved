// ask_user 工具：模型拿不准、而答案会改变它要做的事时，先问用户再动手。
//
// 每个问题给几个选项让用户选，也可以自己输入回答。怎么显示由宿主决定（ask）；
// 不能交互（-p、非终端）时直接返回"用户不在"，让模型按合理的假设继续并说明假设。

import type { Tool } from "uncarved";

export interface Question {
  question: string;
  options: { label: string; description?: string }[];
}

/** 宿主问用户：每个问题一个回答；用户取消时返回 undefined */
export type AskUser = (questions: Question[], signal: AbortSignal) => Promise<string[] | undefined>;

const MAX_QUESTIONS = 4;

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
      const { questions } = input as { questions: Question[] };
      if (questions.length === 0 || questions.length > MAX_QUESTIONS) return { content: `questions must have 1-${MAX_QUESTIONS} items`, isError: true };
      const bad = questions.find((q) => q.options.length < 2 || q.options.length > 4);
      if (bad) return { content: `each question needs 2-4 options ("${bad.question}" has ${bad.options.length})`, isError: true };
      const answers = await ask(questions, ctx.signal);
      if (answers === undefined) {
        return { content: "The user dismissed the questions without answering. Do not ask again: proceed with your best judgment and state your assumptions, or end your turn." };
      }
      return { content: questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(no answer)"}`).join("\n\n") };
    },
  };
}
