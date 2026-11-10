// jade/models 的 /model：切换保存过的模型、改当前模型的设置、加一个模型。
// 真实的 bundled 插件，模型服务是 openai-compat（fetch 换成假的），界面换成按脚本回答的假插件。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Provider } from "uncarved";
import { PluginHost } from "../src/index.ts";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import type { Models } from "../plugins/models/index.ts";
import { parseEnv } from "../plugins/models/config.ts";
import { updateEnvFile } from "../plugins/models/saved.ts";
import type { ModelRequest } from "uncarved";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");
/** 这些测试要用的 bundled 插件；其余的停用 */
const KEEP = new Set(["models", "commands"]);

/** 模型配置相关的环境变量：测试里清掉，只让 .env 说了算 */
const ENV_KEYS = [
  "JADE_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_EXTRA_BODY",
  "JADE_MAX_TOKENS",
  "JADE_EFFORT",
  "JADE_CONTEXT_WINDOW",
  "JADE_RPM",
  "JADE_VISION",
];

const ENV_A = "JADE_PROVIDER=openai-compat\nOPENAI_COMPAT_BASE_URL=https://a.example/v1\nOPENAI_COMPAT_MODEL=m1\nOPENAI_COMPAT_API_KEY=ka\n";
const SERVICES = {
  services: [
    { env: { JADE_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "https://a.example/v1", OPENAI_COMPAT_API_KEY: "ka" }, models: [{ name: "m1", settings: {} }] },
    {
      env: { JADE_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "https://b.example/v1", OPENAI_COMPAT_API_KEY: "kb" },
      models: [{ name: "m2", settings: { JADE_MAX_TOKENS: "64000" } }],
    },
  ],
};

interface Shared {
  selects: (string | number | undefined)[];
  inputs: (string | undefined)[];
  asked: string[];
  inputsAsked: string[];
  notes: string[];
}

const FAKE_UI = `export default { process(ctx) {
  const g = () => globalThis.__jadeModelTest;
  ctx.provide("ui@1", {
    interactive: true,
    notify: (m) => void g().notes.push(m),
    select: async (r) => {
      g().asked.push(r.title);
      const a = g().selects.shift();
      if (a === undefined) return undefined;
      return typeof a === "number" ? r.options[a]?.value : a;
    },
    input: async (r) => { g().inputsAsked.push(r.title); return g().inputs.shift(); },
  });
} };`;

let tmp: string[] = [];
let savedEnv: Record<string, string | undefined> = {};
let urls: string[] = [];
let bodies: unknown[] = [];
let respond: (url: string, init: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  urls = [];
  bodies = [];
  // 默认：服务不提供模型列表
  respond = () => new Response("not found", { status: 404 });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return respond(String(url), init);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete (globalThis as { __jadeModelTest?: Shared }).__jadeModelTest;
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(env: string = ENV_A) {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-model-")));
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-model-cwd-")));
  tmp.push(home, cwd);
  await writeFile(path.join(home, ".env"), env);
  await writeFile(path.join(home, "models.json"), JSON.stringify(SERVICES));
  const plugin = async (name: string, manifest: object, code: string) => {
    const dir = path.join(home, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(dir, "index.mjs"), code);
  };
  await plugin("fake-ui", { id: "test/fake-ui", provides: ["ui@1"] }, FAKE_UI);
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
  const shared: Shared = { selects: [], inputs: [], asked: [], inputsAsked: [], notes: [] };
  (globalThis as { __jadeModelTest?: Shared }).__jadeModelTest = shared;
  const reports: string[] = [];
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd,
    report: (m) => reports.push(m),
  });
  const printed: string[] = [];
  const ui = host.service<{ select: unknown; input: unknown; notify: unknown; interactive: boolean }>("ui@1")!;
  const ctx: CommandContext = { signal: new AbortController().signal, ui: ui as never, sessions: host.sessions, print: (t) => printed.push(t) };
  const model = host.service<Commands>("commands@1")!.get("model")!;
  const models = host.service<Models>("models@1")!;
  return { home, cwd, host, shared, reports, printed, ctx, command: model.command, models };
}

const readEnvFile = async (home: string) => readFile(path.join(home, ".env"), "utf8");

