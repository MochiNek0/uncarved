// 文件工具：read_file / write_file / edit_file / list_dir / glob，以及 grep（见 grep.ts）。
//
// 路径可以是相对路径（相对于工作目录）或绝对路径。工具本身不做权限判断：那是审批插件的事。
//
// 修改已有文件之前必须先读过它，且读过之后文件没有被别人（用户、bash 命令）改过，
// 否则模型是按过时的内容在改，会覆盖掉别人的修改。和修改在同一次回复里发出的读取不算：
// 那次修改的内容是模型看到读取结果之前就写好的。

import type { Stats } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Message, Tool } from "uncarved";
import type { ToolMeta } from "@uncarved/jade-api";
import { grepTool } from "./grep.ts";
import { globMatcher, run } from "./sys.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
/** 一次 read_file 返回的文本上限（约 25k token） */
const MAX_READ_CHARS = 100_000;
const MAX_GLOB = 500;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_PDF_BYTES = 10_000_000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** 遍历目录时跳过 */
export const SKIP_DIRS = new Set([".git", "node_modules"]);

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

export function resolveIn(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/** 显示用：工作目录内的路径用相对形式，统一为正斜杠 */
export function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

export interface FsOptions {
  /** 模型调用的次数，每次调用模型前加一（见 index.ts 的 model.before hook）。不给就不检查同一次回复里的先读后改 */
  responses?: { readonly calls: number };
  /** grep 用的 ripgrep，默认 "rg"；null 表示不用（测试） */
  rg?: string | null;
  /** 记录读过的文件；给了才能在压缩后让它们失效（见 SeenFiles.prune） */
  seen?: SeenFiles;
}

/** 读过或写过的文件当时的样子；只在本会话、本进程内有效，恢复的会话要重新读 */
interface Seen {
  mtimeMs: number;
  size: number;
  /** 读取时的 responses.calls；写入的文件模型知道内容，记为 -1 */
  call: number;
  /**
   * 模型从哪一次调用知道这个文件的内容：read_file 或 write_file 的 toolUseId。
   * edit_file 只改了一部分，模型知道的仍是之前那次读取（加上改动），所以沿用原来的
   */
  id?: string;
}

/** 本会话读过、写过的文件 */
export class SeenFiles {
  readonly files = new Map<string, Seen>();
  /** 因为压缩而失效的文件：再改时说明原因，而不是说"没读过" */
  readonly dropped = new Set<string>();

  /**
   * 压缩或清理之后，模型看不到当初读到（写入）的内容了，但 mtime 和 size 没变，修改仍会放行；
   * write_file 可能凭摘要里的记忆写出整个文件。这里按最终的投影检查：那次调用已被总结掉（投影里没有它的 tool_use），
   * 或者结果已被清理（tool_result 里没有工具自己给的内容，只剩插件的占位说明），就当作没读过
   */
  prune(projection: Message[]): void {
    const uses = new Set<string>();
    const cleared = new Set<string>();
    for (const m of projection) {
      for (const b of m.content) {
        if (b.kind === "tool_use") uses.add(b.id);
        else if (b.kind === "tool_result" && !b.content.some((c) => c.origin.by === "tool")) cleared.add(b.toolUseId);
      }
    }
    for (const [full, s] of this.files) {
      if (s.id === undefined || (uses.has(s.id) && !cleared.has(s.id))) continue;
      this.files.delete(full);
      this.dropped.add(full);
    }
  }
}

export function fsTools(cwd: string, opts: FsOptions = {}): (Tool & { meta?: ToolMeta })[] {
  const at = (p: unknown) => resolveIn(cwd, p as string);
  const tracked = opts.seen ?? new SeenFiles();
  const seen = tracked.files;
  /**
   * 文件没变时保留更早的 call：之前的回复里读过，这次回复里又读一遍，不影响修改。
   * id 为 undefined 表示沿用原来的（edit_file）
   */
  const remember = (full: string, info: Stats, call: number, id: string | undefined) => {
    const s = seen.get(full);
    const same = s !== undefined && s.mtimeMs === info.mtimeMs && s.size === info.size;
    seen.set(full, { mtimeMs: info.mtimeMs, size: info.size, call: same ? Math.min(s.call, call) : call, id: id ?? s?.id });
    tracked.dropped.delete(full);
  };
  /** 不能修改已有文件的原因；可以修改时返回 undefined。text 是文件现在的内容 */
  const staleness = (full: string, info: Stats): string | undefined => {
    const shown = display(cwd, full);
    const modified = `${shown} has been modified since it was last read (by the user or a command). Read it again before changing it.`;
    const s = seen.get(full);
    if (s) {
      if (s.mtimeMs !== info.mtimeMs || s.size !== info.size) return modified;
      if (opts.responses && s.call === opts.responses.calls) {
        return `${shown} was read in the same response as this change, so the change was written before its content was seen. Check the read_file result, then make the change in your next response.`;
      }
      return undefined;
    }
    if (tracked.dropped.has(full)) {
      return `The earlier read of ${shown} was compacted out of the conversation, so its content is no longer in context. Read it again before changing it.`;
    }
    return `${shown} exists but has not been read in this session. Read it with read_file before changing it.`;
  };

  const readFileTool: Tool = {
    name: "read_file",
    description:
      "Read a UTF-8 text file, an image (png, jpg, gif, webp) or a PDF. Text is returned as lines prefixed with their 1-based line number and a tab. " +
      `At most ${MAX_LINES} lines (about ${MAX_READ_CHARS / 1000}k characters) are returned per call; use offset (1-based start line) and limit to page through larger files. ` +
      `Lines longer than ${MAX_LINE_CHARS} characters are cut and marked "[line truncated]"; do not copy a cut line into edit_file.`,
    inputSchema: {
      type: "object",
      properties: { path: str, offset: int, limit: int },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input, ctx) {
      const { path: p, offset = 1, limit = MAX_LINES } = input as { path: string; offset?: number; limit?: number };
      if (limit < 1) return { content: "limit must be at least 1", isError: true };
      const full = at(p);
      const info = await stat(full);
      if (info.isDirectory()) return { content: `${display(cwd, full)} is a directory; use list_dir`, isError: true };
      const mediaType = IMAGE_TYPES[path.extname(full).toLowerCase()];
      if (mediaType) {
        if (info.size > MAX_IMAGE_BYTES) return { content: `image is ${info.size} bytes; at most ${MAX_IMAGE_BYTES} can be read`, isError: true };
        const image: Block = {
          kind: "image",
          source: { type: "base64", media_type: mediaType, data: (await readFile(full)).toString("base64") },
          origin: { by: "tool", name: "read_file" },
          trust: "untrusted",
        };
        return { content: [image] };
      }
      if (path.extname(full).toLowerCase() === ".pdf") {
        if (info.size > MAX_PDF_BYTES) return { content: `PDF is ${info.size} bytes; at most ${MAX_PDF_BYTES} can be read`, isError: true };
        const pdf: Block = {
          kind: "document",
          source: { type: "base64", media_type: "application/pdf", data: (await readFile(full)).toString("base64") },
          origin: { by: "tool", name: "read_file" },
          trust: "untrusted",
        };
        return { content: [pdf] };
      }
      const buf = await readFile(full);
      if (buf.subarray(0, 8000).includes(0)) {
        return { content: `${display(cwd, full)} is a binary file (${buf.length} bytes) and cannot be shown as text`, isError: true };
      }
      // 不是 UTF-8 的文件（多半是 GBK）照样给模型看，但不算读过：改它会把原来的字节写坏
      const strict = utf8(buf);
      const text = strict ?? legacyText(buf);
      const note = strict === undefined ? `\n(${notUtf8(display(cwd, full))})` : "";
      if (strict !== undefined) remember(full, info, opts.responses?.calls ?? -1, ctx?.toolUseId);
      if (text.length === 0) return { content: "(empty file)" };
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + Math.min(limit, MAX_LINES));
      if (slice.length === 0) return { content: `(file has ${lines.length} lines; offset ${start} is past the end)`, isError: true };
      // 按整行截断到 MAX_READ_CHARS：压缩过的代码、lock 文件一次就能占掉大半个上下文
      const out: string[] = [];
      let size = 0;
      for (const [i, l] of slice.entries()) {
        const row = `${start + i}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated: ${l.length} characters]` : l}`;
        if (out.length > 0 && size + row.length + 1 > MAX_READ_CHARS) break;
        out.push(row);
        size += row.length + 1;
      }
      const body = out.join("\n");
      const end = start + out.length - 1;
      if (out.length < slice.length) {
        return { content: `${body}\n(output capped at about ${MAX_READ_CHARS} characters: showing lines ${start}-${end} of ${lines.length}; continue with offset ${end + 1})${note}` };
      }
      return { content: (end < lines.length ? `${body}\n(showing lines ${start}-${end} of ${lines.length})` : body) + note };
    },
  };

  const writeFileTool: Tool & { meta: ToolMeta } = {
    name: "write_file",
    meta: { writes: "path" },
    description:
      "Create a file or overwrite it with the complete new content. Missing parent directories are created. " +
      "An existing file must have been read with read_file first. Prefer edit_file for changing part of an existing file.",
    inputSchema: {
      type: "object",
      properties: { path: str, content: str },
      required: ["path", "content"],
      additionalProperties: false,
    },
    effect: "write",
    concurrency: "exclusive",
    // 写入完整内容，重复执行结果相同
    idempotent: true,
    async execute(input, ctx) {
      const { path: p, content: given } = input as { path: string; content: string };
      const full = at(p);
      const info = await statOrUndefined(full);
      if (info?.isDirectory()) return { content: `${display(cwd, full)} is a directory`, isError: true };
      // 同样内容重复写入（崩溃后重跑）不算覆盖别人的修改
      const before = info ? utf8(await readFile(full)) ?? undefined : null;
      if (before === undefined) return { content: notUtf8(display(cwd, full)), isError: true };
      // read_file 不显示换行风格和 BOM：覆盖已有文件时沿用原来的，否则整个文件每一行都算改了
      const content = before === null ? given : keepStyle(before, given);
      const problem = info && before !== null && before !== content ? staleness(full, info) : undefined;
      if (problem) return { content: problem, isError: true };
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
      remember(full, await stat(full), -1, ctx?.toolUseId);
      // 和 read_file 一样数行：末尾的换行不算多出一行
      const lines = content === "" ? 0 : content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0);
      return { content: `Wrote ${lines} lines to ${display(cwd, full)}` };
    },
  };

  /** edit_file 和 multi_edit 共用：检查文件能否修改，按顺序应用全部替换，全部成功才写入 */
  const applyEdits = async (p: string, edits: Edit[]) => {
    const full = at(p);
    const shown = display(cwd, full);
    const info = await statOrUndefined(full);
    if (!info) {
      return { content: seen.has(full) ? `${shown} no longer exists` : `${shown} does not exist; use write_file to create it`, isError: true };
    }
    const text = utf8(await readFile(full));
    if (text === undefined) return { content: notUtf8(shown), isError: true };
    const problem = staleness(full, info);
    if (problem) return { content: problem, isError: true };
    let next = text;
    let total = 0;
    for (const [i, e] of edits.entries()) {
      const r = replaceIn(next, e, shown);
      if (typeof r === "string") return { content: edits.length > 1 ? `edit ${i + 1} of ${edits.length}: ${r}. No edits were applied.` : r, isError: true };
      next = r.text;
      total += r.count;
    }
    await writeFile(full, next);
    remember(full, await stat(full), -1, undefined);
    return { content: `Edited ${shown} (${total} replacement${total === 1 ? "" : "s"})` };
  };

  const editFileTool: Tool & { meta: ToolMeta } = {
    name: "edit_file",
    meta: { writes: "path" },
    description:
      "Replace exact text in a file. old_string must match the file exactly (including whitespace and indentation) " +
      "and must be unique unless replace_all is true. The file must have been read with read_file first, " +
      "and is refused if it changed since then. Use multi_edit for several changes to one file.",
    inputSchema: {
      type: "object",
      properties: { path: str, old_string: str, new_string: str, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    effect: "write",
    concurrency: "exclusive",
    // 第二次执行时 old_string 可能已经不存在，或者被替换两次
    idempotent: false,
    async execute(input) {
      const { path: p, ...edit } = input as { path: string } & Edit;
      return applyEdits(p, [edit]);
    },
  };

  const multiEditTool: Tool & { meta: ToolMeta } = {
    name: "multi_edit",
    meta: { writes: "path" },
    description:
      "Make several exact-text replacements in one file at once. The edits are applied in order, each to the result of the previous one, " +
      "with the same rules as edit_file. Either all edits succeed or the file is left unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        path: str,
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { old_string: str, new_string: str, replace_all: { type: "boolean" } },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    effect: "write",
    concurrency: "exclusive",
    idempotent: false,
    async execute(input) {
      const { path: p, edits } = input as { path: string; edits: Edit[] };
      if (edits.length === 0) return { content: "edits must not be empty", isError: true };
      return applyEdits(p, edits);
    },
  };

  const listDirTool: Tool = {
    name: "list_dir",
    description: "List the entries of a directory. Directories end with '/'.",
    inputSchema: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      const entries = await readdir(at((input as { path: string }).path), { withFileTypes: true });
      const names = entries.map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();
      return { content: names.length > 0 ? names.join("\n") : "(empty directory)" };
    },
  };

  const globTool: Tool = {
    name: "glob",
    description:
      `Find files by glob pattern (e.g. "src/**/*.ts"), relative to path (default: the working directory). ` +
      `Unlike grep's include, "*.ts" matches only directly under path; use "**/*.ts" for any depth. ` +
      `Skips files ignored by git, .git and node_modules. Returns at most ${MAX_GLOB} paths.`,
    inputSchema: {
      type: "object",
      properties: { pattern: str, path: str },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input, { signal }) {
      const { pattern, path: p = "." } = input as { pattern: string; path?: string };
      const root = at(p);
      const out: string[] = [];
      let more = false;
      const match = globMatcher(pattern);
      const tracked = await gitFiles(root);
      const candidates = tracked
        ? filterAsync(tracked, async (rel) => match(rel) && Boolean((await statOrUndefined(path.join(root, rel)))?.isFile()))
        : scanGlob(root, match, signal);
      for await (const rel of candidates) {
        signal.throwIfAborted();
        if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue;
        if (out.length >= MAX_GLOB) {
          more = true;
          break;
        }
        out.push(display(cwd, path.join(root, rel)));
      }
      out.sort();
      // 和 grep 的 include 不同，不含 / 的模式只匹配第一层：模型常按 grep 的习惯写
      if (out.length === 0) return { content: pattern.includes("/") || pattern.startsWith("**") ? "No files matched" : `No files matched. "${pattern}" only matches directly under ${p === "." ? "the working directory" : p}; use "**/${pattern}" to search at any depth.` };
      return { content: out.join("\n") + (more ? `\n(more than ${MAX_GLOB} matches; narrow the pattern)` : "") };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, multiEditTool, listDirTool, globTool, grepTool(cwd, { rg: opts.rg })];
}

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** 按 edit_file / multi_edit 的规则把 edits 依次应用到 text 上；失败时返回原因。审批预览用它算出修改后的内容 */
export function applyEditsToText(text: string, edits: Edit[], shown: string): string | { text: string } {
  let next = text;
  for (const [i, e] of edits.entries()) {
    const r = replaceIn(next, e, shown);
    if (typeof r === "string") return edits.length > 1 ? `edit ${i + 1} of ${edits.length}: ${r}` : r;
    next = r.text;
  }
  return { text: next };
}

/** 按 UTF-8 解码（BOM 留着）；不是合法的 UTF-8 时 undefined */
export function utf8(buf: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return undefined;
  }
}

/** 不是 UTF-8 的文本只用来显示：按 GB18030（含 GBK）解码，运行时不支持时按 UTF-8 解码、坏的字节显示成 U+FFFD */
function legacyText(buf: Buffer): string {
  try {
    return new TextDecoder("gb18030").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

const notUtf8 = (shown: string) =>
  `${shown} is not valid UTF-8 (read_file shows it decoded as GB18030). write_file and edit_file only handle UTF-8 and would corrupt it, so they refuse it: ` +
  "change it with a command that keeps its encoding, or ask the user before converting it to UTF-8.";

/** text 里多数换行是 CRLF 时返回 "\r\n"，多数是 LF 时返回 "\n"，一样多或没有换行时返回 fallback */
function eolOf(text: string, fallback: string): string {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : lf > crlf ? "\n" : fallback;
}

/** 原文件主要用 CRLF、新内容只有 LF 时换成 CRLF；原文件有 BOM、新内容没有时补上 */
export function keepStyle(before: string, content: string): string {
  let out = content;
  if (eolOf(before, "\n") === "\r\n" && !out.includes("\r\n")) out = out.replaceAll("\n", "\r\n");
  if (before.startsWith("﻿") && !out.startsWith("﻿")) out = `﻿${out}`;
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 在 text 上做一次替换；失败时返回原因 */
function replaceIn(text: string, { old_string, new_string, replace_all }: Edit, shown: string): { text: string; count: number } | string {
  if (old_string === new_string) return "old_string and new_string are identical";
  if (old_string === "") return "old_string must not be empty; use write_file to create a file";
  // read_file 不显示换行风格：old_string 里的换行匹配 LF 和 CRLF，CRLF 文件、换行混用的文件都能对上
  const pattern = new RegExp(old_string.split(/\r?\n/).map(escapeRegExp).join("\\r?\\n"), "g");
  const count = text.match(pattern)?.length ?? 0;
  if (count === 0) return `old_string not found in ${shown}${nearMiss(text, old_string)}`;
  if (count > 1 && !replace_all) {
    return `old_string occurs ${count} times in ${shown} (${linesOf(text, pattern, 5)}); add context to make it unique or set replace_all`;
  }
  // new_string 的换行沿用被替换那段的；那段只有一行时沿用整个文件的，单行改成多行也不会混进 LF
  const fileEol = eolOf(text, "\n");
  const to = (matched: string) => (new_string.includes("\r\n") ? new_string : new_string.replaceAll("\n", eolOf(matched, fileEol)));
  // 用函数作替换值，new_string 里的 $& $1 等不会被当成替换模式
  return { text: text.replace(replace_all ? pattern : new RegExp(pattern.source), to), count: replace_all ? count : 1 };
}

/** pattern 前 max 处匹配所在的行号，例如 "lines 3, 17, 40" */
function linesOf(text: string, pattern: RegExp, max: number): string {
  const found: number[] = [];
  let line = 1;
  let from = 0;
  for (const m of text.matchAll(new RegExp(pattern.source, "g"))) {
    for (let i = from; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    from = m.index;
    found.push(line);
    if (found.length === max) break;
  }
  return `line${found.length > 1 ? "s" : ""} ${found.join(", ")}${found.length === max ? ", …" : ""}`;
}

/**
 * old_string 找不到时帮模型定位：忽略空白后能匹配到哪几行，或者第一行出现在哪里。
 * 只给提示，不自动按模糊匹配修改：那样可能改错地方
 */
export function nearMiss(text: string, needle: string): string {
  // 最常见的一种：把 read_file 每行开头的行号和制表符一起抄进来了
  const raw = needle.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (raw.length > 0 && raw.every((l) => /^\s*\d+\t/.test(l))) {
    return ". It seems to include read_file's line-number prefixes (the number and tab at the start of each line); they are not part of the file. Remove them and keep the rest exactly";
  }
  const norm = (l: string) => l.trim().replace(/\s+/g, " ");
  const lines = text.split(/\r?\n/).map(norm);
  const want = needle.split(/\r?\n/).map(norm);
  while (want.length > 1 && want.at(-1) === "") want.pop();
  while (want.length > 1 && want[0] === "") want.shift();
  if (want.every((l) => l === "")) return "";
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length && hits.length < 3; i++) {
    if (want.every((l, k) => (k === 0 || k === want.length - 1 ? lines[i + k]!.includes(l) : lines[i + k] === l))) hits.push(i);
  }
  if (hits.length > 0) {
    const where = hits.map((i) => (want.length > 1 ? `${i + 1}-${i + want.length}` : `${i + 1}`)).join(", ");
    return `. It matches line${hits.length > 1 || want.length > 1 ? "s" : ""} ${where} if whitespace is ignored: indentation, tabs or trailing spaces differ. Copy the exact text from read_file`;
  }
  const first = want.find((l) => l !== "")!;
  const at = lines.findIndex((l) => l.includes(first));
  if (at >= 0 && want.length > 1) return `. Its first line "${first.slice(0, 80)}" appears at line ${at + 1}, but the lines after it differ; read that part of the file again`;
  return "";
}

export const statOrUndefined = (full: string) => stat(full).catch(() => undefined);

/**
 * root 在 git 仓库里时，用 git 列出未被忽略的文件（已跟踪的和未跟踪的），路径相对于 root、用正斜杠。
 * 不在仓库里或没有 git 时返回 undefined
 */
async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { code, stdout: out } = await run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
    if (code !== 0) return undefined;
    // 合并冲突中的文件会出现多次
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}

export async function listFiles(root: string, signal: AbortSignal): Promise<Iterable<string> | AsyncIterable<string>> {
  const tracked = await gitFiles(root);
  if (!tracked) return walk(root, signal);
  return tracked.filter((rel) => !rel.split("/").some((seg) => SKIP_DIRS.has(seg))).map((rel) => path.join(root, rel));
}

/** 不在 git 仓库里时的 glob：遍历目录，跳过隐藏文件和目录（和原先 Bun.Glob#scan 的默认行为一致），产出相对路径 */
async function* scanGlob(root: string, match: (rel: string) => boolean, signal: AbortSignal): AsyncIterable<string> {
  for await (const full of walk(root, signal)) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    if (match(rel)) yield rel;
  }
}

async function* filterAsync<T>(items: Iterable<T>, keep: (item: T) => Promise<boolean>): AsyncIterable<T> {
  for (const item of items) if (await keep(item)) yield item;
}

async function* walk(dir: string, signal: AbortSignal): AsyncIterable<string> {
  signal.throwIfAborted();
  // readdir 的顺序随文件系统而定（APFS 不排序），按名字排好，结果在各平台一致
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}
