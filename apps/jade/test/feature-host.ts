// 功能插件（jade/mcp、jade/skills、jade/checks）的端到端测试用：真实的 bundled 插件目录，
// 模型和 ui@1 换成用户层的假插件。假模型按 globalThis.__jadeTest.script 回复，假界面按 answers 回答。
// 和这些功能无关的 bundled 插件停用，测试只看被测的插件。

import { afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, ModelRequest, ModelResponse } from "uncarved";
import { PluginHost } from "../src/index.ts";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");
/** 这些测试要用的 bundled 插件；其余的停用 */
const KEEP = new Set(["approval", "commands", "renderers", "prompts", "fs", "mcp", "skills", "checks", "shell"]);

export const MODEL = { by: "model", provider: "scripted", model: "s1" } as const;
export type Step = Omit<ModelResponse, "model">;
export const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
export const reply = (t: string): Step => ({ content: [{ kind: "text", text: t, origin: MODEL, trust: "trusted" }], stopReason: "end" });
export const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });
export const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
export const results = (req: ModelRequest) => req.messages.at(-1)!.content.filter((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>[];

export interface TestState {
  script: Step[];
  requests: ModelRequest[];
  interactive: boolean;
  /** select 的回答，按顺序用掉；用完之后选第一项 */
  answers: (string | undefined)[];
  selects: { title: string; detail?: string }[];
  notes: string[];
}

const FAKE_MODEL = `export default { process(ctx) {
  const t = () => globalThis.__jadeTest;
  const provider = { id: "scripted", async complete(req) {
    t().requests.push(structuredClone(req));
    const next = t().script.shift();
    if (!next) throw new Error("script exhausted");
    return { model: "s1", ...next };
  } };
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script", contextWindow: 100000 }), complete: provider.complete, list: async () => [] });
} };`;

const FAKE_UI = `export default { process(ctx) {
  const t = () => globalThis.__jadeTest;
  ctx.provide("ui@1", {
    get interactive() { return t().interactive; },
    notify: (m) => t().notes.push(m),
    select: async (r) => {
      t().selects.push({ title: r.title, detail: r.detail });
      if (!t().interactive) return undefined;
      return t().answers.length ? t().answers.shift() : r.options[0]?.value;
    },
    input: async () => undefined,
  });
} };`;

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true }).catch(() => {});
  tmp = [];
});

export async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tmp.push(d);
  return d;
}

/** 启动宿主：home 是 $JADE_HOME，cwd 是工作目录（不给就新建一个） */
export async function featureHost(opts: { home?: string; cwd?: string; config?: object; plugins?: { manifest: { id: string } & Record<string, unknown>; code: string }[] } = {}) {
  const home = opts.home ?? (await tempDir("jade-feat-home-"));
  const cwd = opts.cwd ?? (await tempDir("jade-feat-cwd-"));
  const plugin = async (name: string, manifest: object, code: string) => {
    const dir = path.join(home, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(dir, "index.mjs"), code);
  };
  await plugin("fake-model", { id: "test/fake-model", provides: ["provider@1", "models@1"] }, FAKE_MODEL);
  await plugin("fake-ui", { id: "test/fake-ui", provides: ["ui@1"] }, FAKE_UI);
  for (const p of opts.plugins ?? []) await plugin(p.manifest.id.replaceAll("/", "__"), p.manifest, p.code);
  const disabled: string[] = [];
  for (const name of await readdir(BUNDLED)) {
    if (KEEP.has(name)) continue;
    try {
      disabled.push((JSON.parse(await readFile(path.join(BUNDLED, name, "plugin.json"), "utf8")) as { id: string }).id);
    } catch {
      // 别处正在写的插件目录
    }
  }
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ disabled }));
  if (opts.config) await writeFile(path.join(home, "config.json"), JSON.stringify(opts.config));

  const state: TestState = { script: [], requests: [], interactive: true, answers: [], selects: [], notes: [] };
  (globalThis as { __jadeTest?: TestState }).__jadeTest = state;
  const reports: string[] = [];
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd,
    // 和 bin/jade 一样读项目层的 .jade/config.json
    config: { project: path.join(cwd, ".jade", "config.json") },
    report: (m) => reports.push(m),
  });
  return { home, cwd, host, state, reports };
}
