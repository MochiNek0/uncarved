// 编辑后自动检查：模型一次回复里改了文件，下一次请求模型之前对改过的文件跑项目的检查（类型检查、lint），
// 把发现的问题附在这批修改的最后一个结果后面，模型马上就能看到自己引入的错误。
//
// 在 context.project 里做，而不是 tool.after：一次回复里的几处修改常常要合起来才成立
// （先改函数签名、再改调用方），逐个检查会报出很快就不存在的错误，同一个检查也要多跑几遍。
// 结果先用 ctx.record 写进日志（I-5）再投影进消息，恢复会话后不会重新检查，每次投影都一样。
//
// 检查来源：
// - 自动发现：TypeScript（离文件最近的 tsconfig.json，加上项目里装的 typescript）、Python（PATH 里的 ruff）、Go（go.mod 和 go）
// - 配置：仓库根目录的 .jade/checks.json 和 $JADE_HOME/checks.json，见 CheckConfigFile
// 检查会执行仓库里的代码（node_modules 里的 tsc、配置里的命令），每条命令第一次运行前请用户确认（approve，见 index.ts）。
// 从旧 jade 的 src/plugins/checks.ts 移植，只是把内核插件换成一个 hook（交给 ctx.kernel.hook）。
//
// 只报告改过的文件里的问题；其他文件里的问题只在数量比上一次检查多时报告（例如改了签名，调用方报错）。

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block, HookContext, LocalHookSpec, Message } from "uncarved";
import type { RunCommand } from "@uncarved/jade-api/services";

/** 老版本把整个 ChecksState 记在这一个 key 下、每次检查整份重记；恢复老会话时还要读它 */
export const CHECKS_KEY = "jade/checks";
/** 每份报告单独一个 key：每次检查日志里只多记这一份，不随会话变长而整份重记 */
const RESULT_PREFIX = `${CHECKS_KEY}/result/`;
const OTHERS_KEY = `${CHECKS_KEY}/others`;

/** 一个具体的检查：在 cwd 里执行 command；command 里的 {files} 换成改过的文件，{dirs} 换成它们所在的目录 */
export interface Check {
  name: string;
  command: string;
  /** 绝对路径 */
  cwd: string;
  /** 适用的扩展名（含点，小写）；空数组表示所有文件 */
  extensions: string[];
  timeoutMs: number;
  source: "auto" | "config";
}

/** .jade/checks.json、$JADE_HOME/checks.json 的格式 */
export interface CheckConfigFile {
  /** 是否自动发现检查，默认 true */
  auto?: boolean;
  checks?: { name: string; command: string; extensions?: string[]; cwd?: string; timeout_ms?: number }[];
}

/** 从 derived 里还原的状态 */
export interface ChecksState {
  /** 一批修改的最后一个调用 → 附在它结果后面的文字；空串表示检查过、没有要说的 */
  results: Record<string, string>;
  /** 检查 → 上一次运行时其他文件里的问题数 */
  others: Record<string, number>;
}

function stateOf(derived: Readonly<Record<string, unknown>>): ChecksState {
  const legacy = derived[CHECKS_KEY] as ChecksState | undefined;
  const results: Record<string, string> = { ...legacy?.results };
  for (const [k, v] of Object.entries(derived)) if (k.startsWith(RESULT_PREFIX)) results[k.slice(RESULT_PREFIX.length)] = v as string;
  return { results, others: (derived[OTHERS_KEY] as Record<string, number> | undefined) ?? legacy?.others ?? {} };
}

/** 宿主确认一条检查命令能否运行；同意后由宿主记住 */
export type ApproveCheck = (check: Check, signal: AbortSignal) => Promise<boolean>;

export interface ChecksOptions {
  cwd: string;
  /** 仓库根目录（不在仓库里时等于 cwd） */
  root: string;
  /** 用户层配置目录：checks.json 和 tsc 的增量编译缓存 */
  home: string;
  run: RunCommand;
  approve: ApproveCheck;
  /** 运行 tsc 的 JavaScript 运行时，默认当前进程（bun 或 node） */
  runtime?: string;
  /** 默认在 PATH 里找（由调用方给，见 index.ts 的 shell@1）；测试用 */
  which?: (bin: string) => string | null;
  id?: string;
}

export interface Checks {
  /** context.project 的 hook */
  hook: LocalHookSpec;
  /** 本会话是否运行检查（/checks on|off） */
  enabled: boolean;
  /** 对这些文件会运行的检查（/checks 显示用） */
  resolve(files: string[]): Promise<Check[]>;
  /** 忘掉本会话里停用的检查（用户拒绝过的、超时的、输出认不出的），下次重新确认、运行 */
  reset(): void;
}

