// 按行比较两段文本，生成带行号和上下文的 unified diff：审批修改时的预览、对话里修改结果的展开内容。从旧 jade 的 ui/diff.ts 移植。
//
// 先去掉相同的开头和结尾，只对中间部分求最长公共子序列；中间部分太大时（整个文件重写）
// 不再逐行比较，整段显示为删除加新增，避免占用大量内存和时间。

import type { Text } from "@uncarved/jade-api";
import { added as plus, dim, lines as joinLines, removed as minus } from "./style.ts";

export type DiffLine = { kind: " " | "-" | "+"; text: string; /** 旧文件里的行号（删除、相同） */ old?: number; /** 新文件里的行号（新增、相同） */ new?: number };

/** LCS 表的上限：中间部分的行数乘积超过它就整段替换 */
const MAX_CELLS = 4_000_000;

const splitLines = (s: string) => {
  if (s === "") return [];
  const lines = s.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** 两段文本的逐行差异，包括相同的行 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: " ", text: a[i]!, old: i + 1, new: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  for (const op of middle(midA, midB)) {
    if (op.kind === " ") out.push({ kind: " ", text: midA[op.i]!, old: start + op.i + 1, new: start + op.j + 1 });
    else if (op.kind === "-") out.push({ kind: "-", text: midA[op.i]!, old: start + op.i + 1 });
    else out.push({ kind: "+", text: midB[op.j]!, new: start + op.j + 1 });
  }
  for (let k = 0; endA + k < a.length; k++) out.push({ kind: " ", text: a[endA + k]!, old: endA + k + 1, new: endB + k + 1 });
  return out;
}

type Op = { kind: " " | "-" | "+"; i: number; j: number };

function middle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [...a.map((_, i) => ({ kind: "-" as const, i, j: 0 })), ...b.map((_, j) => ({ kind: "+" as const, i: 0, j }))];
  }
  // lcs[i][j]：a[i..] 和 b[j..] 的最长公共子序列长度，按行存成一维
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ kind: " ", i: i++, j: j++ });
    // 先删后加：同一处的修改显示成一组 - 再一组 +
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push({ kind: "-", i: i++, j });
    else ops.push({ kind: "+", i, j: j++ });
  }
  while (i < n) ops.push({ kind: "-", i: i++, j });
  while (j < m) ops.push({ kind: "+", i, j: j++ });
  return ops;
}

/** 有改动的行加上前后 context 行；相隔不远的改动合成一段 */
export function hunks(lines: DiffLine[], context = 3): DiffLine[][] {
  const changed = lines.flatMap((l, i) => (l.kind === " " ? [] : [i]));
  const out: DiffLine[][] = [];
  let from = -1;
  let to = -1;
  for (const i of changed) {
    if (from >= 0 && i - context <= to + 1) {
      to = Math.min(lines.length - 1, i + context);
      continue;
    }
    if (from >= 0) out.push(lines.slice(from, to + 1));
    from = Math.max(0, i - context);
    to = Math.min(lines.length - 1, i + context);
  }
  if (from >= 0) out.push(lines.slice(from, to + 1));
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "+") added++;
    else if (l.kind === "-") removed++;
  }
  return { added, removed };
}

/**
 * 显示用：每行前面是行号（新增行用新文件的行号，其余用旧文件的），段与段之间用 ⋯ 分开。
 * 超过 maxLines 行时截断
 */
export function renderDiff(before: string, after: string, maxLines = 60, lines = diffLines(before, after)): Text {
  const parts = hunks(lines);
  if (parts.length === 0) return dim("  (no changes)");
  const width = String(lines.reduce((w, l) => Math.max(w, l.old ?? 0, l.new ?? 0), 0)).length;
  const out: Text[] = [];
  let shown = 0;
  let total = 0;
  for (const h of parts) total += h.length;
  for (const [k, h] of parts.entries()) {
    if (k > 0) out.push(dim(`${" ".repeat(width)}  ⋯`));
    for (const l of h) {
      if (shown >= maxLines) break;
      const no = String((l.kind === "+" ? l.new : l.old) ?? "").padStart(width);
      const text = `${no} ${l.kind} ${l.text}`;
      out.push(l.kind === "+" ? plus(text) : l.kind === "-" ? minus(text) : dim(text));
      shown++;
    }
  }
  if (total > shown) out.push(dim(`  … ${total - shown} more lines`));
  const { added, removed } = diffStats(lines);
  out.push(["  ", plus(`+${added}`), " ", minus(`-${removed}`)]);
  return joinLines(out);
}
