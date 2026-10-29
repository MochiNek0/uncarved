// 在指定文件夹里干活的 agent：可以列目录、读文件、写文件，写之前在终端里问你批不批准。
//
// 运行：bun examples/agent.ts --dir <文件夹> "任务"   执行一个任务后退出
//       bun examples/agent.ts --dir <文件夹>          对话模式，空行退出
//       加 --yes 自动批准所有写操作
//
// 文件夹不存在会自动创建；所有路径都限定在这个文件夹内。provider 选择见 shared.ts

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { MemoryLogStore, Runtime, type Block, type Plugin } from "uncarved";
import { fsTools, providerFromEnv } from "./shared.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const yes = args.includes("--yes");
if (yes) args.splice(args.indexOf("--yes"), 1);
const dir = path.resolve(flag("--dir") ?? ".");
const task = args.join(" ").trim();

await mkdir(dir, { recursive: true });

const SYSTEM_ID = "agent/system";
const system: Plugin = {
  id: SYSTEM_ID,
  version: "0.1.0",
  kernel: "^1",
  hooks: [
    {
      kind: "transform",
      point: "context.build",
      fn: (req) => ({
        ...req,
        system: [
          {
            text:
              "You are a helpful agent working inside a single folder (the workspace root). " +
              "Use list_dir / read_file to look before you change anything, and write_file with the complete content to create or edit files. " +
              "Paths are relative to the workspace root. Reply in the user's language and keep it short.",
            stability: "stable",
            origin: { by: "plugin", id: SYSTEM_ID },
            trust: "trusted",
          },
        ],
      }),
    },
  ],
};

// 读直接放行，写要人工批准
const policy: Plugin = {
  id: "agent/policy",
  version: "0.1.0",
  kernel: "^1",
  hooks: [
    {
      kind: "gate",
      point: "tool.gate",
      fn: (call) => ({ decision: call.name === "write_file" ? "ask" : "allow" }),
    },
  ],
};

const rt = await Runtime.create({
  store: new MemoryLogStore(),
  provider: providerFromEnv(),
  plugins: [system, fsTools(dir), policy],
});

rt.subscribe((n) => {
  if (n.type === "delta" && n.delta.kind === "text") process.stdout.write(n.delta.text);
  if (n.type !== "event") return;
  const d = n.event.data as Record<string, unknown>;
  if (n.event.type === "tool.decided") {
    const call = rt.state.batch.find((c) => c.toolUseId === d.toolUseId);
    const p = (d.input as { path?: string } | undefined)?.path ?? "";
    if (d.decision !== "ask") console.log(`\n[${call?.name ?? "?"}] ${p}${d.decision === "deny" ? " (denied)" : ""}`);
  }
  if (n.event.type === "tool.completed" && d.isError) {
    console.log(`[error] ${(d.content as Block[]).map((b) => (b.kind === "text" ? b.text : "")).join("")}`);
  }
  if (n.event.type === "turn.ended" && d.reason !== "end") console.log(`\n[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`);
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function approvePending() {
  while (rt.state.phase === "awaiting") {
    for (const c of rt.state.batch.filter((c) => c.decision === "ask")) {
      const { path: p, content } = c.input as { path: string; content: string };
      const preview = content.length > 600 ? content.slice(0, 600) + `\n…（共 ${content.length} 字符）` : content;
      console.log(`\n── 要写入 ${path.join(dir, p)} ──\n${preview}\n──`);
      const ok = yes || /^y/i.test(await rl.question("批准写入？[y/N] "));
      if (yes) console.log("（--yes 自动批准）");
      await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved: ok, reason: ok ? undefined : "user rejected the write" });
    }
  }
}

async function run(text: string) {
  try {
    await rt.send({ kind: "message", content: [{ kind: "text", text, origin: { by: "user" }, trust: "trusted" }] });
    await approvePending();
  } catch (err) {
    console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
  }
  process.stdout.write("\n");
}

console.log(`workspace: ${dir}`);
if (task) {
  await run(task);
} else {
  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (!line) break;
    await run(line);
  }
}
rl.close();
await rt.close();
