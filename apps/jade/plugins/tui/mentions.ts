// @ 引用文件的补全：输入框里打 @ 时找出光标处正在输入的路径、给候选路径排序。
// 候选从工作目录来（git 仓库里只看版本控制的，和 glob 一样），发送时附上文件内容由 jade/mentions 负责。

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** 候选（文件加目录）最多这么多，再多也只是拖慢补全 */
const MAX_CANDIDATES = 20_000;

/** 光标正在输入的 @ 引用：@ 的下标和已经输入的部分；不在引用里时返回 undefined */
export function mentionAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(?:^|\s)@("?[^\s"]*)$/.exec(value.slice(0, cursor));
  if (!m) return undefined;
  return { start: cursor - m[1]!.length - 1, query: m[1]!.replace(/^"/, "") };
}

/** 补全后的文本：@ 引用加一个空格，含空白的路径加引号 */
export const mentionText = (p: string) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);

/**
 * 按 query 给候选路径排序：文件名以 query 开头的最前，其次文件名包含、路径包含，
 * 最后是按顺序出现 query 每个字符的模糊匹配；同一档里短的在前
 */
export function rankPaths(paths: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase().replaceAll("\\", "/");
  if (!q) return paths.filter((p) => !p.slice(0, -1).includes("/")).slice(0, limit);
  const scored: { p: string; score: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.replace(/\/$/, "").split("/").pop()!;
    let score: number;
    if (lower.startsWith(q)) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else if (subsequence(lower, q)) score = 4;
    else continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return scored.slice(0, limit).map((s) => s.p);
}

function subsequence(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/**
 * @ 补全的候选：工作目录里的文件（git 仓库里只看版本控制的）和它们所在的目录，目录以 / 结尾。
 * 5 秒还没列完就先给已经找到的（大仓库第一次列得慢，不该让输入框卡住）
 */
export async function mentionCandidates(cwd: string, signal: AbortSignal = AbortSignal.timeout(5000)): Promise<string[]> {
  const files: string[] = [];
  const dirs = new Set<string>();
  try {
    for await (const full of await listFiles(cwd, signal)) {
      const rel = display(cwd, full);
      files.push(rel);
      for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
        const dir = rel.slice(0, i + 1);
        if (dirs.has(dir)) break;
        dirs.add(dir);
      }
      if (files.length + dirs.size >= MAX_CANDIDATES) break;
    }
  } catch {
    // 列到一半被中止（超时）：用已经找到的
  }
  return [...dirs, ...files];
}

// 以下和 jade/fs 的 listFiles、display 相同：插件之间不共享代码（只能共享类型），所以这里留一份

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** 显示用：工作目录内的路径用相对形式，统一为正斜杠 */
function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

/** git 仓库里的文件（版本控制的和没忽略的新文件）；不是仓库、没有 git 时 undefined */
function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, out) =>
      // 合并冲突中的文件会出现多次
      resolve(err ? undefined : [...new Set(out.split("\0").filter(Boolean))]),
    );
  });
}

async function listFiles(root: string, signal: AbortSignal): Promise<Iterable<string> | AsyncIterable<string>> {
  const tracked = await gitFiles(root);
  if (!tracked) return walk(root, signal);
  return tracked.filter((rel) => !rel.split("/").some((seg) => SKIP_DIRS.has(seg))).map((rel) => path.join(root, rel));
}

async function* walk(dir: string, signal: AbortSignal): AsyncIterable<string> {
  signal.throwIfAborted();
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
