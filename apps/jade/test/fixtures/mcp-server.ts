// 测试用的 MCP 服务（stdio）。工具：
//   echo（只读）：返回参数里的 text；
//   picture：返回一张图片和一段文字；
//   fail：返回 isError；
//   crash：直接退出进程；
//   slow：一直不回复（测试中断和 notifications/cancelled）。
// tools/list 分两页返回，测试分页。往 stdout 打一行非 JSON 的日志，测试客户端会忽略它。
// 设置 MCP_MARK 时，每次启动往该文件追加一行（带进程号），测试重连和退出时关掉服务。
// 设置 MCP_GROW 时多一个 grow 工具：调用后多出 extra 工具，并发 notifications/tools/list_changed（测试会话中途换工具）。
// 设置 MCP_DELAY_FILE 且该文件存在时，按文件里的毫秒数推迟回复 initialize（测试启动慢的服务；配置不变）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.MCP_MARK) appendFileSync(process.env.MCP_MARK, `start ${process.pid}\n`);
process.stdout.write("starting fake server (not json)\n");
process.stderr.write("fake server log line\n");

const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const PAGE1 = [
  { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "picture", description: "Return a picture.", inputSchema: { type: "object" } },
];
const PAGE2 = [
  { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
  { name: "crash", description: "Exit the server.", inputSchema: { type: "object" } },
  { name: "slow", description: "Never answers.", inputSchema: { type: "object" } },
  { name: "weird.name/with:chars", description: "Odd name.", inputSchema: { type: "object" } },
];

let grown = false;
const page2 = () => [
  ...PAGE2,
  ...(process.env.MCP_GROW ? [{ name: "grow", description: "Add a tool.", inputSchema: { type: "object" } }] : []),
  ...(grown ? [{ name: "extra", description: "Added later.", inputSchema: { type: "object" } }] : []),
];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "notifications/cancelled") {
    process.stderr.write(`cancelled ${msg.params.requestId}\n`);
    if (process.env.MCP_MARK) appendFileSync(process.env.MCP_MARK, `cancelled ${msg.params.requestId}\n`);
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize": {
      const delay = process.env.MCP_DELAY_FILE && existsSync(process.env.MCP_DELAY_FILE) ? Number(readFileSync(process.env.MCP_DELAY_FILE, "utf8")) : 0;
      const result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.2.3" }, instructions: "Use echo for testing." };
      return void setTimeout(() => send({ id: msg.id, result }), delay);
    }
    case "tools/list":
      return send({ id: msg.id, result: msg.params?.cursor === "2" ? { tools: page2() } : { tools: PAGE1, nextCursor: "2" } });
    case "tools/call": {
      const { name, arguments: args } = msg.params;
      if (name === "echo") return send({ id: msg.id, result: { content: [{ type: "text", text: `echo: ${args.text}` }] } });
      if (name === "picture") {
        return send({ id: msg.id, result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }, { type: "text", text: "a picture" }] } });
      }
      if (name === "fail") return send({ id: msg.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
      if (name === "crash") process.exit(7);
      if (name === "slow") return;
      if (name === "grow") {
        grown = true;
        send({ id: msg.id, result: { content: [{ type: "text", text: "grew" }] } });
        return send({ method: "notifications/tools/list_changed" });
      }
      return send({ id: msg.id, result: { content: [{ type: "text", text: `called ${name}` }] } });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: "unknown" } });
  }
});
