import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("插件代码不能加载目录之外的文件：那些文件不在哈希里，变了也不会重新确认", async () => {
  await writeFile(path.join(dir, "helper.ts"), "export const v = 1;");
  const cases = [
    `import { v } from "../../helper.ts";`,
    `export * from "../../helper.ts";`,
    `import "../../helper.ts";`,
    `const m = await import("../../helper.ts");`,
    `const name = "../../helper.ts"; await import(name);`,
    `import x from ${JSON.stringify(pathToFileURL(path.join(dir, "helper.ts")).href)};`,
  ];
  for (const [i, code] of cases.entries()) {
    const root = await writePlugin(`escape${i}`);
    await writeFile(path.join(root, "lib", "util.ts"), code);
    const { confirm, asked } = recordingConfirm(true);
    const err = await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm }).catch((e) => e);
    expect(err).toBeInstanceOf(UntrustedPlugin);
    // 在询问用户、执行代码之前就拒绝
    expect(asked).toEqual([]);
  }
  expect(globalThis.__uncarvedTrustRuns).toBe(0);

  // 目录之内的相对路径、包名都可以
  const root = await writePlugin("inside");
  await writeFile(path.join(root, "lib", "util.ts"), `import { x } from "./other.ts"; import path from "node:path"; export const y = "../not-an-import";`);
  await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm: async () => true });
});

test("包名也解析成文件：必须在插件目录内、内核自身或 Node 内置模块；只导入类型的语句不算", async () => {
  // 插件目录之外的包
  await mkdir(path.join(dir, "node_modules", "evil"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "evil", "package.json"), `{ "name": "evil", "main": "index.js" }`);
  await writeFile(path.join(dir, "node_modules", "evil", "index.js"), "export const x = 1;");
  for (const code of [`import { x } from "evil";`, `import { y } from "does-not-exist";`]) {
    const root = await writePlugin(`bare${code.length}`);
    await writeFile(path.join(root, "lib", "util.ts"), code);
    const err = await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm: async () => true }).catch((e) => e);
    expect(err).toBeInstanceOf(UntrustedPlugin);
  }

  // 插件自带的包、内置模块、只导入类型
  const root = await writePlugin("vendored");
  await mkdir(path.join(root, "node_modules", "ok"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "ok", "package.json"), `{ "name": "ok", "main": "index.js" }`);
  await writeFile(path.join(root, "node_modules", "ok", "index.js"), "export const z = 1;");
  await writeFile(
    path.join(root, "lib", "util.ts"),
    `import { z } from "ok";\nimport path from "node:path";\nimport fs from "fs";\nimport type {\n  Plugin,\n} from "evil";\nexport type { Tool } from "does-not-exist";`,
  );
  await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm: async () => true });
});

test("从内核自身导入是允许的：那是宿主已经在运行的代码", async () => {
  // 放在仓库里，"uncarved" 才能按工作区解析到内核
  const root = path.join(import.meta.dir, `.tmp-plugin-${process.pid}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.ts"), `import { KERNEL_MAJOR } from "uncarved";\nexport default { id: "k", version: "1.0.0", kernel: "^" + KERNEL_MAJOR };`);
    const loaded = await loadProjectPlugin(root, { trust: new MemoryTrustStore(), confirm: async () => true });
    expect(loaded.kernel).toBe("^1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("确认期间目录内容变了：拒绝加载，不执行改过的代码（确认的不是要运行的）", async () => {
  const root = await writePlugin("swapped");
  const trust = new MemoryTrustStore();
  const confirm: ConfirmTrust = async () => {
    // 用户看确认提示的时候，目录被改了
    await writeFile(path.join(root, "lib", "prompt.md"), "swapped while asking");
    return true;
  };
  await expect(loadProjectPlugin(root, { trust, confirm })).rejects.toBeInstanceOf(UntrustedPlugin);
  expect(globalThis.__uncarvedTrustRuns).toBe(0);
});
