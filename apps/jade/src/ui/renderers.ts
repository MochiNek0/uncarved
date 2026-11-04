// jade 自己的工具怎么显示：和插件一样用 ToolRenderer（见 plugins/loader.ts），由提供这些工具的内置插件带上。
// 没有 renderer 的工具、renderer 没给的部分用 transcript 的默认显示。

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRenderer } from "../plugins/loader.ts";
import { applyEditsToText, display, type Edit } from "../tools/fs.ts";
import { diffLines, diffStats, renderDiff } from "./diff.ts";
import { clip } from "./render.ts";
import { dim, green, red, yellow } from "./screen.ts";

type Args = Record<string, unknown>;
const args = (input: unknown) => (input ?? {}) as Args;
const pathOf = (cwd: string, i: Args) => (typeof i.path === "string" ? display(cwd, i.path) : "");

/** 预览里的多行文字：每行前面加上标记，最多 max 行 */
function marked(s: string, mark: string, color: (s: string) => string, max = 30): string {
  const all = s.split("\n");
  const shown = all.slice(0, max).map((l) => color(`${mark} ${l}`));
  if (all.length > max) shown.push(dim(`  … ${all.length - max} more lines`));
  return shown.join("\n");
}

/** 折叠内容里的多行文字（缩进由 transcript 加），最多 max 行 */
function capped(lines: string[], color: (s: string) => string, max: number): string {
  const shown = lines.slice(0, max).map(color);
  if (lines.length > max) shown.push(dim(`… ${lines.length - max} more lines`));
  return shown.join("\n");
}

// ---------- 文件 ----------

type FileTool = "edit_file" | "multi_edit" | "write_file";
const editsOf = (tool: FileTool, i: Args) => (tool === "edit_file" ? [i] : Array.isArray(i.edits) ? i.edits : []) as unknown as Edit[];

/**
 * 审批时的预览：带行号和上下文的 diff（读出文件、按工具的规则算出修改后的内容）。
 * 文件读不了、替换不成立时退回到只显示参数里的新旧文本
 */
async function filePreview(cwd: string, tool: FileTool, input: unknown): Promise<string> {
  const i = args(input);
  const file = typeof i.path === "string" ? path.resolve(cwd, i.path) : undefined;
  const current = file ? await readFile(file, "utf8").catch(() => undefined) : undefined;
  if (tool === "write_file") {
    const content = String(i.content ?? "");
    if (current !== undefined) return `${dim("  overwrites the existing file:")}\n${renderDiff(current, content)}`;
    return marked(content, "+", green, 20);
  }
  if (tool === "multi_edit" && !Array.isArray(i.edits)) return dim(clip(JSON.stringify(input, null, 2), 2000));
  const edits = editsOf(tool, i);
  const raw = (e: Args) => `${marked(String(e.old_string ?? ""), "-", red)}\n${marked(String(e.new_string ?? ""), "+", green)}`;
  const fallback = () => edits.map((e) => raw(e as unknown as Args)).join(dim("\n  ⋯\n"));
  if (current === undefined) return fallback();
  const r = applyEditsToText(current, edits, display(cwd, file!));
  if (typeof r === "string") return `${fallback()}\n${yellow(`  (this edit will fail: ${clip(r, 200)})`)}`;
  return renderDiff(current, r.text);
}

interface FileDiff {
  added: number;
  removed: number;
  text: string;
}

/** 对话里折叠的 diff 最多显示这么多行 */
const MAX_DIFF_LINES = 400;
/** 结果文字（例如编辑后检查的输出）折叠起来最多这么多行 */
const MAX_RESULT_LINES = 2000;

/**
 * 执行前后的差异。在工具执行之前调用（读的是修改前的文件），同步读文件：
 * 执行前的事件通知是同步的，等异步读完文件可能已经改了。替换不成立时返回 undefined
 */
