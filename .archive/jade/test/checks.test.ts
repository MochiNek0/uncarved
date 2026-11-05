import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, readAll, Runtime, type Block, type ModelRequest, type ModelResponse, type Plugin, type Provider } from "uncarved";
import { checks, CHECKS_KEY, fsTools, parseProblems, type Check, type RunCommand } from "../src/index.ts";

const MODEL = { by: "model", provider: "scripted", model: "scripted-1" } as const;
type Step = Omit<ModelResponse, "model">;
const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });

function scripted(script: Step[]) {
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    id: "scripted",
    async complete(req) {
      requests.push(structuredClone(req));
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return { model: "scripted-1", ...next };
    },
  };
  return { provider, requests };
}

/** 一个 TypeScript 项目：tsconfig.json 和 node_modules 里的 tsc（只要文件存在） */
async function tsProject() {
  const root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-checks-")));
  const home = await mkdtemp(path.join(os.tmpdir(), "jade-checks-home-"));
  await writeFile(path.join(root, "tsconfig.json"), "{}");
  await mkdir(path.join(root, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "typescript", "bin", "tsc"), "");
  return { root, home };
}

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");

describe("parseProblems", () => {
  test("tsc, ruff and go vet formats, continuation lines and lines without a file", () => {
    const cwd = path.resolve("/proj");
    const out = parseProblems(
      [
        "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "  Details on the next line.",
        "lib/b.py:1:8: F401 [*] `os` imported but unused",
        "# example.com/pkg",
        "./c.go:12:2: unreachable code",
        "Found 3 errors.",
      ].join("\n"),
      cwd,
    );
    expect(out.map((p) => p.file && path.relative(cwd, p.file).split(path.sep).join("/"))).toEqual(["src/a.ts", "lib/b.py", "c.go"]);
    expect(out[0]!.text).toContain("Details on the next line.");
    // "# example.com/pkg" 在 b.py 之后，归到 b.py 下面
    expect(out[1]!.text).toContain("# example.com/pkg");
    expect(out[2]!.text).toContain("Found 3 errors.");
    expect(parseProblems("error TS5083: Cannot read file 'x'.", cwd)).toEqual([{ text: "error TS5083: Cannot read file 'x'." }]);
    const win = parseProblems("C:\\proj\\src\\a.ts(1,1): error TS1005", cwd);
    // 只有 Windows 上它是绝对路径；别的系统上是相对 cwd 的
    expect(win[0]!.file).toBe(path.resolve(cwd, "C:\\proj\\src\\a.ts"));
  });
});

