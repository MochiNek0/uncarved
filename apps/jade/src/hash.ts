// 插件目录内容的哈希：安装时记下来，更新时用来判断装好的插件有没有被手动改过。
//
// 和内核的 hashDir 不同，这里只算插件自己的源码：
// - node_modules 是包装出来的，不参与；
// - .git 不参与；
// - 包管理器生成的 lock 文件不参与（更新时会被重新生成）。

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);
const SKIP_FILES: ReadonlySet<string> = new Set(["package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"]);

/** 按相对路径排序，依次计入路径、长度、内容；和 hashDir 的格式一致，但不跟随符号链接 */
export async function treeHash(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const abs = path.join(e.parentPath ?? root, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const parts = rel.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;
    if (SKIP_FILES.has(parts.at(-1) ?? "")) continue;
    if (e.isFile()) files.push(rel);
  }
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const content = await readFile(path.join(root, rel));
    h.update(`${rel}\0${content.length}\0`).update(content);
  }
  return h.digest("hex");
}