describe("/model", () => {
  test("switches to a saved model on another service, keeping both in models.json", async () => {
    const { home, host, printed, ctx, command, models } = await setup();
    try {
      expect(models.current()!.model).toBe("m1");
      await command.run("m2", ctx);

      const env = await readEnvFile(home);
      expect(env).toContain("OPENAI_COMPAT_BASE_URL=https://b.example/v1");
      expect(env).toContain("OPENAI_COMPAT_MODEL=m2");
      expect(env).toContain("JADE_MAX_TOKENS=64000");
      expect(printed.join("\n")).toContain("Model: m2 (openai-compat, https://b.example/v1)");
      expect(models.current()!.model).toBe("m2");

      // 两个服务都还在：切回去还是好的
      const saved = JSON.parse(await readFile(path.join(home, "models.json"), "utf8")) as { services: { env: Record<string, string>; models: { name: string; settings: Record<string, string> }[] }[] };
      expect(saved.services.map((s) => s.models.map((m) => m.name))).toEqual([["m2"], ["m1"]]);
      expect(saved.services[0]!.models[0]!.settings).toEqual({ JADE_MAX_TOKENS: "64000" });

      await command.run("m1", ctx);
      expect(models.current()!.model).toBe("m1");
      expect(await readEnvFile(home)).not.toContain("JADE_MAX_TOKENS");
    } finally {
      await host.close();
    }
  });

  test("a provider handed out before the switch uses the new service on its next request", async () => {
    const { host, ctx, command } = await setup();
    respond = () =>
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    const request: ModelRequest = { system: [], messages: [], tools: [] };
    try {
      // 会话创建时拿到的就是这个 provider（Runtime 创建时固定了它）
      const given = host.service<Provider>("provider@1")!;
      await command.run("m2", ctx);
      const res = await given.complete(request, { signal: new AbortController().signal });
      expect(res.content.length).toBeGreaterThan(0);
      expect(urls.at(-1)).toContain("b.example/v1");
      expect((bodies.at(-1) as { model?: string }).model).toBe("m2");
    } finally {
      await host.close();
    }
  });

  test("complete with a model name uses that saved model and its settings, or another model on the current service, without switching", async () => {
    const { host, models } = await setup();
    respond = () =>
      new Response([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`, "data: [DONE]\n\n"].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    const request: ModelRequest = { system: [], messages: [], tools: [] };
    const signal = new AbortController().signal;
    try {
      await models.complete(request, { signal, model: "m2" });
      expect(urls.at(-1)).toContain("b.example/v1");
      expect(bodies.at(-1)).toMatchObject({ model: "m2", max_tokens: 64000 });
      expect(models.current()!.model).toBe("m1");

      // 不指定时还是当前的模型
      await models.complete(request, { signal });
      expect(urls.at(-1)).toContain("a.example/v1");
      expect((bodies.at(-1) as { model?: string }).model).toBe("m1");

      // 没保存过的名字：当前服务上的模型，不带 m2 的设置
      await models.complete(request, { signal, model: "m3" });
      expect(urls.at(-1)).toContain("a.example/v1");
      expect((bodies.at(-1) as { model?: string }).model).toBe("m3");
      expect(bodies.at(-1)).not.toMatchObject({ max_tokens: 64000 });
      expect(models.current()!.model).toBe("m1");
    } finally {
      await host.close();
    }
  });

  test("saved lists the model names complete accepts", async () => {
    const { host, models } = await setup();
    try {
      expect(await models.saved!()).toEqual(["m1", "m2"]);
    } finally {
      await host.close();
    }
  });

  test("the menu changes the current model's settings", async () => {
    const { home, shared, host, ctx, command, models } = await setup();
    try {
      // 主菜单 → 设置 → 输出上限 → 64000
      shared.selects.push("settings", "max");
      shared.inputs.push("64000");
      await command.run("", ctx);
      expect(shared.asked).toEqual(["Switch model", "Settings for m1"]);
      expect(shared.inputsAsked).toEqual(["Output limit per reply in tokens, e.g. 32000, 64K (empty for the service default)"]);
      expect(await readEnvFile(home)).toContain("JADE_MAX_TOKENS=64000");
      expect(models.current()!.model).toBe("m1");
      // 记进这个模型自己的设置
      const saved = JSON.parse(await readFile(path.join(home, "models.json"), "utf8")) as { services: { models: { name: string; settings: Record<string, string> }[] }[] };
      expect(saved.services[0]!.models[0]).toEqual({ name: "m1", settings: { JADE_MAX_TOKENS: "64000" } });
    } finally {
      await host.close();
    }
  });

  test("adds a model on another provider and makes it current", async () => {
    const { home, shared, host, ctx, command, models } = await setup();
    try {
      // 主菜单 → 加一个模型 → 另一个服务 → Anthropic → 密钥 → 模型名
      shared.selects.push("add", "provider", "anthropic");
      shared.inputs.push("sk-ant-test", "claude-sonnet-4");
      await command.run("", ctx);
      expect(shared.inputsAsked).toEqual(["API key", "Model name"]);
      const env = await readEnvFile(home);
      expect(env).toContain("JADE_PROVIDER=anthropic");
      expect(env).toContain("ANTHROPIC_MODEL=claude-sonnet-4");
      expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-test");
      expect(models.current()).toMatchObject({ kind: "anthropic", model: "claude-sonnet-4" });
      const saved = JSON.parse(await readFile(path.join(home, "models.json"), "utf8")) as { services: { models: { name: string }[] }[] };
      expect(saved.services.map((s) => s.models[0]!.name)).toEqual(["claude-sonnet-4", "m1", "m2"]);
    } finally {
      await host.close();
    }
  });

  test("a saved model whose settings cannot build a provider is reported, and the current one keeps working", async () => {
    const { home, host, printed, ctx, command, models } = await setup();
    try {
      // models.json 里的这一条设置写错了（手改过，或者旧版本写的）
      const file = path.join(home, "models.json");
      const saved = JSON.parse(await readFile(file, "utf8")) as { services: unknown[] };
      saved.services.push({
        env: { JADE_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "https://c.example/v1", OPENAI_COMPAT_API_KEY: "kc" },
        models: [{ name: "m3", settings: { JADE_MAX_TOKENS: "lots" } }],
      });
      await writeFile(file, JSON.stringify(saved));

      await command.run("m3", ctx);
      expect(printed.join("\n")).toContain("the configuration is incomplete");
      expect(printed.join("\n")).toContain("JADE_MAX_TOKENS must be");
      // 旧的配置继续用：状态栏和请求都还是 m1
      expect(models.current()!.model).toBe("m1");
      respond = () =>
        new Response([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`, "data: [DONE]\n\n"].join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      await models.complete({ system: [], messages: [], tools: [] }, { signal: new AbortController().signal });
      expect(urls.at(-1)).toContain("a.example/v1");
      expect((bodies.at(-1) as { model?: string }).model).toBe("m1");
    } finally {
      await host.close();
    }
  });

  test("a configuration that cannot build a provider is not left in .env for the next launch", async () => {
    const { home, host, ctx, command } = await setup();
    try {
      const file = path.join(home, "models.json");
      const saved = JSON.parse(await readFile(file, "utf8")) as { services: unknown[] };
      saved.services.push({
        env: { JADE_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "https://c.example/v1", OPENAI_COMPAT_API_KEY: "kc" },
        models: [{ name: "m3", settings: { JADE_MAX_TOKENS: "lots" } }],
      });
      await writeFile(file, JSON.stringify(saved));
      await command.run("m3", ctx);
      expect(await readEnvFile(home)).toBe(ENV_A);
    } finally {
      await host.close();
    }
  });

  test("with no model configured, /model starts by choosing a service", async () => {
    const { host, shared, ctx, command } = await setup("");
    try {
      await command.run("", ctx);
      expect(shared.asked[0]).toBe("Which service should jade use?");
    } finally {
      await host.close();
    }
  });
});

