// 输入框里的补全（completions@1，例如 jade/mentions 的 @ 文件）：找出光标处正在输入的那一段、给候选排序。
// 候选从登记的插件来，发送之后拿它做什么也归它；这里只认触发字符，不知道候选是什么。

/** 光标正在输入的补全：触发字符、它的下标和已经输入的部分；不在补全里时返回 undefined。triggers 是登记了的触发字符 */
export function mentionAt(value: string, cursor: number, triggers: readonly string[]): { trigger: string; start: number; query: string } | undefined {
  if (triggers.length === 0) return undefined;
  const chars = triggers.map((t) => t.replace(/[\\^\]\-]/g, "\\$&")).join("");
  const m = new RegExp(`(?:^|\\s)([${chars}])("?[^\\s"]*)$`, "u").exec(value.slice(0, cursor));
  if (!m) return undefined;
  return { trigger: m[1]!, start: cursor - m[2]!.length - m[1]!.length, query: m[2]!.replace(/^"/, "") };
}

/** 补全后的文本：触发字符加候选，含空白的加引号 */
export const mentionText = (trigger: string, p: string) => (/\s/.test(p) ? `${trigger}"${p}"` : `${trigger}${p}`);

/** 候选路径预先算好的小写形式和文件名（目录去掉末尾的 /），每按一个键都要用，不重复算 */
interface Prepared {
  lower: string;
  base: string;
}
const prepared = new WeakMap<readonly string[], Prepared[]>();

function prepare(paths: readonly string[]): Prepared[] {
  let out = prepared.get(paths);
  if (!out) {
    out = paths.map((p) => {
      const lower = p.toLowerCase();
      const trimmed = lower.endsWith("/") ? lower.slice(0, -1) : lower;
      return { lower, base: trimmed.slice(trimmed.lastIndexOf("/") + 1) };
    });
    prepared.set(paths, out);
  }
  return out;
}

/**
 * 上一次排序时命中的全部候选（下标）。query 只是在后面追加了字符时，新的命中一定在这些里面
 * （包含 q 加字符的也包含 q，按顺序出现的同理），只筛它们，不用再扫一遍全部路径
 */
let last: { paths: readonly string[]; q: string; hits: number[] } | undefined;

/**
 * 按 query 给候选路径排序：文件名以 query 开头的最前，其次文件名包含、路径包含，
 * 最后是按顺序出现 query 每个字符的模糊匹配；同一档里短的在前
 */
export function rankPaths(paths: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase().replaceAll("\\", "/");
  if (!q) return paths.filter((p) => !p.slice(0, -1).includes("/")).slice(0, limit);
  const info = prepare(paths);
  const from = last && last.paths === paths && q.startsWith(last.q) ? last.hits : undefined;
  const scored: { i: number; score: number }[] = [];
  const check = (i: number) => {
    const { lower, base } = info[i]!;
    let score: number;
    if (lower.startsWith(q)) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else if (subsequence(lower, q)) score = 4;
    else return;
    scored.push({ i, score });
  };
  if (from) for (const i of from) check(i);
  else for (let i = 0; i < paths.length; i++) check(i);
  last = { paths, q, hits: scored.map((s) => s.i) };
  const cmp = (a: { i: number; score: number }, b: { i: number; score: number }) =>
    a.score - b.score || paths[a.i]!.length - paths[b.i]!.length || paths[a.i]!.localeCompare(paths[b.i]!);
  // 只要前 limit 条：命中常有上万条，全部排序（localeCompare 很慢）每按一个键要十几毫秒
  const top: { i: number; score: number }[] = [];
  for (const s of scored) {
    if (top.length === limit && cmp(s, top[limit - 1]!) >= 0) continue;
    let at = top.length;
    while (at > 0 && cmp(s, top[at - 1]!) < 0) at--;
    top.splice(at, 0, s);
    if (top.length > limit) top.pop();
  }
  return top.map((s) => paths[s.i]!);
}

function subsequence(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return false;
}
