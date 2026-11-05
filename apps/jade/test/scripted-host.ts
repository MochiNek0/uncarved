// jade/web、todo、ask、budget、continue、repeats 的测试用的进程内宿主：真实的 bundled 插件，
// 模型换成按脚本回复的用户层插件（不联网）。脚本和收到的请求经 globalThis 按 JADE_HOME 交给假模型插件，
// 脚本的每一项可以是回复，也可以是按请求生成回复的函数。

import { afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelRequest } from "uncarved";
import { PluginHost, type Session } from "../src/index.ts";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true }).catch(() => {});
  tmp = [];
});

export const MODEL = { by: "model" as const, provider: "scripted", model: "s1" };

export interface Reply {
  content: unknown[];
  stopReason: string;
}
export type Step = Reply | ((req: ModelRequest) => Reply);

export const say = (text: string, stopReason = "end"): Reply => ({ content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }], stopReason });
export const use = (...calls: [id: string, name: string, input: unknown][]): Reply => ({
  content: calls.map(([id, name, input]) => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" })),
  stopReason: "tool_use",
});
export const msg = (text: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text, origin: { by: "user" as const }, trust: "trusted" as const }] });

/**
 * 发一条输入，等它和之后的 afterTurn（续写等）全部做完。
 * 只 await send 就马上再 send 会碰上核心会话队列的竞争（#kick 的 finally 晚于下一次 send 才清掉 #pump，第二条输入不被处理），
 * 先 idle() 就不会
 */
export async function turn(s: Session, input: Parameters<Session["send"]>[0]): Promise<void> {
  await s.send(input);
  await s.idle();
}

/** 工具结果的文字 */
export const resultText = (b: unknown): string => {
  const x = b as { kind?: string; content?: { kind: string; text?: string }[] };
  return x?.kind === "tool_result" ? (x.content ?? []).map((c) => (c.kind === "text" ? c.text : "")).join("\n") : "";
};

const FAKE_MODEL = `export default { process(ctx) {
  const run = globalThis.__jadeScriptedHost[ctx.home];
  const provider = { id: "scripted", async complete(req) {
    run.requests.push(structuredClone(req));
    const next = run.script[run.n++];
    if (!next) throw new Error("script exhausted");
    return { model: "s1", ...(typeof next === "function" ? next(req) : next) };
  } };
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script", contextWindow: 100000 }), complete: provider.complete, list: async () => [] });
} };`;

/** config：$JADE_HOME/config.json 的内容；env：$JADE_HOME/.env 的内容；flags：选前端的命令行开关，例如 ["-p"] */
export async function scripted(script: Step[], opts: { config?: unknown; env?: string; flags?: string[]; disabled?: string[] } = {}) {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-feat-home-")));
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-feat-cwd-")));
  tmp.push(home, cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }),
  );
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  if (opts.config) await writeFile(path.join(home, "config.json"), JSON.stringify(opts.config));
  if (opts.env !== undefined) await writeFile(path.join(home, ".env"), opts.env);
  if (opts.disabled?.length) await writeFile(path.join(home, "plugins.json"), JSON.stringify({ disabled: opts.disabled }));
  const run = { script, n: 0, requests: [] as ModelRequest[] };
  const g = globalThis as { __jadeScriptedHost?: Record<string, typeof run> };
  (g.__jadeScriptedHost ??= {})[home] = run;
  const reports: string[] = [];
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd,
    report: (m) => reports.push(m),
    ...(opts.flags ? { flags: opts.flags } : {}),
  });
  return { home, cwd, host, reports, requests: run.requests };
}
