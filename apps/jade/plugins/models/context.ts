// 模型的上下文窗口（最大输入 token 数）。前端显示上下文用量，以后的 jade/compact 据此决定什么时候压缩。
//
// 窗口优先取 JADE_CONTEXT_WINDOW；不设时按模型名在一张小表里找（只收录确定的、取偏小的值），找不到用 128000。

import { parseTokens } from "./config.ts";

type Env = Record<string, string | undefined>;

/** 认不出模型时的窗口 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 模型名（不区分大小写，可以带 "anthropic/" 这类前缀）→ 窗口；按顺序取第一个匹配的 */
const KNOWN_WINDOWS: [RegExp, number][] = [
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/gpt-4\.1/i, 1_000_000],
  // GPT-5 的总窗口是 400k，其中输入最多 272k
  [/gpt-5/i, 272_000],
  [/(^|\/)o[134](-|$)/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/deepseek/i, 128_000],
];

/** 写错的 JADE_CONTEXT_WINDOW 当作没设 */
export function contextWindow(model: string, env: Env): number {
  if (env.JADE_CONTEXT_WINDOW) {
    try {
      return parseTokens("JADE_CONTEXT_WINDOW", env.JADE_CONTEXT_WINDOW);
    } catch {}
  }
  return KNOWN_WINDOWS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_CONTEXT_WINDOW;
}
