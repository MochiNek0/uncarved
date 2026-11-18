// jade/copy：/copy 把最后一条回复（模型写的原文，没有折行和排版）放进剪贴板；/copy code 只放它的最后一个代码块。
// 原来写在 jade/tui 里；回复从当前会话的状态里取，剪贴板经 ui@1.copy，所以任何有剪贴板的前端都能用。

import type { Block } from "uncarved";
import { definePlugin, type Span, type TextStyle } from "@uncarved/jade-api";
import type { Commands } from "@uncarved/jade-api/services";

const styled = (style: TextStyle) => (text: string): Span => ({ text, style });
const dim = styled("dim");
const error = styled("error");

/** 最近一条有正文的助手消息的正文 */
export function lastReply(messages: readonly { role: string; content: readonly Block[] }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = m.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n").trim();
    if (text) return text;
  }
  return undefined;
}

/** Markdown 里最后一个围栏代码块的内容 */
export function lastCodeBlock(markdown: string): string | undefined {
  const blocks = [...markdown.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[`~]*[ \t]*$/gm)];
  return blocks.at(-1)?.[2]?.replace(/\n$/, "");
}

export default definePlugin({
  process(ctx) {
    ctx.require<Commands>("commands@1").register({
      name: "copy",
      args: "[code]",
      description: "copy the last reply to the clipboard as it was written (code: only its last code block)",
      instant: true,
      run(args, c) {
        const code = args.trim() === "code";
        const reply = lastReply(c.sessions.current?.state.messages ?? []);
        const text = code ? reply && lastCodeBlock(reply) : reply;
        if (!text) return dim(code ? "The last reply has no code block." : "There is no reply to copy yet.");
        if (!c.ui.copy?.(text)) return error("[error] this front end cannot copy to the clipboard");
        return dim(`[copied ${[...text].length} characters]`);
      },
    });
  },
});
