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
      return {};
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
        case "deny-danger":
          return payload.name === "danger" ? { decision: "deny", reason: "blocked by process" } : { decision: "abstain" };
        case "hang":
          return new Promise(() => {});
        case "record":
          await ask("log/record", { call: msg.id, key: "fixture/k", value: 42 });
          return {};
        case "crash":
          process.exit(3);
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
