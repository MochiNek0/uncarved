// 模型的上下文窗口（最大输入 token 数），以及由它推出的压缩阈值。
//
// 窗口优先取 JADE_CONTEXT_WINDOW；不设时按模型名在一张小表里找（只收录确定的、取偏小的值），
// 找不到用 128000。估小了只是压缩得早一些；估大了请求会因为超长被拒，宿主看到这种错误会先压缩再重试一次。

import { parseTokens } from "./config.ts";
import { providerInfo } from "./provider.ts";

type Env = Record<string, string | undefined>;

/** 写错的 JADE_MAX_TOKENS 在创建 provider 时报错，这里当作没设 */
function tokensOrZero(text: string): number {
  try {
    return parseTokens("JADE_MAX_TOKENS", text);
  } catch {
    return 0;
  }
}

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

export type WindowSource = "env" | "model" | "default";

/** 上下文窗口和它的来源 */
export function contextWindowInfo(env: Env = process.env): { tokens: number; source: WindowSource } {
  if (env.JADE_CONTEXT_WINDOW) return { tokens: parseTokens("JADE_CONTEXT_WINDOW", env.JADE_CONTEXT_WINDOW), source: "env" };
  const model = providerInfo(env).model;
  const known = KNOWN_WINDOWS.find(([re]) => re.test(model));
  return known ? { tokens: known[1], source: "model" } : { tokens: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

export function contextWindowFromEnv(env: Env = process.env): number {
  return contextWindowInfo(env).tokens;
}

/**
 * 默认的压缩阈值：窗口的 80%，并给一次回复的输出留出位置（JADE_MAX_TOKENS，Claude 默认 64000），
 * 但不低于窗口的一半
 */
export function compactThreshold(window: number, env: Env = process.env): number {
  const output = env.JADE_MAX_TOKENS ? tokensOrZero(env.JADE_MAX_TOKENS) : providerInfo(env).kind === "anthropic" ? 64_000 : 0;
  return Math.max(Math.floor(window * 0.5), Math.min(Math.floor(window * 0.8), window - output));
}

/** 服务端因为请求超出上下文窗口而拒绝的错误。各家的说法不同，按常见的措辞匹配 */
const OVERFLOW =
  /context[_ ]length[_ ]exceeded|maximum context length|context window|prompt is too long|input is too long|exceeds? the (model'?s? )?(maximum|max|context)|request too large|input length .* exceed|reduce the length of the (messages|input|prompt)/i;

export function isContextOverflow(message: string | undefined): boolean {
  return message !== undefined && OVERFLOW.test(message);
}
