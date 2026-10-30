// 文件工具：read_file / write_file / edit_file / list_dir / glob / grep。
//
// 路径可以是相对路径（相对于工作目录）或绝对路径。policy 插件在 tool.before 里把它们统一成绝对路径，
// 再由关卡判断是否在工作目录内；工具本身不做权限判断。

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "uncarved";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB = 500;
const MAX_GREP = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;
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
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

export function fsTools(cwd: string): Tool[] {
  const at = (p: unknown) => resolveIn(cwd, p as string);

  const readFileTool: Tool = {
    name: "read_file",
    description:
      "Read a UTF-8 text file. Returns lines prefixed with their 1-based line number and a tab. " +
      `At most ${MAX_LINES} lines are returned per call; use offset (1-based start line) and limit to page through larger files.`,
    inputSchema: {
      type: "object",
      properties: { path: str, offset: int, limit: int },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      const { path: p, offset = 1, limit = MAX_LINES } = input as { path: string; offset?: number; limit?: number };
      const text = await readFile(at(p), "utf8");
      if (text.length === 0) return { content: "(empty file)" };
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + Math.min(limit, MAX_LINES));
      if (slice.length === 0) return { content: `(file has ${lines.length} lines; offset ${start} is past the end)`, isError: true };
      const body = slice
        .map((l, i) => `${start + i}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l}`)
        .join("\n");
      const end = start + slice.length - 1;
      return { content: end < lines.length ? `${body}\n(showing lines ${start}-${end} of ${lines.length})` : body };
    },
  };

  const writeFileTool: Tool = {
    name: "write_file",
    description:
      "Create a file or overwrite it with the complete new content. Missing parent directories are created. " +
      "Prefer edit_file for changing part of an existing file.",
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
    async execute(input) {
      const { path: p, content } = input as { path: string; content: string };
      const full = at(p);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
      return { content: `Wrote ${content.split("\n").length} lines to ${display(cwd, full)}` };
    },
  };

  const editFileTool: Tool = {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_string must match the file exactly (including whitespace and indentation) " +
      "and must be unique unless replace_all is true. Read the file first.",
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
      const { path: p, old_string, new_string, replace_all } = input as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      if (old_string === new_string) return { content: "old_string and new_string are identical", isError: true };
      if (old_string === "") return { content: "old_string must not be empty; use write_file to create a file", isError: true };
      const full = at(p);
      const text = await readFile(full, "utf8");
      // 文件是 CRLF 时，模型给的 LF 文本也能匹配
      const crlf = text.includes("\r\n") && !old_string.includes("\r\n");
      const from = crlf ? old_string.replaceAll("\n", "\r\n") : old_string;
      const to = crlf ? new_string.replaceAll("\n", "\r\n") : new_string;
      const count = text.split(from).length - 1;
      if (count === 0) return { content: `old_string not found in ${display(cwd, full)}`, isError: true };
      if (count > 1 && !replace_all) {
        return { content: `old_string occurs ${count} times in ${display(cwd, full)}; add context to make it unique or set replace_all`, isError: true };
      }
      await writeFile(full, replace_all ? text.replaceAll(from, to) : text.replace(from, () => to));
      return { content: `Edited ${display(cwd, full)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})` };
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
      `Skips .git and node_modules. Returns at most ${MAX_GLOB} paths.`,
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
      for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        signal.throwIfAborted();
        if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue;
        if (out.length >= MAX_GLOB) {
          more = true;
          break;
        }
        out.push(display(cwd, path.join(root, rel)));
      }
      out.sort();
      if (out.length === 0) return { content: "No files matched" };
      return { content: out.join("\n") + (more ? `\n(more than ${MAX_GLOB} matches; narrow the pattern)` : "") };
    },
  };

  const grepTool: Tool = {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Searches path (a file or directory, default: the working directory), " +
      `optionally only files matching the glob include (e.g. "**/*.ts"). Returns "file:line:text", at most ${MAX_GREP} matches.`,
    inputSchema: {
      type: "object",
      properties: { pattern: str, path: str, include: str, ignore_case: { type: "boolean" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input, { signal }) {
      const { pattern, path: p = ".", include, ignore_case } = input as {
        pattern: string;
        path?: string;
        include?: string;
        ignore_case?: boolean;
      };
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return { content: `invalid regular expression: ${(err as Error).message}`, isError: true };
      }
      const root = at(p);
      const filter = include ? new Bun.Glob(include) : undefined;
      const out: string[] = [];
      const files = (await stat(root)).isFile() ? [root] : walk(root, signal);
      search: for await (const file of files) {
        if (filter && !filter.match(path.relative(root, file).split(path.sep).join("/"))) continue;
        const info = await stat(file);
        if (info.size > MAX_GREP_FILE_BYTES) continue;
        const buf = await readFile(file);
        if (buf.includes(0)) continue; // 二进制文件
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (const [i, line] of lines.entries()) {
          if (!re.test(line)) continue;
          if (out.length >= MAX_GREP) {
            out.push(`(stopped after ${MAX_GREP} matches; narrow the search)`);
            break search;
          }
          out.push(`${display(cwd, file)}:${i + 1}:${line.length > 300 ? line.slice(0, 300) + "…" : line}`);
        }
      }
      return { content: out.length > 0 ? out.join("\n") : "No matches" };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool];
}

async function* walk(dir: string, signal: AbortSignal): AsyncIterable<string> {
  signal.throwIfAborted();
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}
