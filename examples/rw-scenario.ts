// 实际场景：让模型在一个沙盒目录里完成读写任务，并检查内核的各项保证。
//
// 运行：bun examples/rw-scenario.ts            使用真实模型（provider 选择见 shared.ts）
//       bun examples/rw-scenario.ts --offline  使用脚本化的模型，不需要 API key
//
// 覆盖：多工具并发读 → 写操作经 gate 审批 → 关卡拒绝 → observe 用 record 写派生数据
//       → turn.continue 限制步数 → JSONL 落盘 → 从日志重建状态 → close 后拒绝写入

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlLogStore } from "@uncarved/store-jsonl";
import {
  readAll,
  rebuild,
  Runtime,
  type Block,
  type Message,
  type ModelResponse,
  type Plugin,
  type Provider,
} from "uncarved";
import { fsTools, providerFromEnv } from "./shared.ts";

// ---------- 沙盒 ----------

const ws = await mkdtemp(path.join(tmpdir(), "uncarved-ws-"));
const logDir = path.join(ws, ".log");
await mkdir(path.join(ws, "src"), { recursive: true });
await writeFile(
  path.join(ws, "todo.md"),
  "# TODO\n\n- [ ] bump version\n- [ ] write changelog\n- [ ] deploy\n",
);
await writeFile(path.join(ws, "src/config.json"), JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2) + "\n");
await writeFile(path.join(ws, "secret.txt"), "TOP SECRET\n");

// ---------- 插件 ----------

const SYSTEM_ID = "scenario/system";
const system: Plugin = {
  id: SYSTEM_ID,
  version: "0.1.0",
  kernel: "^1",
  needs: ["transform:context.build"],
  hooks: [
    {
      kind: "transform",
      point: "context.build",
      fn: (req) => ({
        ...req,
        system: [
          {
            text: "You are a careful coding agent working inside a sandboxed workspace. Use the tools to inspect files before editing. When writing, always send the complete new file content. Be concise.",
            stability: "stable",
            origin: { by: "plugin", id: SYSTEM_ID },
            trust: "trusted",
          },
        ],
      }),
    },
  ],
};

// 读放行；写需要人工审批；碰 secret 直接拒绝，拒绝理由由插件提供（I-1）
const policy: Plugin = {
  id: "scenario/policy",
  version: "0.1.0",
  kernel: "^1",
  needs: ["gate:tool.gate"],
  hooks: [
    {
      kind: "gate",
      point: "tool.gate",
      fn: (call) => {
        const p = String((call.input as { path?: unknown }).path ?? "");
        if (p.includes("secret")) return { decision: "deny", reason: `policy: access to ${p} is forbidden` };
        if (call.name === "write_file") return { decision: "ask" };
        return { decision: "allow" };
      },
    },
  ],
};

// 记录每个完成的工具调用，用 record 写入派生数据（检验 0.8：observe 中 await 的写入在调用返回前落盘）。
// 每个调用一个键：observe 并发执行，ctx.derived 是快照，对同一个键"读-改-写"会丢更新
const stats: Plugin = {
  id: "scenario/stats",
  version: "0.1.0",
  kernel: "^1",
  needs: ["observe:event", "log:record"],
  hooks: [
    {
      kind: "observe",
      point: "event",
      fn: async (e, ctx) => {
        if (e.type !== "tool.completed") return;
        const d = e.data as { toolUseId: string; isError: boolean };
        await ctx.record(`tool-done/${d.toolUseId}`, d.isError ? "error" : "ok");
      },
    },
  ],
};

// 一轮最多 MAX_CALLS 次模型调用，防止失控
const MAX_CALLS = 12;
const budget: Plugin = {
  id: "scenario/budget",
  version: "0.1.0",
  kernel: "^1",
  needs: ["gate:turn.continue"],
  hooks: [
    {
      kind: "gate",
      point: "turn.continue",
      fn: (s) => {
        const calls = s.messages.filter((m) => m.role === "assistant").length;
        return calls >= MAX_CALLS ? { decision: "deny", reason: "budget exhausted" } : { decision: "abstain" };
      },
    },
  ],
};

// ---------- 模型 ----------

const offline = process.argv.includes("--offline");

/** 脚本化的模型：按对话进度依次给出工具调用，用来在没有 key 时跑通同一条路径 */
function scriptedProvider(): Provider {
  const origin = { by: "model", provider: "scripted", model: "scripted-1" } as const;
  const text = (t: string): Block => ({ kind: "text", text: t, origin, trust: "trusted" });
  const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin, trust: "trusted" });
  const lastResults = (messages: Message[]) =>
    new Map(
      (messages.at(-1)?.content ?? []).flatMap((b) =>
        b.kind === "tool_result" ? [[b.toolUseId, b.content.map((c) => (c.kind === "text" ? c.text : "")).join("")]] : [],
      ),
    );
  return {
    id: "scripted",
    async complete(req): Promise<ModelResponse> {
      const step = req.messages.filter((m) => m.role === "assistant").length;
      const r = lastResults(req.messages);
      const reply = (content: Block[], stopReason: ModelResponse["stopReason"] = "tool_use") => ({ model: "scripted-1", content, stopReason });
      switch (step) {
        case 0:
          return reply([text("Let me look around."), use("t1", "list_dir", { path: "." }), use("t2", "list_dir", { path: "src" })]);
        case 1:
          return reply([use("t3", "read_file", { path: "todo.md" }), use("t4", "read_file", { path: "src/config.json" }), use("t5", "read_file", { path: "secret.txt" })]);
        case 2: {
          const cfg = JSON.parse(r.get("t4") ?? "{}");
          const [a, b, c] = String(cfg.version).split(".").map(Number);
          cfg.version = `${a}.${b}.${(c ?? 0) + 1}`;
          const todo = (r.get("t3") ?? "").replace("- [ ] bump version", "- [x] bump version").replace("- [ ] write changelog", "- [x] write changelog");
          return reply([
            use("t6", "write_file", { path: "src/config.json", content: JSON.stringify(cfg, null, 2) + "\n" }),
            use("t7", "write_file", { path: "todo.md", content: todo }),
            use("t8", "write_file", { path: "CHANGELOG.md", content: `# Changelog\n\n## ${cfg.version}\n\n- Bump version.\n` }),
          ]);
        }
        default:
          return reply([text("Done: bumped version, updated todo.md, wrote CHANGELOG.md. secret.txt was blocked by policy.")], "end");
      }
    },
  };
}

