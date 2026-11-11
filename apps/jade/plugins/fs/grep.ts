// grep 工具：有 ripgrep 时用它（快、并行、自己处理 .gitignore 和二进制文件），没有时用 JS 逐个文件搜索。
// 两条路径产生同样的中间结果（按文件分组的命中行和上下文行），再统一格式化，所以输出格式一致。
//
// ripgrep 的正则语法和 JavaScript 不完全相同（例如不支持环视）。ripgrep 报正则语法错误时改用 JS 搜索，
// 所以模型按 JavaScript 语法写的正则总能用。

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "uncarved";
import { display, listFiles, statOrUndefined } from "./fs.ts";
import { globMatcher, spawn, text, type Proc } from "./sys.ts";

const MAX_MATCHES = 200;
const MAX_FILES = 500;
const MAX_CONTEXT = 10;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;

export interface GrepOptions {
  /** ripgrep 可执行文件，默认 "rg"；null 表示不用 ripgrep（测试） */
  rg?: string | null;
}

type Mode = "content" | "files" | "count";

interface Line {
  n: number;
  text: string;
  match: boolean;
}

interface FileHits {
  file: string;
  /** 命中的行数 */
  count: number;
  /** content 模式下的命中行和上下文行，按行号排序 */
  lines: Line[];
}

interface Search {
  root: string;
  re: RegExp;
  pattern: string;
  ignoreCase: boolean;
  include?: string;
  context: number;
  mode: Mode;
  signal: AbortSignal;
}

interface Found {
  files: FileHits[];
  /** 因为达到上限而提前停下 */
  truncated: boolean;
}

export function grepTool(cwd: string, opts: GrepOptions = {}): Tool {
  /** 第一次找不到 ripgrep 之后不再尝试 */
  let rg = opts.rg === undefined ? "rg" : opts.rg;
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression (JavaScript syntax). Searches path (a file or directory, default: the working directory), " +
      `optionally only files matching the glob include (e.g. "*.ts" matches at any depth; "src/**/*.ts" limits it to src). Skips files ignored by git, binary files and .git/node_modules. ` +
      `output_mode: "content" (default) returns "file:line:text" for matches and "file-line-text" for context lines, at most ${MAX_MATCHES} matches; ` +
      `"files" returns only the paths of matching files; "count" returns "file:count". ` +
      `context (0-${MAX_CONTEXT}) adds that many lines before and after each match in content mode. ` +
      "head_limit keeps only the first that many lines of the output.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
        ignore_case: { type: "boolean" },
        // files_with_matches 是 ripgrep / Claude Code 的叫法，很多模型会这样传，当作 files
        output_mode: { type: "string", enum: ["content", "files", "count", "files_with_matches"] },
        context: { type: "integer" },
        // head_limit、glob 也是 ripgrep / Claude Code 的叫法；不接受的话模型要多花一轮去掉它们重发。
        // 有的模型把数字写成字符串（"30"），也接受
        head_limit: { type: ["integer", "string"] },
        glob: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input, { signal }) {
      const { pattern, path: p = ".", glob, include = glob, ignore_case = false, output_mode = "content", context = 0, head_limit } = input as {
        pattern: string;
        path?: string;
        include?: string;
        glob?: string;
        head_limit?: number | string;
        ignore_case?: boolean;
        output_mode?: Mode | "files_with_matches";
        context?: number;
      };
      const mode: Mode = output_mode === "files_with_matches" ? "files" : output_mode;
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return { content: `invalid regular expression: ${(err as Error).message}`, isError: true };
      }
      const search: Search = {
        root: path.resolve(cwd, p),
        re,
        pattern,
        ignoreCase: ignore_case,
        include,
        context: mode === "content" ? Math.min(Math.max(context, 0), MAX_CONTEXT) : 0,
        mode,
        signal,
      };
      let found: Found | undefined;
      if (rg) {
        const result = await ripgrep(rg, search);
        if (result === "missing") rg = null;
        else found = result;
      }
      found ??= await jsGrep(search);
      const lines = format(cwd, found, search).split("\n");
      const limit = Number(head_limit);
      if (limit > 0 && lines.length > limit) lines.splice(limit, Infinity, `(showing the first ${limit} of ${lines.length} lines)`);
      return { content: lines.join("\n") };
    },
  };
}

