import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryTrustStore, type ConfirmTrust } from "uncarved";
import { info, world } from "./helpers.ts";

// 项目层插件：经内核的 importProjectModule 确认后才执行（第 7 节）

const g = globalThis as { __runs?: number; __ctx?: { input?: unknown; status?: unknown; session: { send(i: unknown): Promise<void>; abort(reason?: string): void } } };
beforeEach(() => {
  g.__runs = 0;
});
afterEach(() => {
  delete g.__runs;
  delete g.__ctx;
});

const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", { id: "none", async complete() { throw new Error("not used"); } });
} };`;

const PROJECT = `globalThis.__runs += 1;
export default { session(ctx) {
  globalThis.__ctx = ctx;
  ctx.kernel.tool({ name: "repo_tool", effect: "read", description: "x", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true, execute: async () => ({ content: "ok" }) });
} };`;

function confirmer(answer: boolean) {
  const asked: string[] = [];
  const confirm: ConfirmTrust = async (req) => {
    asked.push(req.path);
    return answer;
  };
  return { confirm, asked };
}

test("without a way to ask, project plugins are not loaded and nothing runs", async () => {
  const w = await world();
  await w.plugin("project", { id: "repo/x" }, PROJECT);
  const host = await w.start();
  expect(info(host, "repo/x")).toMatchObject({ state: "untrusted" });
  expect(g.__runs).toBe(0);
  await host.close();
});

test("a declined project plugin runs no code and is not counted as a fault", async () => {
  const w = await world();
  const dir = await w.plugin("project", { id: "repo/x" }, PROJECT);
  const { confirm, asked } = confirmer(false);
  for (let i = 0; i < 4; i++) {
    const host = await w.start({ trust: { trust: new MemoryTrustStore(), confirm } });
    expect(info(host, "repo/x").state).toBe("untrusted");
    await host.close();
  }
  expect(asked).toEqual([dir, dir, dir, dir]);
  expect(g.__runs).toBe(0);
});

test("a confirmed project plugin works in sessions, and a change asks again", async () => {
  const w = await world();
  await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
  const dir = await w.plugin("project", { id: "repo/x" }, PROJECT);
  const trust = new MemoryTrustStore();

  const yes = confirmer(true);
  const host = await w.start({ trust: { trust, confirm: yes.confirm } });
  expect(info(host, "repo/x").state).toBe("active");
  // 内核接受了它（未经确认的项目层插件会让 Runtime 拒绝整个会话）
  const s1 = await host.sessions.open();
  const s2 = await host.sessions.open(); // mark 可以每个会话用一次
  expect(s2.state.plugins.map((p) => p.id)).toEqual(["jade/core", "repo/x"]);
  expect(s1.id).not.toBe(s2.id);
  // 项目层插件不能替用户说话
  expect(() => g.__ctx!.session.send({ kind: "message", content: [] })).toThrow("project plugins cannot send input");
  expect(() => g.__ctx!.session.abort()).toThrow("project plugins cannot stop turns");
  await host.close();
  expect(yes.asked).toEqual([dir]);

  // 内容变了：哈希不同，重新确认
  await writeFile(path.join(dir, "index.mjs"), PROJECT + "\n// changed\n");
  const no = confirmer(false);
  const again = await w.start({ trust: { trust, confirm: no.confirm } });
  expect(no.asked).toEqual([dir]);
  expect(info(again, "repo/x").state).toBe("untrusted");
  await again.close();
});

test("a project plugin gets a status segment but not the input box", async () => {
  const w = await world();
  await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
  await w.plugin(
    "bundled",
    { id: "ui", provides: ["ui@1"] },
    `export default { process(ctx) {
      const draft = { text: () => "", insert() {}, set() {}, hint() {} };
      ctx.provide("ui@1", { interactive: true, notify() {}, select: async () => undefined, input: async () => undefined, session: () => ({ status() {}, draft, dispose() {} }) });
    } };`,
  );
  await w.plugin("project", { id: "repo/x" }, PROJECT);
  const host = await w.start({ trust: { trust: new MemoryTrustStore(), confirm: confirmer(true).confirm } });
  await host.sessions.open();
  expect(typeof g.__ctx!.status).toBe("function");
  expect(g.__ctx!.input).toBeUndefined();
  await host.close();
});

test("a project plugin importing code outside its directory is refused before asking", async () => {
  const w = await world();
  await w.plugin("project", { id: "repo/sneaky" }, `import "../../../outside.mjs"; export default {};`);
  await writeFile(path.join(w.home, "outside.mjs"), "globalThis.__runs += 1;");
  const { confirm, asked } = confirmer(true);
  const host = await w.start({ trust: { trust: new MemoryTrustStore(), confirm } });
  expect(info(host, "repo/sneaky").state).toBe("untrusted");
  expect(asked).toEqual([]);
  expect(g.__runs).toBe(0);
  await host.close();
});
