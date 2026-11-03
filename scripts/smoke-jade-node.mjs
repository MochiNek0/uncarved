// 用纯 Node 跑编译好的 jade（apps/jade/bin/jade.js → dist）：bun test 覆盖不到 Node 用户实际运行的代码。
// 先 bun run build，再 node scripts/smoke-jade-node.mjs
//
// 1. --version / --help
// 2. 对着本地模拟的 /chat/completions 跑一轮 -p：模型先调用 glob、grep、bash，再回答；检查工具结果
// 3. jade plugin add 一个 .tgz（Node 下走 npm），再 plugin list
// 4. 网页转文本（web_fetch 用的 htmlToMarkdown）
import assert from "node:assert/strict";
import { execFile, execSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// JADE_BIN 可以指向别处安装的 jade（例如从 tarball 装的），验证发布出去的包
const bin = process.env.JADE_BIN ? path.resolve(process.env.JADE_BIN) : path.join(repo, "apps", "jade", "bin", "jade.js");
const tmp = await mkdtemp(path.join(tmpdir(), "jade-smoke-"));
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");

/** 运行 jade，返回 { code, stdout, stderr }；不因为非零退出码抛错 */
function jade(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd: work, env: { ...process.env, JADE_HOME: home, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = JSON.parse(body);
  requests.push(json);
  const first = requests.length === 1;
  const call = (index, name, args) => ({ index, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const delta = first
    ? { role: "assistant", tool_calls: [call(0, "glob", { pattern: "**/*.json" }), call(1, "grep", { pattern: "needle" }), call(2, "bash", { command: "echo shell-ok" })] }
    : { role: "assistant", content: "SMOKE_DONE" };
  const chunks = [
    { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

try {
  await mkdir(path.join(work, "sub"), { recursive: true });
  await mkdir(path.join(work, ".hidden"));
  await writeFile(path.join(work, "a.json"), "{}");
  await writeFile(path.join(work, "sub", "b.json"), '{ "needle": 1 }');
  await writeFile(path.join(work, ".hidden", "c.json"), "{}");

  // 1. 版本和帮助
  const version = await jade(["--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.match((await jade(["--help"])).stdout, /Usage: jade/);

  // 2. 一轮带工具调用的对话；不在 git 仓库里，glob 走目录遍历
  const env = { OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_COMPAT_API_KEY: "x", OPENAI_COMPAT_MODEL: "mock", JADE_PROVIDER: "openai-compat" };
  const turn = await jade(["-m", "yolo", "-p", "go"], env);
  assert.equal(turn.code, 0, turn.stderr + turn.stdout);
  assert.match(turn.stdout, /SMOKE_DONE/);
  assert.equal(requests.length, 2, "expected one tool round trip");
  const results = Object.fromEntries(requests[1].messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, typeof m.content === "string" ? m.content : JSON.stringify(m.content)]));
  assert.match(results.call_glob, /a\.json/);
  assert.match(results.call_glob, /sub[\\/]b\.json/);
  assert.doesNotMatch(results.call_glob, /c\.json/, "hidden directories are skipped outside git");
  assert.match(results.call_grep, /b\.json/);
  // 没有 bash（例如 Windows 上没装 Git）时 bash 工具不存在，模型的调用会被拒绝
  const hasBash = !/bash was not found/.test(turn.stdout + turn.stderr);
  if (hasBash) assert.match(results.call_bash, /shell-ok/);

  // 3. 从 .tgz 安装插件：Node 下用 npm
  const pluginSrc = path.join(tmp, "plugin");
  await mkdir(pluginSrc);
  await writeFile(path.join(pluginSrc, "package.json"), JSON.stringify({ name: "jade-smoke-plugin", version: "1.0.0", type: "module", main: "index.js" }));
  await writeFile(path.join(pluginSrc, "index.js"), `export default { id: "smoke/hello", version: "1.0.0", kernel: "^0.1", commands: [{ name: "hello", run: () => "hi" }] };\n`);
  execSync("npm pack --silent", { cwd: pluginSrc, stdio: "pipe" });
  const tgz = (await readdir(pluginSrc)).find((f) => f.endsWith(".tgz"));
  const add = await jade(["plugin", "add", path.join(pluginSrc, tgz)]);
  assert.equal(add.code, 0, add.stderr + add.stdout);
  const list = await jade(["plugin", "list"]);
  assert.match(list.stdout, /jade-smoke-plugin/);

  // 4. web_fetch 的网页转文本在 Node 下也能用（以前用的 Bun 的 HTMLRewriter，Node 里没有）
  const { htmlToMarkdown } = await import(pathToFileURL(path.join(path.dirname(bin), "..", "dist", "tools", "web.js")).href);
  const page = htmlToMarkdown(`<html><head><title>T &amp; t</title></head><body><h1>Hi</h1><p>a <a href="/x">link</a> &#20013;</p><script>no()</script></body></html>`, "https://e.com/");
  assert.deepEqual(page, { title: "T & t", text: "# Hi\n\na [link](https://e.com/x) 中" });

  if (process.env.SMOKE_VERBOSE) console.log(results, list.stdout);
  console.log(`jade node smoke ok${hasBash ? "" : " (bash not available, skipped its check)"}`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
