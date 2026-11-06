// 把内置插件编译成 plugins-dist/：Node 不给 node_modules 里的 .ts 去类型，npm 装的 jade 要靠编译好的 .js。
// plugins-dist 和 plugins 在包里同一层，插件里的 ../../package.json、../其他插件/ 照样成立；
// ../../src/ 改指 ../../dist/，让插件和宿主（dist）用同一份模块
import { execFileSync } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(pkg, ".plugins-build");
const out = path.join(pkg, "plugins-dist");
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
await rm(tmp, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", path.join(pkg, "tsconfig.plugins.json")], { stdio: "inherit" });

// 先放编译出的 .js，再放源目录里除 .ts 以外的文件（plugin.json 等）
await cp(path.join(tmp, "plugins"), out, { recursive: true });
await cp(path.join(pkg, "plugins"), out, { recursive: true, filter: (src) => !src.endsWith(".ts") });
await rm(tmp, { recursive: true, force: true });

for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  if (entry.name.endsWith(".js")) {
    const src = await readFile(file, "utf8");
    await writeFile(file, src.replace(/(["'])\.\.\/\.\.\/src\//g, "$1../../dist/"));
  } else if (entry.name === "plugin.json") {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (typeof manifest.entry === "string") manifest.entry = manifest.entry.replace(/\.ts$/, ".js");
    await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  }
}