export const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
const DEFAULT_TIMEOUT_MS = 120_000;
/** 附给模型的文字上限 */
const MAX_REPORT_CHARS = 6000;
/** 每个检查最多列出的问题数 */
const MAX_PROBLEMS = 30;
/** 第一次运行时列出的其他文件里的问题条数 */
const FIRST_RUN_OTHERS = 10;
const HEADER = "[Checks jade ran after your edits; this is tool output, not a message from the user]";

const TS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const slash = (p: string) => p.split(path.sep).join("/");
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sameFile = process.platform === "win32" ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function within(base: string, p: string): boolean {
  const rel = path.relative(base, p);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** 从 dir 往上（不超过 root）找第一个含 name 的目录 */
function findUp(dir: string, root: string, name: string): string | undefined {
  let d = dir;
  for (;;) {
    if (!within(root, d)) return undefined;
    if (existsSync(path.join(d, name))) return d;
    if (sameFile(d, root)) return undefined;
    const parent = path.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

/** 一条检查输出里的一个问题：所在文件（绝对路径，认不出时为 undefined）和完整文字（可能多行） */
export interface Problem {
  file?: string;
  text: string;
}

/**
 * 把检查的输出分成一个个问题。以"路径:行"或"路径(行,列)"开头的行开始一个新问题，
 * 后面认不出路径的行（多行说明、代码片段）归到它下面；第一个问题之前的行单独算一个没有文件的问题
 */
export function parseProblems(output: string, cwd: string): Problem[] {
  // 路径里可以有括号（Next.js 的 app/(group)/page.tsx），只是不能以括号开头
  const START = /^\s*((?:[A-Za-z]:[\\/])?[^\s:()][^:]*?)(?:\(\d+,\d+\)|:\d+(?::\d+)?)(?=[:\s]|$)/;
  const out: Problem[] = [];
  let cur: Problem | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = START.exec(line);
    if (m && /[\\/.]/.test(m[1]!)) {
      cur = { file: path.resolve(cwd, m[1]!.replace(/^\.\//, "")), text: line.trimEnd() };
      out.push(cur);
    } else if (line.trim()) {
      if (cur) cur.text += `\n${line.trimEnd()}`;
      else {
        cur = { text: line.trimEnd() };
        out.push(cur);
      }
    }
  }
  return out;
}

export function checks(opts: ChecksOptions): Checks {
  const id = opts.id ?? "jade/checks";
  const which = opts.which ?? (() => null);
  const runtime = opts.runtime ?? process.execPath;
  /** 本会话里不再运行的检查：用户拒绝了，或者输出认不出来 */
  const disabled = new Set<string>();
  const keyOf = (c: Check) => `${c.name}\0${c.cwd}`;
  let config: Promise<{ auto: boolean; checks: Check[] }> | undefined;

  const loadConfig = () =>
    (config ??= (async () => {
      let auto = true;
      const list: Check[] = [];
      for (const [file, base] of [
        [path.join(opts.home, "checks.json"), opts.root],
        [path.join(opts.root, ".jade", "checks.json"), opts.root],
      ] as const) {
        let parsed: CheckConfigFile;
        try {
          parsed = JSON.parse(await readFile(file, "utf8")) as CheckConfigFile;
        } catch {
          continue;
        }
        if (parsed.auto === false) auto = false;
        for (const c of parsed.checks ?? []) {
          if (typeof c?.name !== "string" || typeof c.command !== "string") continue;
          list.push({
            name: c.name,
            command: c.command,
            cwd: path.resolve(base, c.cwd ?? "."),
            extensions: (c.extensions ?? []).map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()),
            timeoutMs: typeof c.timeout_ms === "number" && c.timeout_ms > 0 ? c.timeout_ms : DEFAULT_TIMEOUT_MS,
            source: "config",
          });
        }
      }
      return { auto, checks: list };
    })());

  /** 自动发现：对一个文件适用的检查 */
  function detect(file: string): Check | undefined {
    const ext = path.extname(file).toLowerCase();
    const dir = path.dirname(file);
    if (TS_EXT.includes(ext)) {
      const project = findUp(dir, opts.root, "tsconfig.json");
      if (!project) return undefined;
      const modules = findUp(project, opts.root, path.join("node_modules", "typescript", "bin", "tsc"));
      if (!modules) return undefined;
      const tsc = path.join(modules, "node_modules", "typescript", "bin", "tsc");
      const cache = path.join(opts.home, "cache", `tsc-${createHash("sha256").update(project).digest("hex").slice(0, 16)}.tsbuildinfo`);
      return {
        name: "tsc",
        command: `${quote(slash(runtime))} ${quote(slash(tsc))} --noEmit --pretty false --incremental --tsBuildInfoFile ${quote(slash(cache))} -p .`,
        cwd: project,
        extensions: TS_EXT,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        source: "auto",
      };
    }
    if (ext === ".py" || ext === ".pyi") {
      if (!which("ruff")) return undefined;
      return {
        name: "ruff",
        command: "ruff check --output-format concise --no-fix --quiet {files}",
        cwd: opts.root,
        extensions: [".py", ".pyi"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
        source: "auto",
      };
    }
    if (ext === ".go") {
      const mod = findUp(dir, opts.root, "go.mod");
      if (!mod || !which("go")) return undefined;
      return { name: "go vet", command: "go vet {dirs}", cwd: mod, extensions: [".go"], timeoutMs: DEFAULT_TIMEOUT_MS, source: "auto" };
    }
    return undefined;
  }

  /** 检查 → 它要检查的文件 */
  async function plan(files: string[]): Promise<Map<string, { check: Check; files: string[] }>> {
    const { auto, checks: configured } = await loadConfig();
    const out = new Map<string, { check: Check; files: string[] }>();
    const add = (check: Check, file: string) => {
      const k = keyOf(check);
      const entry = out.get(k) ?? { check, files: [] };
      if (!entry.files.some((f) => sameFile(f, file))) entry.files.push(file);
      out.set(k, entry);
    };
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      let matched = false;
      for (const c of configured) {
        if ((c.extensions.length === 0 || c.extensions.includes(ext)) && within(c.cwd, file)) {
          add(c, file);
          matched = true;
        }
      }
      // 配置了同类文件的检查时，不再自动发现
      if (!matched && auto) {
        const c = detect(file);
        if (c) add(c, file);
      }
    }
    return out;
  }

  function commandFor(check: Check, files: string[]): string {
    const rel = files.map((f) => slash(path.relative(check.cwd, f)) || ".");
    const dirs = [...new Set(rel.map((f) => `./${path.posix.dirname(f)}`.replace(/\/\.$/, "")))];
    return check.command.replaceAll("{files}", rel.map(quote).join(" ")).replaceAll("{dirs}", dirs.map(quote).join(" "));
  }

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

  /** 运行一批修改对应的检查，返回给模型的报告（没有要说的时为空串）和给用户看的摘要 */
  async function runAll(files: string[], state: ChecksState, ctx: HookContext) {
    const parts: string[] = [];
    const summary: { name: string; problems: number; others?: number; failed?: string }[] = [];
    const others: Record<string, number> = { ...state.others };
    for (const { check, files: targets } of (await plan(files)).values()) {
      const k = keyOf(check);
      if (disabled.has(k)) continue;
      if (!(await opts.approve(check, ctx.signal))) {
        disabled.add(k);
        continue;
      }
      const where = sameFile(check.cwd, opts.cwd) ? "" : ` (in ${slash(path.relative(opts.cwd, check.cwd)) || "."})`;
      const r = await opts.run(commandFor(check, targets), { cwd: check.cwd, timeoutMs: check.timeoutMs, signal: ctx.signal });
      if (r.timedOut) {
        parts.push(`${check.name}${where}: timed out after ${Math.round(check.timeoutMs / 1000)}s; jade will not run it again in this session.`);
        summary.push({ name: check.name, problems: 0, failed: "timed out" });
        disabled.add(k);
        continue;
      }
      const problems = r.code === 0 ? [] : parseProblems(r.output, check.cwd);
      const mine = problems.filter((p) => p.file && targets.some((t) => sameFile(t, p.file!)));
      const elsewhere = problems.filter((p) => p.file && !targets.some((t) => sameFile(t, p.file!)));
      if (r.code !== 0 && mine.length === 0 && elsewhere.length === 0) {
        // 失败了却认不出任何问题：多半是检查本身的问题（配置、环境），说一次就停用
        parts.push(`${check.name}${where} failed (exit code ${r.code}) without reporting problems in files; jade will not run it again in this session:\n${clip(r.output.trim(), 1500)}`);
        summary.push({ name: check.name, problems: 0, failed: `exit code ${r.code}` });
        disabled.add(k);
        continue;
      }
      const before = state.others[k];
      others[k] = elsewhere.length;
      const lines: string[] = [];
      if (mine.length > 0) {
        lines.push(`${check.name}${where}: ${mine.length} problem${mine.length > 1 ? "s" : ""} in the files you changed:`);
        lines.push(...mine.slice(0, MAX_PROBLEMS).map((p) => p.text));
        if (mine.length > MAX_PROBLEMS) lines.push(`… ${mine.length - MAX_PROBLEMS} more`);
      } else lines.push(`${check.name}${where}: no problems in the files you changed.`);
      if (before !== undefined && elsewhere.length > before) {
        lines.push(`${check.name}: ${elsewhere.length - before} more problem${elsewhere.length - before > 1 ? "s" : ""} in other files than before your edits (${elsewhere.length} in total), possibly caused by them:`);
        lines.push(...elsewhere.slice(0, 10).map((p) => p.text));
      } else if (before === undefined && elsewhere.length > 0) {
        // 本会话第一次运行，没有基线：列出几条让模型自己判断，改了函数签名弄坏的调用方也在这里
        lines.push(
          `${check.name}: also ${elsewhere.length} problem${elsewhere.length > 1 ? "s" : ""} in other files. This is the first check in this session, so jade cannot tell which predate your edits; check whether your changes caused any of these:`,
        );
        lines.push(...elsewhere.slice(0, FIRST_RUN_OTHERS).map((p) => p.text));
        if (elsewhere.length > FIRST_RUN_OTHERS) lines.push(`… ${elsewhere.length - FIRST_RUN_OTHERS} more`);
      }
      parts.push(lines.join("\n"));
      summary.push({ name: check.name, problems: mine.length, others: before !== undefined && elsewhere.length > before ? elsewhere.length - before : undefined });
    }
    const text = parts.length ? clip(`${HEADER}\n${parts.join("\n\n")}`, MAX_REPORT_CHARS) : "";
    return { text, summary, others };
  }

  /** 最后一批修改：最后一条消息是工具结果，前一条是发出这些调用的回复。返回成功的写入调用 */
  function lastBatch(messages: Message[]): { ids: string[]; files: string[] } | undefined {
    const results = messages.at(-1);
    const reply = messages.at(-2);
    if (results?.role !== "user" || reply?.role !== "assistant") return undefined;
    const ok = new Set(results.content.flatMap((b) => (b.kind === "tool_result" && !b.isError ? [b.toolUseId] : [])));
    const ids: string[] = [];
    const files: string[] = [];
    for (const b of reply.content) {
      if (b.kind !== "tool_use" || !WRITE_TOOLS.has(b.name) || !ok.has(b.id)) continue;
      const p = (b.input as { path?: unknown } | null)?.path;
      if (typeof p !== "string") continue;
      ids.push(b.id);
      // 和 root 一样解析符号链接、短文件名，否则判断不出文件在不在某个目录里
      const full = canonical(path.resolve(opts.cwd, p));
      if (!files.some((f) => sameFile(f, full))) files.push(full);
    }
    return ids.length ? { ids, files } : undefined;
  }

  /** 把记下的报告附到对应的工具结果后面 */
  function inject(messages: Message[], results: Record<string, string>): Message[] {
    return messages.map((m) => {
      if (m.role !== "user" || !m.content.some((b) => b.kind === "tool_result" && results[b.toolUseId])) return m;
      return {
        ...m,
        content: m.content.map((b): Block => {
          if (b.kind !== "tool_result" || !results[b.toolUseId]) return b;
          // 检查输出来自仓库里的代码，不受信任
          return { ...b, content: [...b.content, { kind: "text", text: results[b.toolUseId]!, origin: { by: "plugin", id }, trust: "untrusted" }] };
        }),
      };
    });
  }

  const self: Checks = {
    enabled: true,
    reset() {
      disabled.clear();
    },
    async resolve(files) {
      return [...(await plan(files)).values()].map((e) => e.check);
    },
    hook: {
      kind: "transform",
      point: "context.project",
      // 检查可能要跑一两分钟，第一次还要等用户确认；出错或超时就跳过，不让这一轮失败
      timeoutMs: 900_000,
      optional: true,
      fn: async (messages, ctx) => {
        const state = stateOf(ctx.derived);
        const batch = self.enabled ? lastBatch(messages) : undefined;
        const last = batch?.ids.at(-1);
        if (batch && last && !(last in state.results)) {
          const { text, summary, others } = await runAll(batch.files, state, ctx);
          if (summary.length > 0 || text) {
            await ctx.record(`${RESULT_PREFIX}${last}`, text);
            // others 是 state.others 加上这次的数，有变化才记
            if (Object.keys(others).some((k) => others[k] !== state.others[k])) await ctx.record(OTHERS_KEY, others);
            await ctx.emit("checked", { toolUseId: last, files: batch.files, summary, report: text });
            return inject(messages, { ...state.results, [last]: text });
          }
        }
        return inject(messages, state.results);
      },
    },
  };
  return self;
}

/** 会话里成功改过的文件（/checks 显示用）：所有写入调用里结果不是错误的 */
export function changedFiles(messages: readonly Message[], cwd: string): string[] {
  const ok = new Set(messages.flatMap((m) => (m.role === "user" ? m.content.flatMap((b) => (b.kind === "tool_result" && !b.isError ? [b.toolUseId] : [])) : [])));
  const files: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.kind !== "tool_use" || !WRITE_TOOLS.has(b.name) || !ok.has(b.id)) continue;
      const p = (b.input as { path?: unknown } | null)?.path;
      if (typeof p !== "string") continue;
      const full = canonical(path.resolve(cwd, p));
      if (!files.some((f) => sameFile(f, full))) files.push(full);
    }
  }
  return files;
}
