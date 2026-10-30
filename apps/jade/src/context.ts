// 模型的上下文窗口（最大输入 token 数），以及由它推出的压缩阈值。
// 各家模型的窗口变化太快，不内置表，由用户用 JADE_CONTEXT_WINDOW 设置，不设时用 256000。

import { providerInfo } from "./provider.ts";

type Env = Record<string, string | undefined>;

export const DEFAULT_CONTEXT_WINDOW = 256_000;

export function contextWindowFromEnv(env: Env = process.env): number {
  if (!env.JADE_CONTEXT_WINDOW) return DEFAULT_CONTEXT_WINDOW;
  const n = Number(env.JADE_CONTEXT_WINDOW);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`JADE_CONTEXT_WINDOW must be a positive integer, got ${JSON.stringify(env.JADE_CONTEXT_WINDOW)}`);
  return n;
}

/**
 * 默认的压缩阈值：窗口的 80%，并给一次回复的输出留出位置（JADE_MAX_TOKENS，Claude 默认 64000），
 * 但不低于窗口的一半
 */
export function compactThreshold(window: number, env: Env = process.env): number {
  const output = env.JADE_MAX_TOKENS ? Number(env.JADE_MAX_TOKENS) || 0 : providerInfo(env).kind === "anthropic" ? 64_000 : 0;
  return Math.max(Math.floor(window * 0.5), Math.min(Math.floor(window * 0.8), window - output));
}
