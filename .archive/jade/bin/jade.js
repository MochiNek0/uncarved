#!/usr/bin/env node
// jade 的命令行入口：Node ≥22.18 或 Bun 都可以运行，加载编译好的 dist/main.js。
// 只用最基本的语法写，太旧的 Node 也能走到这里并给出提示，而不是报一个看不懂的语法错误。
const [major, minor] = process.versions.node.split(".").map(Number);
if (!process.versions.bun && (major < 22 || (major === 22 && minor < 18))) {
  console.error("jade needs Node.js 22.18 or newer (running " + process.version + "), or Bun 1.3.9 or newer.");
  process.exit(1);
}

// --version 不用加载整个程序（导入全部依赖要一两百毫秒）。只看第一个参数，和 main.js 按顺序处理参数的结果一样
if (process.argv[2] === "-v" || process.argv[2] === "--version") {
  const { readFileSync } = await import("node:fs");
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}

// 加载 .ts 插件时，部分 Node 版本会打印 type stripping 的 ExperimentalWarning，会弄乱终端界面。
// 只去掉这一条，其他警告照常按 Node 的格式输出
if (!process.versions.bun) {
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /type stripping/i.test(w.message)) return;
    console.error("(node:" + process.pid + ") " + (w.code ? "[" + w.code + "] " : "") + w.name + ": " + w.message);
  });
}

// ink 只用 es-toolkit 的 throttle，却从 es-toolkit/compat 的总入口导入，Node 要解析、加载一千多个文件，
// 终端界面因此要多等一两百毫秒才出来。这里把它指到 throttle 所在的那一个文件（Bun 加载得快，不用管）
if (!process.versions.bun) {
  const { registerHooks } = await import("node:module");
  const { existsSync } = await import("node:fs");
  registerHooks?.({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (specifier !== "es-toolkit/compat" || !/[\\/]ink[\\/]/.test(context.parentURL || "") || !resolved.url.endsWith("/compat/index.mjs")) return resolved;
      const throttle = new URL("function/throttle.mjs", resolved.url);
      // es-toolkit 换了目录结构时照常加载总入口
      return existsSync(throttle) ? { ...resolved, url: throttle.href } : resolved;
    },
  });
}

await import("../dist/main.js");
