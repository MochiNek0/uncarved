// bash、bash_output、kill_shell 在对话和审批里怎么显示（登记到 renderers@1）。从旧 jade 的 ui/renderers.ts 移植。
//
// 运行中的输出不登记 progress：bash 推送的是 { kind, stream, text }，前端对 { text } 形式的进度默认逐行显示，
// 正是想要的；自己写 progress 反而只能把一次推送（可能是好几行、半行）显示成一行。

import type { ToolRenderer } from "@uncarved/jade-api/services";
import type { Span, Text } from "@uncarved/jade-api";

// 截断和颜色从旧 jade 的 ui/render.ts、ui/screen.ts 复制：插件之间不共享代码，fs 插件也有一份
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
// 带语义样式的文字（jade-api 的 Text）：怎么画由前端决定
const dim = (text: string): Span => ({ text, style: "dim" });
/** 几行接成一段，行之间换行 */
const joinLines = (rows: readonly Text[]): Text => rows.flatMap((r, i) => (i ? ["\n", r] : [r]));

type Args = Record<string, unknown>;
const args = (input: unknown) => (input !== null && typeof input === "object" ? input : {}) as Args;
const command = (input: unknown) => String(args(input).command ?? "");

/** 摘要最多这么多个字符 */
const MAX_SUMMARY = 120;

/** 预览里的多行文字：每行前面加上标记，最多 max 行 */
function marked(s: string, mark: string, max = 30): Text {
  const all = s.split("\n");
  const shown: Text[] = all.slice(0, max).map((l) => `${mark} ${l}`);
  if (all.length > max) shown.push(dim(`  … ${all.length - max} more lines`));
  return joinLines(shown);
}

export const shellRenderers: ToolRenderer[] = [
  {
    tool: "bash",
    summary: (input) => clip(command(input).split("\n")[0]!, MAX_SUMMARY),
    // 摘要省略了内容时（多行或很长的命令），展开后先显示完整的命令
    details: (input) => {
      const lines = command(input).split("\n");
      if (lines.length === 1 && lines[0]!.length <= MAX_SUMMARY) return undefined;
      const shown = lines.slice(0, 200).map((l, i) => dim(`${i === 0 ? "$" : " "} ${l}`));
      if (lines.length > 200) shown.push(dim(`… ${lines.length - 200} more lines`));
      return joinLines(shown);
    },
    preview: (input) => marked(command(input), "$"),
  },
  { tool: "bash_output", summary: (input) => String(args(input).id ?? "") },
  { tool: "kill_shell", summary: (input) => String(args(input).id ?? "") },
];
