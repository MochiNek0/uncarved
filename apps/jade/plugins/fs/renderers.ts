// 文件工具在对话和审批里怎么显示（登记到 renderers@1）。从旧 jade 的 ui/renderers.ts 移植，去掉了检查点。
//
// 审批插件的 tool.before 把 path 换成了绝对路径，审批预览、before、result 拿到的都是绝对路径；
// 显示时用 display 换回工作目录内的相对路径。没有登记 renderer 的部分用前端的默认显示。

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRenderer } from "../renderers/index.ts";
import { diffLines, diffStats, renderDiff } from "./diff.ts";
import { applyEditsToText, display, type Edit } from "./fs.ts";
import { clip, dim, green, red, yellow } from "./style.ts";

type Args = Record<string, unknown>;
const args = (input: unknown) => (input !== null && typeof input === "object" ? input : {}) as Args;
/** 显示用的路径；工作目录本身显示成 "."（display 对它给的是绝对路径，审批插件会把 "." 换成工作目录） */
function pathOf(cwd: string, i: Args): string {
  if (typeof i.path !== "string") return "";
  const full = path.resolve(cwd, i.path);
  return path.relative(cwd, full) === "" ? "." : display(cwd, full);
}

/** 预览里的多行文字：每行前面加上标记，最多 max 行 */
function marked(s: string, mark: string, color: (s: string) => string, max = 30): string {
  const all = s.split("\n");
  const shown = all.slice(0, max).map((l) => color(`${mark} ${l}`));
  if (all.length > max) shown.push(dim(`  … ${all.length - max} more lines`));
  return shown.join("\n");
}

/** 折叠内容里的多行文字（缩进由前端加），最多 max 行 */
function capped(lines: string[], color: (s: string) => string, max: number): string {
  const shown = lines.slice(0, max).map(color);
  if (lines.length > max) shown.push(dim(`… ${lines.length - max} more lines`));
  return shown.join("\n");
}

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
 * 执行前的通知是同步的，等异步读完文件可能已经改了。替换不成立时返回 undefined
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
function fileRenderer(cwd: string, tool: FileTool, summary: (input: unknown) => string): ToolRenderer {
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
  // 默认摘要是 path 参数，审批插件换成绝对路径后太长：统一换回相对路径
  const where = (input: unknown) => pathOf(cwd, args(input));
  const search = (input: unknown) => {
    const i = args(input);
    const at = pathOf(cwd, i);
    return `${i.pattern}${at && at !== "." ? ` in ${at}` : ""}`;
  };
  return [
    { tool: "read_file", summary: where },
    { tool: "list_dir", summary: where },
    fileRenderer(cwd, "edit_file", where),
    fileRenderer(cwd, "multi_edit", (input) => {
      const i = args(input);
      return `${pathOf(cwd, i)}, ${Array.isArray(i.edits) ? i.edits.length : 0} edits`;
    }),
    fileRenderer(cwd, "write_file", where),
    { tool: "grep", summary: search },
    { tool: "glob", summary: search },
  ];
}
