// treeHash：插件目录的哈希，判断装好的插件有没有被手动改过。

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { treeHash } from "../src/hash.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test("a symlink is not followed, but pointing it elsewhere changes the hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jade-hash-"));
  dirs.push(root);
  const plugin = path.join(root, "plugin");
  await mkdir(plugin);
  await writeFile(path.join(plugin, "index.js"), "export default {}\n");
  await writeFile(path.join(root, "a.js"), "a\n");
  await writeFile(path.join(root, "b.js"), "b\n");
  const plain = await treeHash(plugin);
  try {
    await symlink(path.join(root, "a.js"), path.join(plugin, "lib.js"), "file");
  } catch (e) {
    // Windows 上没有开发者模式时建不了符号链接
    if ((e as NodeJS.ErrnoException).code === "EPERM") return;
    throw e;
  }
  const toA = await treeHash(plugin);
  expect(toA).not.toBe(plain);
  await writeFile(path.join(root, "a.js"), "changed outside\n");
  expect(await treeHash(plugin)).toBe(toA);
  await rm(path.join(plugin, "lib.js"));
  await symlink(path.join(root, "b.js"), path.join(plugin, "lib.js"), "file");
  expect(await treeHash(plugin)).not.toBe(toA);
});
