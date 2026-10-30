// 文件工具：read_file / write_file / edit_file / list_dir / glob / grep。
//
// 路径可以是相对路径（相对于工作目录）或绝对路径。policy 插件在 tool.before 里把它们统一成绝对路径，
// 再由关卡判断是否在工作目录内；工具本身不做权限判断。
//
// 修改已有文件之前必须先读过它，且读过之后文件没有被别人（用户、bash 命令）改过，
// 否则模型是按过时的内容在改，会覆盖掉别人的修改。和修改在同一次回复里发出的读取不算：
// 那次修改的内容是模型看到读取结果之前就写好的。

import type { Stats } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Tool } from "uncarved";
import { sha256, type Checkpoints } from "./checkpoint.ts";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB = 500;
const MAX_GREP = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
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
  /** 给了就在每次写入前保存原内容，供撤销；也用它记下读过的文件，恢复会话后不用重新读 */
  checkpoints?: Checkpoints;
  /** 模型调用的次数，每次调用模型前加一（见 distro 的 model.before hook）。不给就不检查同一次回复里的先读后改 */
  responses?: { readonly calls: number };
}

/** 读过或写过的文件当时的样子；只在本进程内有效，恢复的会话靠 checkpoints 里记的 sha256 */
interface Seen {
  mtimeMs: number;
  size: number;
  /** 读取时的 responses.calls；写入的文件模型知道内容，记为 -1 */
  call: number;
}

