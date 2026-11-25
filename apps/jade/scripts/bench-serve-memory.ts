// jade --serve 的多会话内存测量，口径对齐 jcode 的 scripts/bench_headless_memory.py：
// 一个 jade --serve 进程里开 N 个会话，每轮 N 个会话同时发同一句话，每轮结束等 1 秒后对整棵进程树采样。
// 提示词和 jcode 的相同，都是只读的，不改工作目录。
//
//   bun scripts/bench-serve-memory.ts [--sessions 1,2,4,8] [--turns 5] [--cwd <dir>] [--runtime bun|node] [--scripted] [--out <file.json>]
//
// 默认用真实模型：临时 JADE_HOME，从 ~/.jade（或 $JADE_HOME）复制 .env、models.json、config.json（只读使用，结束时连同临时目录删掉）。
// --scripted 换成不联网、立刻回复的假模型，只测 jade 自己的占用。--runtime node 要先 bun run build。
// 采样：Windows 是工作集（Working Set）和私有字节（Private Bytes），Linux 是 PSS（/proc/<pid>/smaps_rollup，和 jcode 相同）。

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const TURNS = [
  "Use a tool to list the files in the current directory, then reply with just the number of entries.",
  "Read the first 20 lines of README.md with a tool and reply with its top-level title only.",
  "Search the repository for the string 'fn main' with a tool and reply with how many files matched.",
  "In one sentence, summarize what you have learned about this repository so far.",
  "Reply with exactly the word: done",
];

const SCRIPTED = `const provider = {
  id: "scripted",
  async complete(req) {
    const n = req.messages.filter((m) => m.role === "assistant").length;
    return { model: "s1", stopReason: "end", content: [{ kind: "text", text: "reply " + n, origin: { by: "model", provider: "scripted", model: "s1" }, trust: "trusted" }] };
  },
};
export default { process(ctx) {
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script" }), complete: provider.complete, list: async () => [] });
} };`;

function args() {
  const a = process.argv.slice(2);
  const get = (name: string) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    sessions: (get("--sessions") ?? "1,2,4,8").split(",").map(Number),
    turns: Number(get("--turns") ?? TURNS.length),
    cwd: path.resolve(get("--cwd") ?? process.cwd()),
    runtime: (get("--runtime") ?? "bun") as "bun" | "node",
    scripted: a.includes("--scripted"),
    out: get("--out"),
  };
}

type Sample = { stage: string; mb: number; privateMb?: number; processes: number };