describe(".env values", () => {
  test("quotes and backslashes survive a write and a read", async () => {
    const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-model-")));
    tmp.push(home);
    const file = path.join(home, ".env");
    const values = { A: '{"enable_thinking": true}', B: '{"stop": ["\\n"]}', C: "C:\\new dir", D: "two\nlines" };
    await updateEnvFile(file, values, {});
    expect(parseEnv(await readFile(file, "utf8"))).toEqual(values);
  });
});

describe("retries", () => {
  test("a retried model request is written to the session log as a plugin event, not into the context", async () => {
    const { host } = await setup();
    const ok = () =>
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    let calls = 0;
    respond = (url) => (url.endsWith("/chat/completions") && ++calls === 1 ? new Response("busy", { status: 503 }) : ok());
    try {
      const s = await host.sessions.open();
      await s.send({ kind: "message", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }] });
      const events = await s.history();
      const retried = events.filter((e) => e.type === "jade/models/retried");
      expect(retried).toHaveLength(1);
      const [record] = (retried[0]!.data as { retries: { attempt: number; status?: number; error: string }[] }).retries;
      expect(record).toMatchObject({ attempt: 1, status: 503 });
      expect(record!.error).toContain("503");
      // 记在回复之后；回复照常进上下文，重试记录不进
      const types = events.map((e) => e.type);
      expect(types.indexOf("jade/models/retried")).toBeGreaterThan(types.indexOf("model.responded"));
      expect(JSON.stringify(s.state.messages)).not.toContain("503");
    } finally {
      await host.close();
    }
  }, 10_000);
});
