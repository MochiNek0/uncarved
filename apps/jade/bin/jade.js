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

// 代理：Bun 的 fetch 自己读 HTTPS_PROXY 等变量；Node 的 fetch 默认不读（要 NODE_USE_ENV_PROXY=1），这里替它打开。
// 只改本进程的网络设置，不改环境变量，子进程照旧按自己的规则处理
if (!process.versions.bun && !process.env.NODE_USE_ENV_PROXY) {
  const e = process.env;
  if (e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) {
    const http = await import("node:http");
    if (typeof http.setGlobalProxyFromEnv === "function") http.setGlobalProxyFromEnv();
    else console.error("jade: a proxy is set (HTTPS_PROXY), but this Node.js cannot apply it to jade's requests; use a newer Node.js, or Bun");
  }
}

const { main } = await import(process.versions.bun ? "../src/main.ts" : "../dist/main.js");
// 插件留下的句柄（定时器、子进程）不应让 jade 退不出去
process.exit(await main(process.argv.slice(2)));
