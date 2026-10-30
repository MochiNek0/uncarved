// grep 工具：有 ripgrep 时用它（快、并行、自己处理 .gitignore 和二进制文件），没有时用 JS 逐个文件搜索。
// 两条路径产生同样的中间结果（按文件分组的命中行和上下文行），再统一格式化，所以输出格式一致。
//
// ripgrep 的正则语法和 JavaScript 不完全相同（例如不支持环视）。ripgrep 报正则语法错误时改用 JS 搜索，
// 所以模型按 JavaScript 语法写的正则总能用。

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "uncarved";
import { display, listFiles, statOrUndefined } from "./fs.ts";

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
      `optionally only files matching the glob include (e.g. "**/*.ts"). Skips files ignored by git, binary files and .git/node_modules. ` +
      `output_mode: "content" (default) returns "file:line:text" for matches and "file-line-text" for context lines, at most ${MAX_MATCHES} matches; ` +
      `"files" returns only the paths of matching files; "count" returns "file:count". ` +
      `context (0-${MAX_CONTEXT}) adds that many lines before and after each match in content mode.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
        ignore_case: { type: "boolean" },
        output_mode: { type: "string", enum: ["content", "files", "count"] },
        context: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input, { signal }) {
      const { pattern, path: p = ".", include, ignore_case = false, output_mode = "content", context = 0 } = input as {
        pattern: string;
        path?: string;
        include?: string;
        ignore_case?: boolean;
        output_mode?: Mode;
        context?: number;
      };
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
        context: output_mode === "content" ? Math.min(Math.max(context, 0), MAX_CONTEXT) : 0,
        mode: output_mode,
        signal,
      };
      let found: Found | undefined;
      if (rg) {
        const result = await ripgrep(rg, search);
        if (result === "missing") rg = null;
        else found = result;
      }
      found ??= await jsGrep(search);
      return { content: format(cwd, found, search) };
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
  let proc;
  try {
    proc = Bun.spawn([rg, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return "missing";
  }
  const kill = () => proc.kill();
  s.signal.addEventListener("abort", kill, { once: true });
  const files: FileHits[] = [];
  let matches = 0;
  let stopped = false;
  try {
    const stderr = new Response(proc.stderr).text();
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

async function jsGrep(s: Search): Promise<Found> {
  const filter = s.include ? new Bun.Glob(s.include) : undefined;
  const files: FileHits[] = [];
  let matches = 0;
  const single = (await stat(s.root)).isFile();
  const candidates = single ? [s.root] : await listFiles(s.root, s.signal);
  const sorted = Array.isArray(candidates) ? [...candidates].sort() : candidates;
  for await (const file of sorted) {
    s.signal.throwIfAborted();
    if (filter && !single && !filter.match(path.relative(s.root, file).split(path.sep).join("/"))) continue;
    // git 列出的文件可能已在工作区删除
    const info = await statOrUndefined(file);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    const buf = await readFile(file);
    if (buf.includes(0)) continue; // 二进制文件
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