function fileDiff(cwd: string, tool: FileTool, input: unknown): FileDiff | undefined {
  const i = args(input);
  if (typeof i.path !== "string") return undefined;
  const file = path.resolve(cwd, i.path);
  let before: string | undefined;
  try {
    before = readFileSync(file, "utf8");
  } catch {}
  let after: string;
  if (tool === "write_file") {
    after = String(i.content ?? "");
  } else {
    if (before === undefined) return undefined;
    const r = applyEditsToText(before, editsOf(tool, i), display(cwd, file));
    if (typeof r === "string") return undefined;
    after = r.text;
  }
  const lines = diffLines(before ?? "", after);
  const { added, removed } = diffStats(lines);
  return { added, removed, text: renderDiff(before ?? "", after, MAX_DIFF_LINES, lines) };
}

/** 修改文件的工具：预览是 diff；结果行后面是增删的行数，展开看完整的 diff */
function fileRenderer(cwd: string, tool: FileTool, summary?: (input: unknown) => string): ToolRenderer {
  return {
    tool,
    summary,
    preview: (input) => filePreview(cwd, tool, input),
    before: (input) => fileDiff(cwd, tool, input),
    result: ({ text, isError, before }) => {
      const diff = before as FileDiff | undefined;
      if (!diff || isError) return undefined;
      const [first = "", ...rest] = text.split("\n");
      const extra = rest.length ? [capped(rest, (s) => s, MAX_RESULT_LINES)] : [];
      return { line: dim(`${clip(first, 150)} `) + `${green(`+${diff.added}`)} ${red(`-${diff.removed}`)}`, details: [...extra, diff.text].join("\n") };
    },
  };
}

export function fsRenderers(cwd: string): ToolRenderer[] {
  const search = (input: unknown) => {
    const i = args(input);
    const where = pathOf(cwd, i);
    return `${i.pattern}${where && where !== "." ? ` in ${where}` : ""}`;
  };
  return [
    fileRenderer(cwd, "edit_file"),
    fileRenderer(cwd, "multi_edit", (input) => {
      const i = args(input);
      return `${pathOf(cwd, i)}, ${Array.isArray(i.edits) ? i.edits.length : 0} edits`;
    }),
    fileRenderer(cwd, "write_file"),
    { tool: "grep", summary: search },
    { tool: "glob", summary: search },
  ];
}

// ---------- 其他内置工具 ----------

export const shellRenderers: ToolRenderer[] = [
  {
    tool: "bash",
    summary: (input) => clip(String(args(input).command ?? "").split("\n")[0]!, 120),
    // 摘要省略了内容时（多行或很长的命令），展开后先显示完整的命令
    details: (input) => {
      const lines = String(args(input).command ?? "").split("\n");
      if (lines.length === 1 && lines[0]!.length <= 120) return undefined;
      return capped(lines.map((l, i) => `${i === 0 ? "$" : " "} ${l}`), dim, 200);
    },
    preview: (input) => marked(String(args(input).command ?? ""), "$", (s) => s),
  },
  { tool: "bash_output", summary: (input) => String(args(input).id ?? "") },
  { tool: "kill_shell", summary: (input) => String(args(input).id ?? "") },
];

export const webRenderers: ToolRenderer[] = [
  { tool: "web_fetch", summary: (input) => clip(String(args(input).url ?? ""), 120) },
  { tool: "web_search", summary: (input) => clip(String(args(input).query ?? ""), 120) },
];

export const todoRenderers: ToolRenderer[] = [
  { tool: "todo_write", summary: (input) => `${Array.isArray(args(input).todos) ? (args(input).todos as unknown[]).length : 0} items` },
];

export const askRenderers: ToolRenderer[] = [
  {
    tool: "ask_user",
    summary: (input) => {
      const q = args(input).questions;
      return Array.isArray(q) && q.length === 1 ? clip(String(q[0]?.question ?? ""), 120) : `${Array.isArray(q) ? q.length : 0} questions`;
    },
  },
];

export const memoryRenderers: ToolRenderer[] = [
  {
    tool: "memory",
    summary: (input) => {
      const i = args(input);
      return `${i.action} ${i.scope}: ${clip(String(i.text ?? ""), 120)}`;
    },
    preview: (input) => {
      const i = args(input);
      return `${i.action === "remove" ? red("- ") : green("+ ")}${String(i.text ?? "")}`;
    },
  },
];

export const taskRenderers: ToolRenderer[] = [{ tool: "task", summary: (input) => String(args(input).description ?? "") }];
