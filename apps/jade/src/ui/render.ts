// 宿主显示用的纯函数：工具调用的一行摘要、审批时的预览、折叠的工具结果。不依赖运行时和界面状态。

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PendingCall } from "uncarved";
import { applyEditsToText, display, type Edit } from "../tools/fs.ts";
import { renderDiff } from "./diff.ts";
import { dim, green, red, yellow } from "./screen.ts";

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** 家目录下的路径显示成 ~/… */
export function shortPath(p: string): string {
  const rel = path.relative(os.homedir(), p);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : rel === "" ? "~" : p;
  return shown.split(path.sep).join("/");
}

/** 工具调用的一行摘要，显示在工具名后面的括号里 */
export function summarize(cwd: string, name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "bash") return clip(String(i.command ?? "").split("\n")[0]!, 120);
  if (name === "task") return String(i.description ?? "");
  if (name === "bash_output" || name === "kill_shell") return String(i.id ?? "");
  if (name === "todo_write") return `${Array.isArray(i.todos) ? i.todos.length : 0} items`;
  if (name === "web_fetch") return clip(String(i.url ?? ""), 120);
  if (name === "web_search") return clip(String(i.query ?? ""), 120);
  if (name === "memory") return `${i.action} ${i.scope}: ${clip(String(i.text ?? ""), 120)}`;
  const where = typeof i.path === "string" ? display(cwd, i.path) : "";
  if (name === "multi_edit") return `${where}, ${Array.isArray(i.edits) ? i.edits.length : 0} edits`;
  if (name === "grep" || name === "glob") return `${i.pattern}${where && where !== "." ? ` in ${where}` : ""}`;
  return where || clip(JSON.stringify(input), 120);
}

/**
 * 审批时显示的内容：修改显示成带行号和上下文的 diff（读出文件、按工具的规则算出修改后的内容），
 * 命令显示命令本身。文件读不了、替换不成立时退回到只显示参数里的新旧文本
 */
export async function preview(c: PendingCall, cwd: string): Promise<string> {
  const i = (c.input ?? {}) as Record<string, unknown>;
  const lines = (s: string, mark: string, color: (s: string) => string, max = 30) => {
    const all = s.split("\n");
    const shown = all.slice(0, max).map((l) => color(`${mark} ${l}`));
    if (all.length > max) shown.push(dim(`  … ${all.length - max} more lines`));
    return shown.join("\n");
  };
  const raw = (e: Record<string, unknown>) => `${lines(String(e.old_string ?? ""), "-", red)}\n${lines(String(e.new_string ?? ""), "+", green)}`;
  const file = typeof i.path === "string" ? path.resolve(cwd, i.path) : undefined;
  const current = file ? await readFile(file, "utf8").catch(() => undefined) : undefined;
  if (c.name === "edit_file" || (c.name === "multi_edit" && Array.isArray(i.edits))) {
    const edits = (c.name === "edit_file" ? [i] : i.edits) as unknown as Edit[];
    const fallback = () => edits.map((e) => raw(e as unknown as Record<string, unknown>)).join(dim("\n  ⋯\n"));
    if (current === undefined) return fallback();
    const r = applyEditsToText(current, edits, display(cwd, file!));
    if (typeof r === "string") return `${fallback()}\n${yellow(`  (this edit will fail: ${clip(r, 200)})`)}`;
    return renderDiff(current, r.text);
  }
  if (c.name === "write_file") {
    const content = String(i.content ?? "");
    if (current !== undefined) return `${dim("  overwrites the existing file:")}\n${renderDiff(current, content)}`;
    return lines(content, "+", green, 20);
  }
  if (c.name === "bash") return lines(String(i.command ?? ""), "$", (s) => s);
  if (c.name === "memory") return `${i.action === "remove" ? red("- ") : green("+ ")}${String(i.text ?? "")}`;
  return dim(clip(JSON.stringify(c.input, null, 2), 2000));
}

/** 工具结果展开后的内容：缩进的全部行，超过 max 行时截断 */
export function detailsOf(lines: string[], color: (s: string) => string, max: number): string {
  const body = lines.slice(0, max).map((l) => color(`    ${l}`));
  if (lines.length > max) body.push(dim(`    … ${lines.length - max} more lines`));
  return body.join("\n");
}
