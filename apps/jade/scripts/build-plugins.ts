// 把内置插件编译成 plugins-dist/（要 Bun；仓库本来就用 Bun 安装、测试和发布）：
// Node 不给 node_modules 里的 .ts 去类型，npm 装的 jade 要靠编译好的 .js。
// plugins-dist 和 plugins 在包里同一层，插件里的 ../../package.json、../其他插件/ 照样成立。
// 插件不 import 宿主的模块（只从 @uncarved/jade-api 拿类型和 definePlugin），所以只需把相对导入的 .ts 改成 .js。
//
// 这里只去掉类型，不做类型检查：类型检查由 bun run typecheck（根 tsconfig.json，含 apps/*/plugins）做。
// 原来用 tsc 编译，要连带检查 ink、@anthropic-ai/sdk 等九百多个声明文件，比去类型本身慢得多。
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const pkg = path.dirname(import.meta.dir);
const src = path.join(pkg, "plugins");
const out = path.join(pkg, "plugins-dist");
await rm(out, { recursive: true, force: true });

// 插件开了 erasableSyntaxOnly，去类型就是全部的转换。保留没用到的导入，和 verbatimModuleSyntax 下 tsc 的输出一致
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node", trimUnusedImports: false });
// 和 tsc 的 rewriteRelativeImportExtensions 一样：只改相对路径的 import/export ... from、import "..."、import("...")
const RELATIVE_TS = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"'\n]*?)\.ts\2/g;

const vendors: string[] = [];
const writes: Promise<void>[] = [];
for (const entry of await readdir(src, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const rel = path.relative(src, from);
  writes.push(
    (async () => {
      let target = path.join(out, rel);
      let data: string | Buffer = await readFile(from);
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        target = target.slice(0, -3) + ".js";
        data = transpiler.transformSync(data.toString("utf8")).replace(RELATIVE_TS, "$1$2$3.js$2");
        if (entry.name === "vendor.ts") vendors.push(target);
      } else if (entry.name === "plugin.json") {
        const manifest = JSON.parse(data.toString("utf8"));
        if (typeof manifest.entry === "string") manifest.entry = manifest.entry.replace(/\.ts$/, ".js");
        data = JSON.stringify(manifest, null, 2) + "\n";
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    })(),
  );
}
await Promise.all(writes);

// 插件目录里的 vendor.js 连同依赖打成一个文件，原地替换：依赖由很多小模块组成时，
// Node 逐个解析、读文件很慢（ink 约 470ms，打包后约 120ms，docs/review.md #28）。
// - 按生产环境打包（process.env.NODE_ENV 固定为 "production"）：react 等不带开发版检查
// - ink 的 devtools（只在 DEV=true 且装了 react-devtools-core 时才连接）换成空模块，否则会把 ws 整个打进来
// - node 内置模块不打包
const STUBS = /^(react-devtools-core|\.\/devtools\.js)$/;
for (const file of vendors) {
  const result = await Bun.build({
    entrypoints: [file],
    target: "node",
    format: "esm",
    minify: { syntax: true, whitespace: false, identifiers: false },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "stub",
        setup(build) {
          build.onResolve({ filter: STUBS }, (args) => ({ path: args.path, namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));
        },
      },
    ],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bundling ${file} failed`);
  }
  await Bun.write(file, result.outputs[0]!);
}
