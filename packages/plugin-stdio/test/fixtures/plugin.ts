// 测试用的进程外插件。清单来自环境变量 FIXTURE_MANIFEST，hook 的行为由 hook 名决定。
// 设置 FIXTURE_MARK 时，启动后立即写入该文件，用来证明进程是否被启动过。

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface Msg {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { message: string };
}

const manifest = JSON.parse(process.env.FIXTURE_MANIFEST!);
if (process.env.FIXTURE_MARK) writeFileSync(process.env.FIXTURE_MARK, "started");
// 不肯退出的插件：忽略 SIGTERM，不回复 shutdown，stdin 关闭后也不退出
const stubborn = process.env.FIXTURE_STUBBORN === "1";
if (stubborn) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let nextId = 1;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const ask = (method: string, params: object) =>
  new Promise((resolve, reject) => {
    const id = `p${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.method) {
    case "initialize":
      return manifest;
    case "shutdown":
      return stubborn ? new Promise(() => {}) : {};
    case "hook": {
      const { hook, payload } = msg.params!;
      switch (hook) {
        case "append-system":
          return {
            system: [
              ...payload.system,
              { text: "from process", stability: "stable", origin: { by: "plugin", id: manifest.id }, trust: "untrusted" },
            ],
          };
        case "env":
          return {
            system: [...payload.system, { text: process.env.PATH ?? "", stability: "stable", origin: { by: "plugin", id: manifest.id }, trust: "untrusted" }],
          };
        case "deny-danger":
          return payload.name === "danger" ? { decision: "deny", reason: "blocked by process" } : { decision: "abstain" };
        case "hang":
          return new Promise(() => {});
        case "record":
          await ask("log/record", { call: msg.id, key: "fixture/k", value: 42 });
          return {};
        case "crash":
          process.exit(3);
        case "flood":
          // 一条超长、没有换行的消息
          process.stdout.write("x".repeat(64 * 1024));
          return new Promise(() => {});
        case "no-newline":
          // 最后一条回复不带换行，写完后退出
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), () => process.exit(0));
          return new Promise(() => {});
        case "deaf":
          // 卡死，不再读 stdin，宿主发来的数据堆在管道里
          for (;;);
        case "garbage":
          // 合法的 JSON，但不是 JSON-RPC 消息
          process.stdout.write("null\n");
          return new Promise(() => {});
      }
    }
  }
  throw new Error(`unknown ${msg.method}`);
}

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line) as Msg;
  if (msg.method === undefined) {
    const p = pending.get(String(msg.id));
    pending.delete(String(msg.id));
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    continue;
  }
  if (msg.method === "$/cancel") {
    process.stderr.write(`cancel ${msg.params!.id}\n`);
    continue;
  }
  // 不等待：处理期间还要能收到 log/record 的回复
  handle(msg).then(
    (result) => send({ id: msg.id, result }),
    (err) => send({ id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } }),
  );
}
