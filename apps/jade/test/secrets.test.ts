// ctx.secrets（设计第 8 节）：按插件 id 隔离的密钥存储、作用域检查、进程外插件的读写。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StaleContext, type Secrets } from "../src/index.ts";
import { SecretsStore, scopedSecrets } from "../src/secrets.ts";
import { world } from "./helpers.ts";

const g = globalThis as {
  __secretProcess?: string;
  __secretOther?: string;
  __secretSession?: string;
  __secretCtx?: { secrets: Secrets };
};

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
  delete g.__secretProcess;
  delete g.__secretOther;
  delete g.__secretSession;
  delete g.__secretCtx;
});

async function tempHome(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "jade-secrets-"));
  tmp.push(d);
  return d;
}

const secretFile = (home: string, plugin: string) => path.join(home, "state", "secrets", `${encodeURIComponent(plugin)}.json`);

describe("the secrets store", () => {
  test("keeps each plugin's secrets in its own file and persists them", async () => {
    const home = await tempHome();
    const store = new SecretsStore(home);
    const a = store.for("test/a");
    const b = store.for("test/b");

    await a.set("TOKEN", "s3cret");
    expect(await a.get("TOKEN")).toBe("s3cret");
    expect(await b.get("TOKEN")).toBeUndefined();

    const file = secretFile(home, "test/a");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ TOKEN: "s3cret" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // 新实例（例如下一次启动）读得到
    expect(await new SecretsStore(home).for("test/a").get("TOKEN")).toBe("s3cret");
  });

  test("undefined deletes a key; odd key names stay ordinary keys", async () => {
    const home = await tempHome();
    const a = new SecretsStore(home).for("test/a");
    await a.set("TOKEN", "x");
    await a.set("TOKEN", undefined);
    expect(await a.get("TOKEN")).toBeUndefined();

    await a.set("__proto__", "value");
    expect(await a.get("__proto__")).toBe("value");
  });

  test("rejects empty and oversized keys, and values that are not strings", async () => {
    const a = new SecretsStore(await tempHome()).for("test/a");
    await expect(a.get("")).rejects.toThrow("non-empty");
    await expect(a.set("x".repeat(1000), "v")).rejects.toThrow("longer than");
    await expect(a.set("x", 123 as unknown as string)).rejects.toThrow("must be a string");
  });

  test("a corrupt file is reported, not silently treated as empty", async () => {
    const home = await tempHome();
    const file = secretFile(home, "test/bad");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json");
    await expect(new SecretsStore(home).for("test/bad").get("TOKEN")).rejects.toThrow("secrets for test/bad");
  });

  test("a closed scope makes the old ctx.secrets stale", async () => {
    const base = new SecretsStore(await tempHome()).for("test/closed");
    let closed = false;
    const s = scopedSecrets(base, () => closed, "test/closed");
    await s.set("TOKEN", "x");
    closed = true;
    await expect(s.get("TOKEN")).rejects.toBeInstanceOf(StaleContext);
    await expect(s.set("TOKEN", "y")).rejects.toBeInstanceOf(StaleContext);
  });
});

const PROCESS = `export default { async process(ctx) {
  await ctx.secrets.set("TOKEN", "from-process");
  globalThis.__secretProcess = await ctx.secrets.get("TOKEN");
  globalThis.__secretCtx = ctx;
} };`;

const OTHER = `export default { async process(ctx) {
  globalThis.__secretOther = await ctx.secrets.get("TOKEN");
} };`;

const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", { id: "scripted", async complete() { throw new Error("not used"); } });
} };`;

const WITH_SESSION = `export default {
  async process(ctx) { await ctx.secrets.set("TOKEN", "from-process"); },
  async session(ctx) {
    globalThis.__secretSession = await ctx.secrets.get("TOKEN");
    await ctx.secrets.set("SESSION", "yes");
    globalThis.__secretCtx = ctx;
  },
};`;

describe("ctx.secrets in plugins", () => {
  test("the process context reads and writes the plugin's own file, and another plugin sees nothing", async () => {
    const w = await world();
    await w.plugin("user", { id: "test/process" }, PROCESS);
    await w.plugin("user", { id: "test/other" }, OTHER);
    const host = await w.start();
    try {
      expect(g.__secretProcess).toBe("from-process");
      expect(g.__secretOther).toBeUndefined();
      expect(await host.secrets("test/process").get("TOKEN")).toBe("from-process");
      expect(await host.secrets("test/other").get("TOKEN")).toBeUndefined();
      expect(JSON.parse(await readFile(secretFile(w.home, "test/process"), "utf8"))).toEqual({ TOKEN: "from-process" });
    } finally {
      await host.close();
    }
  });

  test("the session context shares the process context's secrets and goes stale when the session is left", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
    await w.plugin("user", { id: "test/session" }, WITH_SESSION);
    const host = await w.start();
    try {
      await host.sessions.open();
      expect(g.__secretSession).toBe("from-process");
      expect(await host.secrets("test/session").get("SESSION")).toBe("yes");

      const old = g.__secretCtx!;
      await host.sessions.open();
      await expect(old.secrets.get("TOKEN")).rejects.toBeInstanceOf(StaleContext);
    } finally {
      await host.close();
    }
  });

  test("closing the host makes the process context's secrets stale", async () => {
    const w = await world();
    await w.plugin("user", { id: "test/process" }, PROCESS);
    const host = await w.start();
    const ctx = g.__secretCtx!;
    await host.close();
    await expect(ctx.secrets.get("TOKEN")).rejects.toBeInstanceOf(StaleContext);
  });
});
