import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MemoryLogStore,
  MemoryTrustStore,
  Runtime,
  UntrustedPlugin,
  loadProjectPlugin,
  type ConfirmTrust,
  type Provider,
} from "../src/index.ts";

// 插件模块被执行时计数，用来证明未确认的代码没有运行
declare global {
  var __uncarvedTrustRuns: number | undefined;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "uncarved-trust-"));
  globalThis.__uncarvedTrustRuns = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePlugin(name: string, version = "1.0.0") {
  const root = path.join(dir, name);
  await mkdir(path.join(root, "lib"), { recursive: true });
  await writeFile(
    path.join(root, "index.ts"),
    `globalThis.__uncarvedTrustRuns = (globalThis.__uncarvedTrustRuns ?? 0) + 1;\n` +
      `export default { id: "${name}", version: "${version}", kernel: "^1" };\n`,
  );
  await writeFile(path.join(root, "lib", "prompt.md"), "hello");
  return root;
}

function recordingConfirm(answer: boolean) {
  const asked: Parameters<ConfirmTrust>[0][] = [];
  const confirm: ConfirmTrust = async (req) => {
    asked.push(req);
    return answer;
  };
  return { confirm, asked };
}

const provider: Provider = {
  id: "none",
  async complete() {
    throw new Error("not used");
  },
};

test("未确认的内容先询问；拒绝时不执行插件代码，也不保存记录", async () => {
  const root = await writePlugin("denied");
  const trust = new MemoryTrustStore();
  const { confirm, asked } = recordingConfirm(false);

  await expect(loadProjectPlugin(root, { trust, confirm })).rejects.toBeInstanceOf(UntrustedPlugin);
  expect(asked).toHaveLength(1);
  expect(asked[0]!.files).toEqual(["index.ts", "lib/prompt.md"]);
  expect(globalThis.__uncarvedTrustRuns).toBe(0);
  expect(await trust.has(asked[0]!.hash)).toBe(false);
});

test("确认后按哈希保存，同样的内容不再询问，加载结果固定为项目层", async () => {
  const root = await writePlugin("approved");
  const trust = new MemoryTrustStore();
  const first = recordingConfirm(true);

  const plugin = await loadProjectPlugin(root, { trust, confirm: first.confirm });
  expect(plugin.layer).toBe("project");
  expect(await trust.has(first.asked[0]!.hash)).toBe(true);

  const second = recordingConfirm(false);
  await loadProjectPlugin(root, { trust, confirm: second.confirm });
  expect(second.asked).toHaveLength(0);

  const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin] });
  expect(rt.state.plugins).toEqual([{ id: "approved", version: "1.0.0" }]);
});

test("内容变化后需要重新确认；同一进程内已导入的目录不能换成新内容", async () => {
  const root = await writePlugin("changing");
  const trust = new MemoryTrustStore();
  const { confirm, asked } = recordingConfirm(true);
  await loadProjectPlugin(root, { trust, confirm });

  await writeFile(path.join(root, "lib", "prompt.md"), "changed");
  const err = await loadProjectPlugin(root, { trust, confirm }).catch((e) => e);
  expect(asked).toHaveLength(2);
  expect(asked[1]!.hash).not.toBe(asked[0]!.hash);
  expect(err).toBeInstanceOf(UntrustedPlugin);
  expect(err.message).toContain("restart");
});

test("绕过加载器、直接注册的项目层插件被拒绝", async () => {
  const forged = { id: "forged", version: "1.0.0", kernel: "^1", layer: "project" as const };
  await expect(Runtime.create({ store: new MemoryLogStore(), provider, plugins: [forged] })).rejects.toBeInstanceOf(
    UntrustedPlugin,
  );
  // 复制一个已确认的插件对象也不行：确认只对加载器返回的那个对象有效
  const root = await writePlugin("copied");
  const loaded = await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm: async () => true });
  await expect(
    Runtime.create({ store: new MemoryLogStore(), provider, plugins: [{ ...loaded }] }),
  ).rejects.toBeInstanceOf(UntrustedPlugin);
});
