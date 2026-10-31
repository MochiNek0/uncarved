// @ 引用文件：输入框里打 @ 时补全路径，发送时把引用的文件内容随消息一起交给模型。
//
// 内容用 read_file / list_dir 工具本身读取，格式和模型自己读到的一样（带行号），
// 而且算作"读过"：模型可以直接修改引用的文件，不用先再读一遍。
// 只有存在的路径才算引用，所以消息里普通的 @someone 原样保留。

import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, Tool, ToolContext } from "uncarved";
import { display, listFiles } from "./tools/fs.ts";

/** 补全用的候选最多这么多个（文件加目录） */
const MAX_CANDIDATES = 20_000;

/** @ 后面的路径：@"带 空格 的路径" 或者到空白为止 */
const MENTION = /(?<=^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;

/** 光标正在输入的 @ 引用：@ 的下标和已经输入的部分；不在引用里时返回 undefined */
export function mentionAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(?:^|\s)@("?[^\s"]*)$/.exec(value.slice(0, cursor));
  if (!m) return undefined;
  return { start: cursor - m[1]!.length - 1, query: m[1]!.replace(/^"/, "") };
}

/** 补全后的文本：@ 引用加一个空格，含空白的路径加引号 */
export const mentionText = (p: string) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);

/** 消息里引用的路径，去重，按出现顺序；末尾的标点（句号、逗号……）不算路径 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const p = m[1] ?? m[2]!.replace(/[.,;:!?)\]}，。；：！？）】]+$/u, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

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

/** 补全的候选：工作目录里未被 git 忽略的文件和它们所在的目录（目录以 / 结尾），相对路径、正斜杠 */
export async function mentionCandidates(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const dirs = new Set<string>();
  for await (const full of await listFiles(cwd, AbortSignal.timeout(5000))) {
    const rel = display(cwd, full);
    files.push(rel);
    for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
      const dir = rel.slice(0, i + 1);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
    if (files.length + dirs.size >= MAX_CANDIDATES) break;
  }
  return [...dirs, ...files];
}

export interface Attachments {
  /** 随消息发出的内容 */
  blocks: Block[];
  /** 附上了的路径（显示用） */
  attached: string[];
  /** 存在但读不了的 */
  failed: { path: string; reason: string }[];
}

/** 读取消息里引用的文件和目录；tools 里要有 read_file 和 list_dir */
export async function attachMentions(text: string, opts: { cwd: string; tools: Tool[]; sessionId: string; signal: AbortSignal }): Promise<Attachments> {
  const out: Attachments = { blocks: [], attached: [], failed: [] };
  const tool = (name: string) => opts.tools.find((t) => t.name === name);
  let n = 0;
  for (const p of parseMentions(text)) {
    const full = path.resolve(opts.cwd, p.replace(/^~(?=$|[\\/])/, os.homedir()));
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    const name = info.isDirectory() ? "list_dir" : "read_file";
    const t = tool(name);
    if (!t) continue;
    const ctx: ToolContext = {
      sessionId: opts.sessionId,
      toolUseId: `mention-${Date.now()}-${n++}`,
      signal: opts.signal,
      parent: { sessionId: opts.sessionId, eventId: "" },
      progress: () => {},
    };
    const shown = display(opts.cwd, full);
    try {
      const r = await t.execute({ path: full }, ctx);
      if (r.isError) {
        out.failed.push({ path: shown, reason: typeof r.content === "string" ? r.content : "could not be read" });
        continue;
      }
      const what = name === "list_dir" ? "the directory" : "the file";
      const head = `[Note from jade] The user referenced ${what} ${shown}. Its content, as ${name} returns it:`;
      out.blocks.push({ kind: "text", text: head, origin: { by: "host" }, trust: "trusted" });
      out.blocks.push(
        ...(typeof r.content === "string"
          ? [{ kind: "text" as const, text: r.content, origin: { by: "tool" as const, name }, trust: "untrusted" as const }]
          : r.content),
      );
      out.attached.push(shown);
    } catch (err) {
      out.failed.push({ path: shown, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
