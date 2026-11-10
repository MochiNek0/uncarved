// 把内置插件编译成 plugins-dist/：Node 不给 node_modules 里的 .ts 去类型，npm 装的 jade 要靠编译好的 .js。
// plugins-dist 和 plugins 在包里同一层，插件里的 ../../package.json、../其他插件/ 照样成立。
// 插件不 import 宿主的模块（只从 @uncarved/jade-api 拿类型和 definePlugin），所以路径不用改写
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

const vendors = [];
for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  if (entry.name === "vendor.js") vendors.push(file);
  if (entry.name === "plugin.json") {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (typeof manifest.entry === "string") manifest.entry = manifest.entry.replace(/\.ts$/, ".js");
    await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  }
}

// 插件目录里的 vendor.js 连同依赖打成一个文件（scripts/bundle-vendor.ts）：Node 逐个加载小模块很慢。
// 打包要 Bun；仓库本来就用 Bun 安装、测试和发布
if (vendors.length > 0) {
  execFileSync("bun", [path.join(pkg, "scripts", "bundle-vendor.ts"), ...vendors], { stdio: "inherit" });
}