function format(cwd: string, { files, truncated }: Found, s: Search): string {
  if (files.length === 0) return "No matches";
  const shown = (f: FileHits) => display(cwd, f.file);
  if (s.mode === "files") {
    const out = files.slice(0, MAX_FILES).map(shown);
    if (files.length > MAX_FILES || truncated) out.push(`(stopped after ${MAX_FILES} files; narrow the search)`);
    return out.join("\n");
  }
  if (s.mode === "count") {
    const out = files.slice(0, MAX_FILES).map((f) => `${shown(f)}:${f.count}`);
    if (files.length > MAX_FILES || truncated) out.push(`(stopped after ${MAX_FILES} files; narrow the search)`);
    return out.join("\n");
  }
  const out: string[] = [];
  let matches = 0;
  for (const f of files) {
    const name = shown(f);
    let prev: number | undefined;
    for (const l of f.lines) {
      if (l.match && matches >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      if (s.context > 0 && prev !== undefined && l.n > prev + 1) out.push("--");
      if (s.context > 0 && prev === undefined && out.length > 0) out.push("--");
      const text = l.text.length > MAX_LINE_CHARS ? l.text.slice(0, MAX_LINE_CHARS) + "…" : l.text;
      out.push(`${name}${l.match ? ":" : "-"}${l.n}${l.match ? ":" : "-"}${text}`);
      if (l.match) matches++;
      prev = l.n;
    }
    if (matches >= MAX_MATCHES && truncated) break;
  }
  // 末尾可能是最后一个命中之后多出来的上下文行，保留也无妨
  if (truncated) out.push(`(stopped after ${MAX_MATCHES} matches; narrow the search)`);
  return out.join("\n");
}

/** 达到这个数量就够用了，不用再搜下去 */
const enough = (s: Search, files: FileHits[], matches: number) =>
  s.mode === "content" ? matches > MAX_MATCHES : files.length > MAX_FILES;

// ---------- ripgrep ----------

/** ripgrep 不存在时返回 "missing"；正则语法 ripgrep 不支持时返回 undefined，由调用方改用 JS 搜索 */
async function ripgrep(rg: string, s: Search): Promise<Found | undefined | "missing"> {
  const args = ["--json", "--sort", "path", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-filesize", `${MAX_FILE_BYTES}`];
  if (s.ignoreCase) args.push("--ignore-case");
  if (s.context > 0) args.push("--context", String(s.context));
  if (s.include) args.push("--glob", s.include);
  args.push("--regexp", s.pattern, "--", s.root);
  let proc: Proc;
  try {
    proc = await spawn([rg, ...args]);
  } catch {
    return "missing";
  }
  const kill = () => proc.kill();
  s.signal.addEventListener("abort", kill, { once: true });
  const files: FileHits[] = [];
  let matches = 0;
  let stopped = false;
  try {
    const stderr = text(proc.stderr);
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string) => {
      if (!line) return;
      const ev = JSON.parse(line) as { type: string; data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
      if (ev.type !== "match" && ev.type !== "context") return;
      const file = ev.data.path?.text;
      const text = ev.data.lines?.text;
      // 不是合法 UTF-8 的路径或内容（ripgrep 给的是 bytes），跳过
      if (file === undefined || text === undefined || ev.data.line_number === undefined) return;
      const full = path.resolve(file);
      let hits = files.at(-1);
      if (hits?.file !== full) {
        hits = { file: full, count: 0, lines: [] };
        files.push(hits);
      }
      const match = ev.type === "match";
      if (match) {
        hits.count++;
        matches++;
      }
      if (s.mode === "content") hits.lines.push({ n: ev.data.line_number, text: text.replace(/\r?\n$/, ""), match });
    };
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      // count 模式要数完每个文件，只有文件数超了才停
      if (enough(s, files, matches)) {
        stopped = true;
        proc.kill();
        break;
      }
    }
    if (!stopped) handle(buf);
    const [code, err] = await Promise.all([proc.exited, stderr]);
    s.signal.throwIfAborted();
    // 1：没有命中；2：出错，但部分文件出错（例如没有权限）时其余结果仍然有效
    if (!stopped && code === 2 && /regex parse error|error parsing regex|look-?around|backreference/i.test(err)) return undefined;
    return { files, truncated: stopped };
  } finally {
    s.signal.removeEventListener("abort", kill);
  }
}

// ---------- JS ----------

/** 同时读几个文件。逐个等 stat、readFile 时，几万个文件的仓库要好几秒（多数时间花在等 IO 上） */
const READ_AHEAD = 16;

/** 读出可以搜的文本；不存在（git 列出的文件可能已在工作区删除）、太大、二进制的返回 undefined */
async function readSearchable(file: string): Promise<Buffer | undefined> {
  const info = await statOrUndefined(file);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  const buf = await readFile(file).catch(() => undefined);
  return buf && !buf.includes(0) ? buf : undefined;
}

/** 按 items 的顺序产出 fn 的结果，最多 n 个同时进行；调用方提前停止时，已经开始的读取随它结束 */
async function* ordered<T, R>(items: Iterable<T> | AsyncIterable<T>, n: number, fn: (item: T) => Promise<R>): AsyncGenerator<[T, R]> {
  const pending: { item: T; result: Promise<R> }[] = [];
  for await (const item of items) {
    const result = fn(item);
    // 先挂上处理，免得提前停止时没人等的 Promise 报 unhandled rejection
    result.catch(() => {});
    pending.push({ item, result });
    if (pending.length >= n) {
      const head = pending.shift()!;
      yield [head.item, await head.result];
    }
  }
  for (const p of pending) yield [p.item, await p.result];
}

async function jsGrep(s: Search): Promise<Found> {
  // 和 ripgrep 的 --glob 一致：不含 / 的模式（"*.ts"）匹配任意深度的文件名
  const filter = s.include ? globMatcher(s.include.includes("/") ? s.include : `**/${s.include}`) : undefined;
  const files: FileHits[] = [];
  let matches = 0;
  const single = (await stat(s.root)).isFile();
  const candidates = single ? [s.root] : await listFiles(s.root, s.signal);
  const sorted = Array.isArray(candidates) ? [...candidates].sort() : candidates;
  const wanted = async function* () {
    for await (const file of sorted) {
      if (filter && !single && !filter(path.relative(s.root, file).split(path.sep).join("/"))) continue;
      yield file;
    }
  };
  for await (const [file, buf] of ordered(wanted(), READ_AHEAD, readSearchable)) {
    s.signal.throwIfAborted();
    if (!buf) continue;
    const all = buf.toString("utf8").split(/\r?\n/);
    if (all.at(-1) === "") all.pop();
    const hits: FileHits = { file, count: 0, lines: [] };
    let last = -1;
    for (const [i, text] of all.entries()) {
      if (!s.re.test(text)) continue;
      hits.count++;
      matches++;
      if (s.mode !== "content") continue;
      for (let j = Math.max(i - s.context, last + 1); j <= Math.min(i + s.context, all.length - 1); j++) {
        hits.lines.push({ n: j + 1, text: all[j]!, match: j === i || s.re.test(all[j]!) });
        last = j;
      }
      if (matches > MAX_MATCHES) break;
    }
    if (hits.count > 0) files.push(hits);
    if (enough(s, files, matches)) return { files, truncated: true };
  }
  return { files, truncated: false };
}
