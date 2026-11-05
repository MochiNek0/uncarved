// jade/checks：从旧 jade 的 test/checks.test.ts 移植（直接把 hook 交给内核），加上经插件宿主的端到端测试（确认、/checks、显示）。

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryLogStore, readAll, Runtime, type Block, type ModelRequest, type Plugin, type Provider } from "uncarved";
import { checks, CHECKS_KEY, parseProblems, type Check, type Checks } from "../plugins/checks/checks.ts";
import { checksRenderers } from "../plugins/checks/index.ts";
import { commandRunner, type RunCommand } from "../plugins/checks/run.ts";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import { fsTools } from "../plugins/fs/fs.ts";
import type { SessionManager, UI } from "../src/index.ts";
import { featureHost, msg, reply, tempDir, textOf, use, type Step } from "./feature-host.ts";

const MODEL = { by: "model", provider: "scripted", model: "scripted-1" } as const;

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
  const root = await tempDir("jade-checks-");
  const home = await tempDir("jade-checks-home-");
  await writeFile(path.join(root, "tsconfig.json"), "{}");
  await mkdir(path.join(root, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "typescript", "bin", "tsc"), "");
  return { root, home };
}

/** 交给内核的插件：工具和检查的 hook */
const kernelPlugins = (root: string, c: Checks): Plugin[] => [
  { id: "test/tools", version: "0.1.0", kernel: "^0.1", tools: fsTools(root) },
  { id: "jade/checks", version: "0.2.0", kernel: "^0.1", needs: ["transform:context.project", "log:record", "log:emit"], hooks: [c.hook] },
];

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
    expect(out[1]!.text).toContain("# example.com/pkg");
    expect(out[2]!.text).toContain("Found 3 errors.");
    expect(parseProblems("error TS5083: Cannot read file 'x'.", cwd)).toEqual([{ text: "error TS5083: Cannot read file 'x'." }]);
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
    expect((await c.resolve([path.join(root, "x.py")]))[0]!.name).toBe("ruff");
    expect(await c.resolve([path.join(root, "README.md")])).toEqual([]);

    await mkdir(path.join(root, ".jade"), { recursive: true });
    await writeFile(path.join(root, ".jade", "checks.json"), JSON.stringify({ checks: [{ name: "eslint", command: "eslint {files}", extensions: ["ts"] }] }));
    const fresh = checks({ cwd: root, root, home, run, approve: async () => true, which: () => null });
    expect((await fresh.resolve([path.join(root, "a.ts")])).map((x) => x.name)).toEqual(["eslint"]);
    expect((await fresh.resolve([path.join(root, "a.py")])).map((x) => x.name)).toEqual([]);
  });

  test("runs once per batch after the last edit, reports problems in the changed files and new ones elsewhere, and survives resume", async () => {
    const { root, home } = await tsProject();
    const runs: string[] = [];
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
    const make = () => kernelPlugins(root, checks({ cwd: root, root, home, run, approve: async (check) => (approvals.push(check), true), which: () => null }));
    const s = scripted([
      { content: [use("w1", "write_file", { path: "src/a.ts", content: "x" }), use("w2", "write_file", { path: "src/b.ts", content: "y" })], stopReason: "tool_use" },
      { content: [use("w3", "write_file", { path: "src/a.ts", content: "z" })], stopReason: "tool_use" },
      { content: [{ kind: "text", text: "done", origin: MODEL, trust: "trusted" }], stopReason: "end" },
    ]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider: s.provider, plugins: make() });
    await rt.send(msg("go"));

    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("-p .");
    expect(approvals).toHaveLength(2);
    const second = s.requests[1]!.messages.at(-1)!;
    const res = second.content.filter((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>[];
    expect(textOf(res[0]!.content)).not.toContain("Checks jade ran");
    const report = textOf(res[1]!.content);
    expect(report).toContain("1 problem in the files you changed");
    expect(report).toContain("bad a");
    expect(report).toContain("1 problem in other files. This is the first check in this session");
    const third = textOf((s.requests[2]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content);
    expect(third).toContain("no problems in the files you changed");
    expect(third).toContain("1 more problem in other files than before your edits");
    expect(third).toContain("new problem");
    expect(textOf((s.requests[2]!.messages.at(-3)!.content[1] as Extract<Block, { kind: "tool_result" }>).content)).toBe(report);

    const events = await readAll(store, rt.state.sessionId);
    expect(events.filter((e) => e.type === "jade/checks/checked")).toHaveLength(2);
    const resumed = await Runtime.resume({ store, provider: s.provider, plugins: make(), sessionId: rt.state.sessionId });
    expect(Object.keys(resumed.state.derived).filter((k) => k.startsWith(`${CHECKS_KEY}/result/`))).toEqual([`${CHECKS_KEY}/result/w2`, `${CHECKS_KEY}/result/w3`]);
    expect(runs).toHaveLength(2);
  });

  test("a declined check is not run again in the session; a failing check without problems is reported once", async () => {
    const { root, home } = await tsProject();
    let runs = 0;
    const run: RunCommand = async () => (runs++, { code: 1, output: "error TS5058: The specified path does not exist", timedOut: false });
    let answer = false;
    let asked = 0;
    const c = checks({ cwd: root, root, home, run, approve: async () => (asked++, answer), which: () => null });
    const edit = (id: string) => ({ content: [use(id, "write_file", { path: "a.ts", content: id })], stopReason: "tool_use" as const });
    const end = reply("ok");
    const s = scripted([edit("e1"), end, edit("e2"), end, edit("e3"), end, edit("e4"), end]);
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: kernelPlugins(root, c) });
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
    await rt.send(msg("4"));
    expect(runs).toBe(1);
  });

  test("the checked event is shown as one line with the report as details", () => {
    const r = checksRenderers[0]!;
    expect(r.render({ summary: [{ name: "tsc", problems: 0 }], report: "" })!.line).toContain("checks passed: tsc");
    const bad = r.render({ summary: [{ name: "tsc", problems: 2, others: 1 }], report: "header\nline 1\nline 2" })!;
    expect(bad.line).toContain("tsc: 2 problems in changed files, 1 new elsewhere");
    expect(bad.details).toBe("line 1\nline 2");
  });
});

