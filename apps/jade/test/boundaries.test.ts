// 没有特权接口（jade.md 原则 2、3.5）：内置插件从核心只 import 类型和 definePlugin，运行时用到的都经 ctx 和服务拿。
// 第三方插件拿不到 ../../src/，内置插件用了它，就是用了第三方没有的接口。

import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

test("bundled plugins import nothing from the core but types and definePlugin", async () => {
  const root = path.resolve(import.meta.dir, "../plugins");
  const bad: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    const file = path.join(e.parentPath, e.name);
    for (const m of (await readFile(file, "utf8")).matchAll(/^import\s+(type\s+)?(.+?)\s+from\s+"(?:\.\.\/)+src\/([^"]+)"/gm)) {
      if (m[1]) continue;
      const values = m[2]!.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "));
      if (m[3] !== "api.ts" || values.some((v) => v !== "definePlugin")) bad.push(`${path.relative(root, file)}: ${m[0]}`);
    }
  }
  expect(bad).toEqual([]);
});