const provider: Provider = offline ? scriptedProvider() : providerFromEnv();

// ---------- 运行 ----------

const plugins = [system, fsTools(ws, { id: "scenario/fs", hidden: [".log"] }), policy, stats, budget];
const store = new JsonlLogStore(logDir);
const rt = await Runtime.create({ store, provider, plugins });
const sessionId = rt.state.sessionId;

const approvals: string[] = [];
rt.subscribe((n) => {
  if (n.type === "delta" && n.delta.kind === "text") process.stdout.write(n.delta.text);
  if (n.type === "hook-error") console.warn(`\n[hook-error] ${n.info.plugin}@${n.info.point}: ${String(n.info.error)}`);
  if (n.type !== "event") return;
  const e = n.event;
  const d = e.data as Record<string, unknown>;
  if (e.type === "tool.decided") console.log(`\n[decide] ${d.toolUseId} → ${d.decision}${d.reason ? ` (${d.reason})` : ""} by ${d.decidedBy ?? "runtime"}`);
  if (e.type === "tool.completed") console.log(`[done]   ${d.toolUseId}${d.isError ? " ERROR" : ""}`);
  if (e.type === "model.responded" && offline) {
    for (const b of d.content as Block[]) if (b.kind === "text") console.log(`[model]  ${b.text}`);
  }
  if (e.type === "turn.ended") console.log(`\n[turn]   ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}`);
});

const task =
  "In this workspace: (1) list the files, (2) read todo.md, src/config.json and secret.txt, " +
  "(3) bump the patch version in src/config.json, (4) tick 'bump version' and 'write changelog' in todo.md, " +
  "(5) create CHANGELOG.md with an entry for the new version. Then report what you did.";
console.log(`workspace: ${ws}\nprovider:  ${provider.id}\n`);
await rt.send({ kind: "message", content: [{ kind: "text", text: task, origin: { by: "user" }, trust: "trusted" }] });

// 写操作挂起等待审批：模拟用户逐个批准
while (rt.state.phase === "awaiting") {
  for (const c of rt.state.batch.filter((c) => c.decision === "ask")) {
    approvals.push(c.toolUseId);
    console.log(`[approve] ${c.toolUseId} ${c.name} ${(c.input as { path: string }).path}`);
    await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved: true });
  }
}

// send 返回时，stats 的 record 必须已经落盘（0.8）
const countAtReturn = Object.keys(rt.state.derived).filter((k) => k.startsWith("tool-done/")).length;
await rt.close();

// ---------- 核对 ----------

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

const events = await readAll(store, sessionId);
const types = events.map((e) => e.type);
const rebuilt = rebuild(sessionId, events);
const completed = events.filter((e) => e.type === "tool.completed").length;
const denied = events.filter((e) => e.type === "tool.decided" && (e.data as { decision: string }).decision === "deny");

const cfg = JSON.parse(await readFile(path.join(ws, "src/config.json"), "utf8"));
const todo = await readFile(path.join(ws, "todo.md"), "utf8");
const changelog = await readFile(path.join(ws, "CHANGELOG.md"), "utf8").catch(() => "");

check("config.json 版本号变成 1.2.4", cfg.version === "1.2.4");
check("todo.md 勾选了 bump version", todo.includes("[x] bump version"));
check("todo.md 未勾选 deploy", todo.includes("[ ] deploy"));
check("CHANGELOG.md 提到 1.2.4", changelog.includes("1.2.4"));
check("secret.txt 的访问被 policy 拒绝", denied.some((e) => (e.data as { decidedBy?: string }).decidedBy === "scenario/policy"));
check("每个写操作都经过人工批准", approvals.length > 0 && events.filter((e) => e.type === "input.received" && (e.data as { kind: string }).kind === "approval").length === approvals.length);
check("send 返回时 derived 已包含全部工具计数", countAtReturn === completed);
check("日志以 session.ended 结尾", types.at(-1) === "session.ended");
check("seq 连续", events.every((e, i) => e.seq === i + 1));
check("从 JSONL 重建的状态与运行时一致", JSON.stringify(rebuilt) === JSON.stringify(rt.state));
check("session.ended 之后的写入被拒绝", await rt.send({ kind: "message", content: [] }).then(() => false, () => true));

console.log(`\n事件数 ${events.length}，工具完成 ${completed}，审批 ${approvals.length}，日志 ${path.join(logDir, sessionId + ".jsonl")}`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
if (failed === 0 && !process.argv.includes("--keep")) await rm(ws, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