const hasShell = !("unavailable" in commandRunner());
const ui: UI = { interactive: false, notify: () => {}, select: async () => undefined, input: async () => undefined };
const ctxFor = (sessions: SessionManager): CommandContext => ({ signal: new AbortController().signal, ui, sessions, print: () => {} });

describe.skipIf(!hasShell)("jade/checks plugin", () => {
  /** 一个仓库：.jade/checks.json 里一条检查 .txt 的命令，它对改过的文件报一个问题 */
  async function repo() {
    const cwd = await tempDir("jade-checks-repo-");
    await mkdir(path.join(cwd, ".git"));
    await mkdir(path.join(cwd, ".jade"));
    await writeFile(
      path.join(cwd, ".jade", "checks.json"),
      JSON.stringify({ auto: false, checks: [{ name: "lint", command: "for f in {files}; do echo \"$f:1: lint says no\"; done; exit 1", extensions: ["txt"] }] }),
    );
    return cwd;
  }
  const edit: Step = { content: [use("w1", "write_file", { path: "a.txt", content: "x" })], stopReason: "tool_use" };

  test("asks before running a check command the first time, remembers the answer, and shows the report to the model", async () => {
    const home = await tempDir("jade-checks-home-");
    const cwd = await repo();
    let w = await featureHost({ home, cwd, config: { "jade/approval": { mode: "auto" } } });
    try {
      w.state.answers.push("yes");
      w.state.script.push(edit, reply("done"));
      const s = await w.host.sessions.open();
      await s.send(msg("go"));
      expect(w.state.selects.map((x) => x.title)).toEqual(["Run lint after the agent edits files, and show it the problems found?"]);
      expect(w.state.selects[0]!.detail).toContain("(from checks.json)");
      const result = w.state.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>;
      expect(textOf(result.content)).toContain("lint: 1 problem in the files you changed:\na.txt:1: lint says no");
      const listed = String(await w.host.service<Commands>("commands@1")!.get("checks")!.command.run("", ctxFor(w.host.sessions)));
      expect(listed).toContain("Edit-time checks are on in this session.");
      expect(listed).toContain("lint");
      expect(listed).not.toContain("not confirmed yet");
      expect(await w.host.service<Commands>("commands@1")!.get("checks")!.command.run("off", ctxFor(w.host.sessions))).toBe("checks: off");
    } finally {
      await w.host.close();
    }
    expect(await readFile(path.join(home, "trust.jsonl"), "utf8")).toContain("hash");

    // 下次启动不再问
    w = await featureHost({ home, cwd, config: { "jade/approval": { mode: "auto" } } });
    try {
      w.state.script.push(edit, reply("done"));
      await (await w.host.sessions.open()).send(msg("go"));
      expect(w.state.selects).toEqual([]);
      expect(textOf((w.state.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content)).toContain("lint says no");
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("does not run unconfirmed commands when nobody can confirm them; can be turned off in config", async () => {
    const cwd = await repo();
    let w = await featureHost({ cwd, config: { "jade/approval": { mode: "auto" } } });
    try {
      w.state.interactive = false;
      w.state.script.push(edit, reply("done"));
      await (await w.host.sessions.open()).send(msg("go"));
      expect(textOf((w.state.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content)).not.toContain("lint");
    } finally {
      await w.host.close();
    }
    w = await featureHost({ cwd, config: { "jade/approval": { mode: "yolo" }, "jade/checks": { enabled: false } } });
    try {
      w.state.script.push(edit, reply("done"));
      await (await w.host.sessions.open()).send(msg("go"));
      expect(w.state.selects).toEqual([]);
      expect(textOf((w.state.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content)).not.toContain("lint");
      expect(String(await w.host.service<Commands>("commands@1")!.get("checks")!.command.run("", ctxFor(w.host.sessions)))).toContain("turned off");
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("a project's .jade/config.json cannot turn checks off", async () => {
    const cwd = await repo();
    await writeFile(path.join(cwd, ".jade", "config.json"), JSON.stringify({ "jade/checks": { enabled: false } }));
    const w = await featureHost({ cwd, config: { "jade/approval": { mode: "yolo" } } });
    try {
      w.state.script.push(edit, reply("done"));
      await (await w.host.sessions.open()).send(msg("go"));
      // yolo 模式不问，直接运行
      expect(textOf((w.state.requests[1]!.messages.at(-1)!.content[0] as Extract<Block, { kind: "tool_result" }>).content)).toContain("lint says no");
    } finally {
      await w.host.close();
    }
  }, 30_000);
});
