#!/usr/bin/env node
// jade 的命令行入口：Node ≥22.18 或 Bun 都可以运行。Bun 直接运行源码，Node 运行编译好的 dist/main.js。
// 只用最基本的语法写，太旧的 Node 也能走到这里并给出提示，而不是报一个看不懂的语法错误。
const [major, minor] = process.versions.node.split(".").map(Number);
if (!process.versions.bun && (major < 22 || (major === 22 && minor < 18))) {
  console.error("jade needs Node.js 22.18 or newer (running " + process.version + "), or Bun 1.3.9 or newer.");
  process.exit(1);
}

// 加载 .ts 插件时，部分 Node 版本会打印 type stripping 的 ExperimentalWarning。只去掉这一条
if (!process.versions.bun) {
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /type stripping/i.test(w.message)) return;
    console.error("(node:" + process.pid + ") " + (w.code ? "[" + w.code + "] " : "") + w.name + ": " + w.message);
  });
}

const { main } = await import(process.versions.bun ? "../src/main.ts" : "../dist/main.js");
// 插件留下的句柄（定时器、子进程）不应让 jade 退不出去
process.exit(await main(process.argv.slice(2)));