export function fsTools(cwd: string, opts: FsOptions = {}): Tool[] {
  const at = (p: unknown) => resolveIn(cwd, p as string);
  const seen = new Map<string, Seen>();
  /** 文件没变时保留更早的 call：之前的回复里读过，这次回复里又读一遍，不影响修改 */
  const remember = async (ctx: { sessionId: string }, full: string, info: Stats, text: string, call: number) => {
    const s = seen.get(full);
    const same = s !== undefined && s.mtimeMs === info.mtimeMs && s.size === info.size;
    seen.set(full, { mtimeMs: info.mtimeMs, size: info.size, call: same ? Math.min(s.call, call) : call });
    await opts.checkpoints?.markSeen(ctx.sessionId, full, sha256(text));
  };
  /** 不能修改已有文件的原因；可以修改时返回 undefined。text 是文件现在的内容 */
  const staleness = async (ctx: { sessionId: string }, full: string, info: Stats, text: string): Promise<string | undefined> => {
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
    // 恢复的会话：之前的进程里读过或写过
    const hash = await opts.checkpoints?.seenHash(ctx.sessionId, full);
    if (hash === undefined) return `${shown} exists but has not been read in this session. Read it with read_file before changing it.`;
    if (hash !== sha256(text)) return modified;
    seen.set(full, { mtimeMs: info.mtimeMs, size: info.size, call: -1 });
    return undefined;
  };
  const checkpoint = async (ctx: { sessionId: string; toolUseId: string }, tool: string, full: string, before: string | null, after: string) => {
    await opts.checkpoints?.save(ctx.sessionId, { toolUseId: ctx.toolUseId, tool, path: full, before, afterHash: sha256(after) });
  };

  const readFileTool: Tool = {
    name: "read_file",
    description:
      "Read a UTF-8 text file, or an image (png, jpg, gif, webp). Text is returned as lines prefixed with their 1-based line number and a tab. " +
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
      const buf = await readFile(full);
      if (buf.subarray(0, 8000).includes(0)) {
        return { content: `${display(cwd, full)} is a binary file (${buf.length} bytes) and cannot be shown as text`, isError: true };
      }
      const text = buf.toString("utf8");
      await remember(ctx, full, info, text, opts.responses?.calls ?? -1);
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
      const { path: p, content } = input as { path: string; content: string };
      const full = at(p);
      const info = await statOrUndefined(full);
      if (info?.isDirectory()) return { content: `${display(cwd, full)} is a directory`, isError: true };
      // 同样内容重复写入（崩溃后重跑）不算覆盖别人的修改
      const before = info ? await readFile(full, "utf8") : null;
      const problem = info && before !== null && before !== content ? await staleness(ctx, full, info, before) : undefined;
      if (problem) return { content: problem, isError: true };
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
      await remember(ctx, full, await stat(full), content, -1);
      if (before !== content) await checkpoint(ctx, "write_file", full, before, content);
      // 和 read_file 一样数行：末尾的换行不算多出一行
      const lines = content === "" ? 0 : content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0);
      return { content: `Wrote ${lines} lines to ${display(cwd, full)}` };
    },
  };

  const editFileTool: Tool = {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_string must match the file exactly (including whitespace and indentation) " +
      "and must be unique unless replace_all is true. The file must have been read with read_file first, " +
      "and is refused if it changed since then.",
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
    async execute(input, ctx) {
      const { path: p, old_string, new_string, replace_all } = input as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      if (old_string === new_string) return { content: "old_string and new_string are identical", isError: true };
      if (old_string === "") return { content: "old_string must not be empty; use write_file to create a file", isError: true };
      const full = at(p);
      const info = await statOrUndefined(full);
      if (!info) {
        return { content: seen.has(full) ? `${display(cwd, full)} no longer exists` : `${display(cwd, full)} does not exist; use write_file to create it`, isError: true };
      }
      const text = await readFile(full, "utf8");
      const problem = await staleness(ctx, full, info, text);
      if (problem) return { content: problem, isError: true };
      // 文件是 CRLF 时，模型给的 LF 文本也能匹配
      const crlf = text.includes("\r\n") && !old_string.includes("\r\n");
      const from = crlf ? old_string.replaceAll("\n", "\r\n") : old_string;
      const to = crlf ? new_string.replaceAll("\n", "\r\n") : new_string;
      const count = text.split(from).length - 1;
      if (count === 0) return { content: `old_string not found in ${display(cwd, full)}`, isError: true };
      if (count > 1 && !replace_all) {
        return { content: `old_string occurs ${count} times in ${display(cwd, full)}; add context to make it unique or set replace_all`, isError: true };
      }
      // 用函数作替换值，new_string 里的 $& $1 等不会被当成替换模式
      const next = replace_all ? text.replaceAll(from, () => to) : text.replace(from, () => to);
      await writeFile(full, next);
      await remember(ctx, full, await stat(full), next, -1);
      await checkpoint(ctx, "edit_file", full, text, next);
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
      const glob = new Bun.Glob(pattern);
      const tracked = await gitFiles(root);
      const candidates = tracked
        ? filterAsync(tracked, async (rel) => glob.match(rel) && Boolean((await statOrUndefined(path.join(root, rel)))?.isFile()))
        : glob.scan({ cwd: root, onlyFiles: true });
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
      if (out.length === 0) return { content: "No files matched" };
      return { content: out.join("\n") + (more ? `\n(more than ${MAX_GLOB} matches; narrow the pattern)` : "") };
    },
  };

  const grepTool: Tool = {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Searches path (a file or directory, default: the working directory), " +
      `optionally only files matching the glob include (e.g. "**/*.ts"). Skips files ignored by git and binary files. ` +
      `Returns "file:line:text", at most ${MAX_GREP} matches.`,
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
      const files = (await stat(root)).isFile() ? [root] : await listFiles(root, signal);
      search: for await (const file of files) {
        signal.throwIfAborted();
        if (filter && !filter.match(path.relative(root, file).split(path.sep).join("/"))) continue;
        // git 列出的文件可能已在工作区删除
        const info = await statOrUndefined(file);
        if (!info?.isFile() || info.size > MAX_GREP_FILE_BYTES) continue;
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

const statOrUndefined = (full: string) => stat(full).catch(() => undefined);

/**
 * root 在 git 仓库里时，用 git 列出未被忽略的文件（已跟踪的和未跟踪的），路径相对于 root、用正斜杠。
 * 不在仓库里或没有 git 时返回 undefined
 */
async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return undefined;
    // 合并冲突中的文件会出现多次
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}

async function listFiles(root: string, signal: AbortSignal): Promise<Iterable<string> | AsyncIterable<string>> {
  const tracked = await gitFiles(root);
  if (!tracked) return walk(root, signal);
  return tracked.filter((rel) => !rel.split("/").some((seg) => SKIP_DIRS.has(seg))).map((rel) => path.join(root, rel));
}

async function* filterAsync<T>(items: Iterable<T>, keep: (item: T) => Promise<boolean>): AsyncIterable<T> {
  for (const item of items) if (await keep(item)) yield item;
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
