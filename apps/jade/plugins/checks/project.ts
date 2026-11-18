// 仓库目录、确认记录、显示用的小工具。插件之间不共享代码（只能共享类型），jade/mcp、jade/skills 各有一份。

import type { Span, Text, TextStyle, Trust } from "@uncarved/jade-api";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** git 仓库的根目录（往上找 .git，目录或文件都算）；不在仓库里时是 cwd 本身 */
export function repoRoot(cwd: string): string {
  let d = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d;
    const parent = path.dirname(d);
    if (parent === d) return path.resolve(cwd);
    d = parent;
  }
}

/** 工作目录里的显示成相对路径，外面的显示绝对路径 */
export function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// 带语义样式的文字（jade-api 的 Text）：插件只说这段是次要的、成功、警告……，怎么画由前端决定
const styled = (style: TextStyle) => (text: string): Span => ({ text, style });
export const dim = styled("dim");
export const bold = styled("bold");
export const ok = styled("ok");
export const warn = styled("warn");
export const error = styled("error");
/** 几行接成一段，行之间换行 */
export const lines = (rows: readonly Text[]): Text => rows.flatMap((r, i) => (i ? ["\n", r] : [r]));

/**
 * 0.3.1 及以前，本插件自己把确认记在 $JADE_HOME/trust.jsonl（每行 { hash, path, at }）。升级后照认，不用再确认一遍：
 * trust@1 里没有时查这份旧文件，查到了顺手记进 trust@1。这是本插件自己的旧数据，核心不认识它
 */
export function withLegacyTrust(trust: Trust, home: string): Trust {
  let legacy: Promise<Map<string, string>> | undefined;
  const read = async () => {
    const hashes = new Map<string, string>();
    let text = "";
    try {
      text = await readFile(path.join(home, "trust.jsonl"), "utf8");
    } catch {
      return hashes;
    }
    for (const line of text.split("\n")) {
      try {
        const r = JSON.parse(line) as { hash?: unknown; path?: unknown };
        if (typeof r.hash === "string") hashes.set(r.hash, typeof r.path === "string" ? r.path : "");
      } catch {
        // 空行、写到一半的行
      }
    }
    return hashes;
  };
  return {
    has: async (hash) => {
      if (await trust.has(hash)) return true;
      const where = (await (legacy ??= read())).get(hash);
      if (where === undefined) return false;
      await trust.add(hash, where).catch(() => {});
      return true;
    },
    add: (hash, where) => trust.add(hash, where),
  };
}