describe("edit-time checks", () => {
  test("detects tsc from the nearest tsconfig.json; configured checks replace detection for their files", async () => {
    const { root, home } = await tsProject();
    const run: RunCommand = async () => ({ code: 0, output: "", timedOut: false });
    const c = checks({ cwd: root, root, home, run, approve: async () => true, which: (b) => (b === "ruff" ? "/bin/ruff" : null) });
    const [tsc] = await c.resolve([path.join(root, "src", "a.ts")]);
    expect(tsc!.name).toBe("tsc");
    expect(tsc!.cwd).toBe(root);
    expect(tsc!.command).toContain("--noEmit");
    expect(tsc!.command).toContain("--incremental");
    expect((await c.resolve([path.join(root, "x.py")]))[0]!.name).toBe("ruff");
    expect(await c.resolve([path.join(root, "README.md")])).toEqual([]);

    await mkdir(path.join(root, ".jade"), { recursive: true });
    await writeFile(
      path.join(root, ".jade", "checks.json"),
      JSON.stringify({ checks: [{ name: "eslint", command: "eslint {files}", extensions: ["ts"] }] }),
    );
    const fresh = checks({ cwd: root, root, home, run, approve: async () => true, which: () => null });
    expect((await fresh.resolve([path.join(root, "a.ts")])).map((x) => x.name)).toEqual(["eslint"]);
    // 配置里没有覆盖的文件类型仍然自动发现
    expect((await fresh.resolve([path.join(root, "a.py")])).map((x) => x.name)).toEqual([]);
  });

  test("runs once per batch after the last edit, reports problems in the changed files and new ones elsewhere, and survives resume", async () => {
    const { root, home } = await tsProject();
    const runs: string[] = [];
    // 第二次请求前检查第一批（w1、w2）；第三次请求前检查第二批（w3）：a.ts 修好了，other.ts 多了一个问题
    const outputs = [
      ["src/a.ts(1,1): error TS1: bad a", "src/other.ts(2,2): error TS2: old problem"].join("\n"),
      ["src/other.ts(2,2): error TS2: old problem", "src/other.ts(5,1): error TS3: new problem"].join("\n"),
    ];
    const run: RunCommand = async (command) => {
      runs.push(command);
      const output = outputs[runs.length - 1] ?? "";
      return { code: output ? 2 : 0, output, timedOut: false };
    };
    const approvals: Check[] = [];
    const make = () => {
      const c = checks({ cwd: root, root, home, run, approve: async (check) => (approvals.push(check), true), which: () => null });
      const tools: Plugin = { id: "test/tools", version: "0.1.0", kernel: "^0.1", tools: fsTools(root) };
      return [tools, c.plugin];
    };
    const s = scripted([
      { content: [use("w1", "write_file", { path: "src/a.ts", content: "x" }), use("w2", "write_file", { path: "src/b.ts", content: "y" })], stopReason: "tool_use" },
      { content: [use("w3", "write_file", { path: "src/a.ts", content: "z" })], stopReason: "tool_use" },
      { content: [{ kind: "text", text: "done", origin: MODEL, trust: "trusted" }], stopReason: "end" },
    ]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider: s.provider, plugins: make() });
    await rt.send(msg("go"));

    expect(runs).toHaveLength(2);
    // 只检查一次 tsc，参数是整个项目（-p .）
    expect(runs[0]).toContain("-p .");
    expect(approvals).toHaveLength(2);

    // 第二次请求：w2（这一批最后一个）的结果后面附了报告，w1 的没有
    const second = s.requests[1]!.messages.at(-1)!;
    const results = second.content.filter((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>[];
    expect(textOf(results[0]!.content)).not.toContain("Checks jade ran");
    const report = textOf(results[1]!.content);
    expect(report).toContain("1 problem in the files you changed");
    expect(report).toContain("bad a");
    expect(report).toContain("1 problem in other files. This is the first check in this session");
    expect(report).toContain("old problem");

    // 第三次请求：a.ts 修好了，other.ts 多了一个问题
    const third = textOf((s.requests[2]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content);
    expect(third).toContain("no problems in the files you changed");
    expect(third).toContain("1 more problem in other files than before your edits");
    expect(third).toContain("new problem");
    // 之前的报告在后面的请求里保持不变（提示缓存）
    expect(textOf((s.requests[2]!.messages.at(-3)!.content[1] as Extract<Block, { kind: "tool_result" }>).content)).toBe(report);

    const events = await readAll(store, rt.state.sessionId);
    expect(events.filter((e) => e.type === "jade/checks/checked")).toHaveLength(2);

    // 恢复会话：从日志里取结果，不重新检查
    const resumed = await Runtime.resume({ store, provider: s.provider, plugins: make(), sessionId: rt.state.sessionId });
    // 每份报告单独一个 key，日志里不整份重记
    expect(Object.keys(resumed.state.derived).filter((k) => k.startsWith(`${CHECKS_KEY}/result/`))).toEqual([`${CHECKS_KEY}/result/w2`, `${CHECKS_KEY}/result/w3`]);
    expect(events.filter((e) => e.type === "derived.recorded").map((e) => (e.data as { key: string }).key)).toEqual([
      `${CHECKS_KEY}/result/w2`,
      `${CHECKS_KEY}/others`,
      `${CHECKS_KEY}/result/w3`,
      `${CHECKS_KEY}/others`,
    ]);
    expect(runs).toHaveLength(2);
  });

  test("reads reports that older versions recorded under the single jade/checks key", async () => {
    const { root, home } = await tsProject();
    let runs = 0;
    const run: RunCommand = async () => (runs++, { code: 0, output: "", timedOut: false });
    const tools: Plugin = { id: "test/tools", version: "0.1.0", kernel: "^0.1", tools: fsTools(root) };
    // 老版本留下的记录
    const legacy: Plugin = {
      id: "test/legacy",
      version: "0.1.0",
      kernel: "^0.1",
      needs: ["transform:context.project", "log:record"],
      hooks: [
        {
          kind: "transform",
          point: "context.project",
          fn: async (messages, ctx) => {
            if (!ctx.derived[CHECKS_KEY]) await ctx.record(CHECKS_KEY, { results: { w1: "OLD REPORT" }, others: {} });
            return messages;
          },
        },
      ],
    };
    const end = { content: [{ kind: "text" as const, text: "ok", origin: MODEL, trust: "trusted" as const }], stopReason: "end" as const };
    const s = scripted([{ content: [use("w1", "write_file", { path: "a.ts", content: "x" })], stopReason: "tool_use" }, end]);
    const c = checks({ cwd: root, root, home, run, approve: async () => true, which: () => null });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: [tools, legacy, c.plugin] });
    await rt.send(msg("1"));
    // w1 在老记录里已经检查过：不重跑，老报告照样附在它的结果后面
    expect(runs).toBe(0);
    const w1 = s.requests[1]!.messages.flatMap((m) => m.content).find((b) => b.kind === "tool_result" && b.toolUseId === "w1") as Extract<Block, { kind: "tool_result" }>;
    expect(textOf(w1.content)).toContain("OLD REPORT");
  });

  test("a declined check is not run again in the session; a failing check without problems is reported once", async () => {
    const { root, home } = await tsProject();
    let runs = 0;
    const run: RunCommand = async () => (runs++, { code: 1, output: "error TS5058: The specified path does not exist", timedOut: false });
    let answer = false;
    let asked = 0;
    const c = checks({ cwd: root, root, home, run, approve: async () => (asked++, answer), which: () => null });
    const tools: Plugin = { id: "test/tools", version: "0.1.0", kernel: "^0.1", tools: fsTools(root) };
    const edit = (id: string) => ({ content: [use(id, "write_file", { path: "a.ts", content: id })], stopReason: "tool_use" as const });
    const end = { content: [{ kind: "text" as const, text: "ok", origin: MODEL, trust: "trusted" as const }], stopReason: "end" as const };
    const s = scripted([edit("e1"), end, edit("e2"), end, edit("e3"), end, edit("e4"), end]);
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: [tools, c.plugin] });
    await rt.send(msg("1"));
    await rt.send(msg("2"));
    expect(asked).toBe(1);
    expect(runs).toBe(0);

    c.reset();
    answer = true;
    await rt.send(msg("3"));
    expect(runs).toBe(1);
    const report = textOf((s.requests[5]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content);
    expect(report).toContain("failed (exit code 1) without reporting problems");
    expect(report).toContain("TS5058");
    await rt.send(msg("4"));
    expect(runs).toBe(1);
  });
});