/** 整棵进程树的内存（MB）。Windows：工作集 + 私有字节；Linux：PSS */
function measure(root: number): Omit<Sample, "stage"> {
  if (process.platform === "win32") {
    const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress`;
    const rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 64 << 20 })) as {
      ProcessId: number;
      ParentProcessId: number;
      WorkingSetSize: number;
      PrivatePageCount: number;
    }[];
    const tree = descendants(root, rows.map((r) => [r.ProcessId, r.ParentProcessId]));
    const mine = rows.filter((r) => tree.has(r.ProcessId));
    return {
      mb: round(mine.reduce((n, r) => n + Number(r.WorkingSetSize), 0) / 2 ** 20),
      privateMb: round(mine.reduce((n, r) => n + Number(r.PrivatePageCount), 0) / 2 ** 20),
      processes: mine.length,
    };
  }
  if (process.platform === "linux") {
    const links: [number, number][] = [];
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        links.push([Number(d), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])]);
      } catch {
        // 进程已经退出
      }
    }
    const tree = descendants(root, links);
    let kb = 0;
    for (const pid of tree) {
      try {
        kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
      } catch {
        // 进程已经退出
      }
    }
    return { mb: round(kb / 1024), processes: tree.size };
  }
  throw new Error(`measuring memory is not supported on ${process.platform}`);
}

function descendants(root: number, links: [number, number][]): Set<number> {
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of links) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true));
  }
  return tree;
}

const round = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stderr.write(`[${new Date().toTimeString().slice(0, 8)}] ${m}\n`);

async function run(sessions: number, opts: ReturnType<typeof args>) {
  const realHome = process.env.JADE_HOME || path.join(os.homedir(), ".jade");
  const home = mkdtempSync(path.join(os.tmpdir(), "jade-serve-bench-"));
  try {
    if (opts.scripted) {
      const dir = path.join(home, "plugins", "scripted-model");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify({ id: "bench/scripted-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }),
      );
      writeFileSync(path.join(dir, "index.mjs"), SCRIPTED);
    } else {
      for (const f of [".env", "models.json", "config.json"]) if (existsSync(path.join(realHome, f))) copyFileSync(path.join(realHome, f), path.join(home, f));
    }
    const bin = path.resolve(import.meta.dir, "../bin/jade.js");
    const exe = opts.runtime === "node" ? "node" : process.execPath;
    const child = spawn(exe, [bin, "--serve"], { cwd: opts.cwd, env: { ...process.env, JADE_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const waiting = new Map<string, (e: Record<string, unknown>) => void>();
    const errors: string[] = [];
    let toolUses = 0;
    const lastResult = new Map<string, string>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.type === "tool_use") toolUses++;
      if (e.type === "turn_end") {
        lastResult.set(String(e.session), String(e.result));
        if (e.reason !== "end") errors.push(`${String(e.session).slice(0, 8)}: turn ended with ${e.reason}${e.error ? `: ${e.error}` : ""}`);
      }
      if (e.type === "error") errors.push(String(e.error));
      if (typeof e.id === "string") waiting.get(e.id)?.(e);
    });
    let n = 0;
    const request = (req: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = `r${n++}`;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      });

    const samples: Sample[] = [];
    const sample = async (stage: string) => {
      await sleep(1000);
      samples.push({ stage, ...measure(child.pid!) });
      const s = samples.at(-1)!;
      log(`sessions=${sessions} ${stage}: ${s.mb} MB${s.privateMb !== undefined ? ` (private ${s.privateMb} MB)` : ""}, ${s.processes} processes`);
    };

    const t0 = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < sessions; i++) {
      const r = await request({ type: "open" });
      if (r.type !== "opened") throw new Error(`open failed: ${r.error}\n${stderr}`);
      ids.push(String(r.session));
    }
    await sample("idle");
    for (let t = 0; t < opts.turns; t++) {
      const text = TURNS[t % TURNS.length]!;
      await Promise.all(ids.map((session) => request({ type: "send", session, text })));
      await sample(`turn${t + 1}`);
    }
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    return { sessions, samples, errors, toolUses, lastResponse: lastResult.get(ids[0]!)?.slice(0, 200), seconds: round((Date.now() - t0) / 1000) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const opts = args();
const results = [];
for (const n of opts.sessions) results.push(await run(n, opts));

const stages = results[0]!.samples.map((s) => s.stage);
const unit = process.platform === "win32" ? "working set MB (private MB)" : "PSS MB";
console.log(`\njade --serve (${opts.runtime}${opts.scripted ? ", scripted model" : ""}) — ${unit}, whole process tree, cwd ${opts.cwd}\n`);
console.log(`| sessions | ${stages.join(" | ")} | errors |`);
console.log(`|---|${stages.map(() => "---:").join("|")}|---:|`);
for (const r of results) {
  console.log(`| ${r.sessions} | ${r.samples.map((s) => `${s.mb}${s.privateMb !== undefined ? ` (${s.privateMb})` : ""}`).join(" | ")} | ${r.errors.length} |`);
}
if (results.length > 1) {
  const a = results[0]!;
  const b = results.at(-1)!;
  const last = (r: typeof a) => r.samples.at(-1)!.mb;
  console.log(`\nper additional session after the last turn: ~${round((last(b) - last(a)) / (b.sessions - a.sessions))} MB (${a.sessions} → ${b.sessions} sessions)`);
}
for (const r of results) for (const e of r.errors.slice(0, 5)) console.log(`sessions=${r.sessions}: ${e}`);
if (opts.out) writeFileSync(opts.out, JSON.stringify({ runtime: opts.runtime, scripted: opts.scripted, platform: process.platform, cwd: opts.cwd, results }, null, 2));
