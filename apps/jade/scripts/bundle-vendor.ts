// 由 build-plugins.mjs 调用（要 Bun）：把插件目录里编译出的 vendor.js 连同它导入的依赖打成一个文件，原地替换。
// 依赖由很多小模块组成时，Node 逐个解析、读文件很慢（ink 约 470ms，打包后约 120ms，docs/review.md #28）。
//
// - 按生产环境打包（process.env.NODE_ENV 固定为 "production"）：react 等不带开发版检查
// - ink 的 devtools（只在 DEV=true 且装了 react-devtools-core 时才连接）换成空模块，否则会把 ws 整个打进来
// - node 内置模块不打包
const STUBS = /^(react-devtools-core|\.\/devtools\.js)$/;

for (const file of process.argv.slice(2)) {
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
