// 用纯 Node 跑发布产物（dist）：bun test 只覆盖源码和 bun 导入条件，覆盖不到 Node 用户实际加载的代码。
// 先 bun run build，再 node scripts/smoke-node.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_VERSION, MemoryTrustStore, Runtime, loadProjectPlugin, readAll } from "uncarved";
import { JsonlLogStore } from "@uncarved/store-jsonl";
import "@uncarved/plugin-stdio";
import "@uncarved/provider-anthropic";
import "@uncarved/provider-openai-compat";
import "@uncarved/provider-openai-responses";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await mkdtemp(path.join(tmpdir(), "uncarved-smoke-"));
// 项目插件要放在仓库里，"uncarved" 才能解析到内核
const pluginDir = path.join(repo, `.tmp-smoke-plugin-${process.pid}`);
try {
  // 跑一轮对话，日志写进 JSONL
  const store = new JsonlLogStore(tmp);
  const provider = {
    id: "stub",
    async complete() {
      return {
        model: "stub-1",
        content: [{ kind: "text", text: "hi", origin: { by: "model", provider: "stub", model: "stub-1" }, trust: "trusted" }],
        stopReason: "end_turn",
      };
    },
  };
  const rt = await Runtime.create({ store, provider, plugins: [] });
  await rt.send({ kind: "message", content: [{ kind: "text", text: "hello", origin: { by: "user" }, trust: "trusted" }] });
  await rt.close();
  const events = await readAll(new JsonlLogStore(tmp), rt.state.sessionId);
  assert.ok(events.some((e) => e.type === "model.responded"));

  // 项目插件从内核导入值：内核只声明了 import 条件，按 require 规则会解析失败
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "index.js"),
    `import { KERNEL_VERSION } from "uncarved";\nexport default { id: "smoke", version: "1.0.0", kernel: "^" + KERNEL_VERSION };\n`,
  );
  const loaded = await loadProjectPlugin(pluginDir, { trust: new MemoryTrustStore(), confirm: async () => true, entry: "index.js" });
  assert.equal(loaded.kernel, `^${KERNEL_VERSION}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  await rm(pluginDir, { recursive: true, force: true });
}
console.log("node smoke ok");
