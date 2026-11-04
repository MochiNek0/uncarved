// 用户消息发出之前，依次交给插件的 beforeSend（规则见 docs/plugins.md 的规则表）：
//   - 按加载顺序链式处理：后一个插件拿到前一个改过的文字；
//   - 返回 undefined 或原文：不改；返回空字符串：不发送，后面的插件也不再处理；
//   - 抛错、返回的不是字符串、超过 BEFORE_SEND_TIMEOUT_MS：警告，按这一步之前的文字继续。

import type { Jade } from "./distro.ts";

/** 插件卡住时不能一直不发：这么久之后按这一步之前的文字继续 */
export const BEFORE_SEND_TIMEOUT_MS = 30_000;

/** 处理过程中要告诉用户的事 */
export interface BeforeSendReport {
  changed(plugin: string, text: string): void;
  dropped(plugin: string): void;
  failed(plugin: string, err: unknown): void;
}

/** 返回要发出的文字；undefined 表示有插件决定不发送 */
export async function runBeforeSend(
  chain: Jade["beforeSend"],
  text: string,
  opts: { sessionId: string; report: BeforeSendReport; timeoutMs?: number },
): Promise<string | undefined> {
  for (const { plugin, fn } of chain) {
    try {
      const signal = AbortSignal.timeout(opts.timeoutMs ?? BEFORE_SEND_TIMEOUT_MS);
      const next = await abortable(Promise.resolve().then(() => fn(text, { sessionId: opts.sessionId, signal })), signal);
      if (next === undefined || next === text) continue;
      if (typeof next !== "string") throw new Error("beforeSend must return a string or undefined");
      if (!next.trim()) {
        opts.report.dropped(plugin);
        return undefined;
      }
      opts.report.changed(plugin, next);
      text = next;
    } catch (err) {
      opts.report.failed(plugin, err);
    }
  }
  return text;
}

/** p 和 signal 谁先结束用谁：signal 中止时以它的 reason 拒绝 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
