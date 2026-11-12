// 输入框里 @ 补全的候选：工作目录里的文件（git 仓库里只看版本控制的，和 glob 一样）和它们所在的目录。
// 经 completions@1 交给前端，前端只管排序和插入。原来在 jade/tui 里，搬到这里：@ 的意思归 jade/mentions。

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { display } from "./attach.ts";

/** 候选（文件加目录）最多这么多，再多也只是拖慢补全 */
const MAX_CANDIDATES = 20_000;

/**
 * 工作目录里的文件和它们所在的目录，目录以 / 结尾。
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

// 以下和 jade/fs 的 listFiles 相同：插件之间不共享代码（只能共享类型），所以这里留一份

const SKIP_DIRS = new Set([".git", "node_modules"]);

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
