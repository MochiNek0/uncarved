// 读取消息里 @ 引用的文件和目录。只有存在的路径才算引用，所以消息里普通的 @someone 原样保留。
//
// 旧 jade 用 read_file / list_dir 工具本身读取，读到的文件算作"读过"；jade/fs 的工具是它会话里的私有对象，
// 别的插件拿不到，所以这里自己读，格式和 read_file、list_dir 返回的一样（带行号）。

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block } from "uncarved";

/** @ 后面的路径：@"带 空格 的路径" 或者到空白为止 */
const MENTION = /(?<=^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 100_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_PDF_BYTES = 10_000_000;
/** 一条消息最多附上几个引用 */
const MAX_MENTIONS = 20;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 消息里引用的路径，去重，按出现顺序；末尾的标点（句号、逗号……）不算路径 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const p = m[1] ?? m[2]!.replace(/[.,;:!?)\]}，。；：！？）】]+$/u, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 显示用：工作目录内的路径用相对形式，统一为正斜杠 */
export function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

export interface Attachments {
  /** 随消息发出的内容 */
  blocks: Block[];
  /** 附上了的路径（显示用） */
  attached: string[];
  /** 存在但读不了的 */
  failed: { path: string; reason: string }[];
}

/** 读取消息里引用的文件和目录 */
export async function attachMentions(text: string, opts: { cwd: string; plugin: string; signal?: AbortSignal }): Promise<Attachments> {
  const out: Attachments = { blocks: [], attached: [], failed: [] };
  const origin = { by: "plugin" as const, id: opts.plugin };
  for (const p of parseMentions(text).slice(0, MAX_MENTIONS)) {
    opts.signal?.throwIfAborted();
    const full = path.resolve(opts.cwd, p.replace(/^~(?=$|[\\/])/, os.homedir()));
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    const shown = display(opts.cwd, full);
    try {
      const dir = info.isDirectory();
      const content = dir ? await listDir(full) : await readAny(full, shown, info.size);
      if (typeof content === "object" && "error" in content) {
        out.failed.push({ path: shown, reason: content.error });
        continue;
      }
      const head = dir
        ? `[Note from jade] The user referenced the directory ${shown}. Its entries, as list_dir returns them:`
        : `[Note from jade] The user referenced the file ${shown}. Its content, as read_file returns it (read it with read_file before editing it):`;
      out.blocks.push({ kind: "text", text: head, origin, trust: "trusted" });
      if (typeof content === "string") out.blocks.push({ kind: "text", text: content, origin, trust: "untrusted" });
      else out.blocks.push(content.block);
      out.attached.push(shown);
    } catch (err) {
      out.failed.push({ path: shown, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;

  async function readAny(full: string, shown: string, size: number): Promise<string | { block: Block } | { error: string }> {
    const ext = path.extname(full).toLowerCase();
    const mediaType = IMAGE_TYPES[ext];
    if (mediaType) {
      if (size > MAX_IMAGE_BYTES) return { error: `image is ${size} bytes; at most ${MAX_IMAGE_BYTES} can be attached` };
      const data = (await readFile(full)).toString("base64");
      return { block: { kind: "image", source: { type: "base64", media_type: mediaType, data }, origin, trust: "untrusted" } };
    }
    if (ext === ".pdf") {
      if (size > MAX_PDF_BYTES) return { error: `PDF is ${size} bytes; at most ${MAX_PDF_BYTES} can be attached` };
      const data = (await readFile(full)).toString("base64");
      return { block: { kind: "document", source: { type: "base64", media_type: "application/pdf", data }, origin, trust: "untrusted" } };
    }
    const buf = await readFile(full);
    if (buf.subarray(0, 8000).includes(0)) return { error: `${shown} is a binary file (${buf.length} bytes) and cannot be shown as text` };
    return numbered(buf.toString("utf8"));
  }
}

/** 和 read_file 一样：每行前面是从 1 开始的行号和一个制表符，超长的截断 */
function numbered(text: string): string {
  if (text.length === 0) return "(empty file)";
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const slice = lines.slice(0, MAX_LINES);
  const out: string[] = [];
  let size = 0;
  for (const [i, l] of slice.entries()) {
    const row = `${i + 1}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated: ${l.length} characters]` : l}`;
    if (out.length > 0 && size + row.length + 1 > MAX_READ_CHARS) break;
    out.push(row);
    size += row.length + 1;
  }
  const body = out.join("\n");
  if (out.length < lines.length) return `${body}\n(showing lines 1-${out.length} of ${lines.length}; read_file with offset ${out.length + 1} for the rest)`;
  return body;
}

async function listDir(full: string): Promise<string> {
  const entries = await readdir(full, { withFileTypes: true });
  const names = entries.map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();
  return names.length > 0 ? names.join("\n") : "(empty directory)";
}
