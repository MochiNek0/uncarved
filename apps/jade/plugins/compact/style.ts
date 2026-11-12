// 显示用的小工具：截断，和带语义样式的文字（jade-api 的 Text）。插件只说这段是次要的、成功、警告……，
// 怎么画由前端决定（终端界面画成颜色，-p 只取文字）。插件之间不共享代码（只能共享类型），所以每个插件有一份。

import type { Span, Text, TextStyle } from "@uncarved/jade-api";

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const styled = (style: TextStyle) => (text: string): Span => ({ text, style });
export const dim = styled("dim");
export const bold = styled("bold");
export const ok = styled("ok");
export const warn = styled("warn");
export const error = styled("error");

/** 几行接成一段，行之间换行 */
export const lines = (rows: readonly Text[]): Text => rows.flatMap((r, i) => (i ? ["\n", r] : [r]));
