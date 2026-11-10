// 没有特权接口（jade.md 原则 2、3.5）：内置插件不 import 核心的模块。类型和 definePlugin 来自 @uncarved/jade-api，
// 运行时用到的都经 ctx 和服务拿。第三方插件拿不到 ../../src/，内置插件用了它，就是用了第三方没有的接口。

import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { API_VERSION } from "../src/index.ts";

test("bundled plugins import nothing from the core", async () => {
  const root = path.resolve(import.meta.dir, "../plugins");
  const bad: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    const file = path.join(e.parentPath, e.name);
    for (const m of (await readFile(file, "utf8")).matchAll(/(?:from|import\()\s*"((?:\.\.\/)+(?:src|dist)\/[^"]*|@uncarved\/jade)"/g)) {
      bad.push(`${path.relative(root, file)}: ${m[1]}`);
    }
  }
  expect(bad).toEqual([]);
});

// 服务的类型在 @uncarved/jade-api/services（3.5）：内置插件之间也不按相对路径拿对方的类型，和第三方走同一条路
test("bundled plugins import nothing from each other", async () => {
  const root = path.resolve(import.meta.dir, "../plugins");
  const bad: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    const file = path.join(e.parentPath, e.name);
    const own = path.relative(root, file).split(path.sep)[0]!;
    for (const m of (await readFile(file, "utf8")).matchAll(/(?:from|import\()\s*"(\.\.?\/[^"]*)"/g)) {
      const target = path.relative(root, path.resolve(path.dirname(file), m[1]!)).split(path.sep)[0];
      if (target !== own && !m[1]!.endsWith("package.json")) bad.push(`${path.relative(root, file)}: ${m[1]}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the API version the core checks plugins against is the version of @uncarved/jade-api", async () => {
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../../packages/jade-api/package.json"), "utf8"));
  expect(pkg.version).toBe(API_VERSION);
});
