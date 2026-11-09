// 测试用（jade/compact、task、memory、mentions、undo）：真实的 bundled 插件，模型和前端换成用户层的假插件。
// 假模型按脚本回复（可以抛错），记下每次请求；假前端提供 ui@1，select 按脚本回答，记下 notify。
// 两个假插件在同一个进程里运行，经 globalThis 和测试共享状态。

import { afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, ModelRequest, ModelResponse } from "uncarved";
import { PluginHost, type Session } from "../src/index.ts";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");

let tmp: string[] = [];
let hosts: PluginHost[] = [];
/** 关闭之前的测试留下的宿主。插件模块每个进程只加载一次，注册表是模块级的，不关闭的宿主的注册会留到下一个测试 */
export async function cleanup() {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
}
// 这个模块只求值一次，这里的 afterEach 只登记在第一个导入它的测试文件里：
// 每个测试文件自己也要 afterEach(cleanup)，scriptedHost 开头也清理一次
afterEach(cleanup);

export const MODEL = { by: "model", provider: "scripted", model: "s1" } as const;

/** 一次回复；error 表示这次请求抛出这个错误 */
export type Step = Omit<ModelResponse, "model"> | { error: string };

export const say = (text: string, usage?: ModelResponse["usage"]): Step => ({
  content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }],
  stopReason: "end",
  ...(usage ? { usage } : {}),
});
export const use = (id: string, name: string, input: unknown): Step => ({
  content: [{ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" }],
  stopReason: "tool_use",
});
export const userText = (text: string): Block[] => [{ kind: "text", text, origin: { by: "user" }, trust: "trusted" }];

export interface Shared {
  script: Step[];
  requests: ModelRequest[];
  current: { kind: string; model: string; via: string; contextWindow: number; vision?: boolean } | undefined;
  /** select 依次给出的回答；用完后选第一项 */
  answers: (string | undefined)[];
  asked: string[];
  /** 弹出过的对话框（标题和正文） */
  dialogs: { title: string; detail?: string }[];
  notes: string[];
  interactive: boolean;
  /** models@1.complete 每次调用的 model 选项（provider@1 的调用不记） */
  modelOptions: (string | undefined)[];
  /** 插件经 ctx.input.hint 设置过的灰色提示，按先后 */
  hints: (string | undefined)[];
  /** models@1.saved 返回的模型名 */
  saved: string[];
  /** models@1.list 返回的模型名 */
  listed: string[];
}

const FAKE_MODEL = `export default { process(ctx) {
  const g = () => globalThis.__jadeScriptedUi;
  const provider = { id: "scripted", async complete(req) {
    g().requests.push(structuredClone(req));
    const next = g().script.shift();
    if (!next) throw new Error("script exhausted");
    if (next.error) throw new Error(next.error);
    return { model: "s1", ...next };
  } };
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => g().current, complete: async (req, opts) => {
    g().modelOptions.push(opts.model);
    const res = await provider.complete(req);
    // 回复的文字当作流式增量推一遍；推的时候被中止就和真的服务一样抛出
    for (const b of res.content) if (b.kind === "text") opts.onDelta?.({ kind: "text", text: b.text });
    if (opts.signal?.aborted) throw new Error("aborted");
    return res;
  }, list: async () => g().listed, saved: async () => g().saved });
} };`;

const FAKE_FRONTEND = `export default { process(ctx) {
  const g = () => globalThis.__jadeScriptedUi;
  ctx.provide("frontend@1", { run: async () => 0 });
  ctx.provide("ui@1", {
    get interactive() { return g().interactive; },
    notify: (m) => void g().notes.push(m),
    select: async (r) => { g().asked.push(r.title); g().dialogs.push({ title: r.title, ...(r.detail ? { detail: r.detail } : {}) }); const a = g().answers.shift(); return a === undefined ? r.options[0]?.value : a === "" ? undefined : a; },
    input: async () => undefined,
    session: () => ({
      status: () => {},
      draft: { text: () => "", insert: () => {}, set: () => {}, hint: (t) => void g().hints.push(t) },
      dispose: () => {},
    }),
  });
} };`;

/** files：启动前写进 $JADE_HOME 的文件，路径相对 home */
export async function scriptedHost(opts: { config?: Record<string, Record<string, unknown>>; files?: Record<string, string> } = {}) {
  await cleanup();
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-home-")));
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-cwd-")));
  tmp.push(home, cwd);
  const shared: Shared = {
    script: [],
    requests: [],
    current: { kind: "scripted", model: "s1", via: "a script", contextWindow: 200_000 },
    answers: [],
    asked: [],
    dialogs: [],
    notes: [],
    interactive: true,
    modelOptions: [],
    hints: [],
    saved: [],
    listed: [],
  };
  (globalThis as { __jadeScriptedUi?: Shared }).__jadeScriptedUi = shared;
  const plugin = async (name: string, manifest: object, code: string) => {
    const dir = path.join(home, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(dir, "index.mjs"), code);
  };
  await plugin("fake-model", { id: "test/fake-model", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }, FAKE_MODEL);
  await plugin("fake-frontend", { id: "test/fake-frontend", provides: ["frontend@1", "ui@1"], replaces: ["jade/tui"], frontend: { name: "fake", default: true } }, FAKE_FRONTEND);
  await writeFile(path.join(home, "config.json"), JSON.stringify({ "jade/approval": { mode: "yolo" }, ...opts.config }));
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  }
  const reports: string[] = [];
  const start = async () => {
    const h = await PluginHost.start({
      roots: [
        { layer: "bundled", root: BUNDLED },
        { layer: "user", root: path.join(home, "plugins") },
      ],
      home,
      cwd,
      report: (m) => reports.push(m),
    });
    hosts.push(h);
    return h;
  };
  const host = await start();
  /** 发一条消息，等会话空闲（包括 afterTurn 排进来的重试）；这一轮失败时不抛出 */
  const send = async (s: Session, text: string) => {
    await s.send({ kind: "message", content: userText(text) }).catch(() => {});
    await s.idle();
  };
  /** 同一个 home 再启动一个宿主，相当于重启 jade（例如测试改写过的日志要由新的日志存储读取） */
  return { home, cwd, host, shared, reports, send, restart: start };
}

/** 一条消息里的全部文字 */
export const textOf = (blocks: readonly Block[]): string =>
  blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : b.kind === "tool_result" ? [textOf(b.content)] : []))
    .join("\n");
