import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseManifest, pluginConfig, readConfigFile, type PluginLayer, type PluginSource } from "../src/index.ts";

const source = (layer: PluginLayer, config?: unknown): PluginSource => ({
  manifest: parseManifest({ id: "x/p", version: "1.0.0", api: "^1", entry: "i.mjs", ...(config ? { config } : {}) }),
  dir: "/p",
  layer,
});

describe("plugin config", () => {
  test("defaults < user < project, merged key by key", () => {
    const s = source("bundled", { a: { default: 1 }, b: { default: 2 }, c: { default: 3, project: true } });
    const { config, ignored } = pluginConfig(s, { "x/p": { b: 20, extra: true } }, { "x/p": { c: 30, a: 10 } });
    expect(config).toEqual({ a: 1, b: 20, c: 30, extra: true });
    expect(ignored).toEqual(["a"]);
  });

  test("a project plugin can be configured from the project", () => {
    const { config, ignored } = pluginConfig(source("project"), {}, { "x/p": { anything: "yes" } });
    expect(config).toEqual({ anything: "yes" });
    expect(ignored).toEqual([]);
  });

  test("defaults are copied, not shared", () => {
    const s = source("bundled", { list: { default: [1] } });
    const first = pluginConfig(s, {}, {}).config.list as number[];
    first.push(2);
    expect(pluginConfig(s, {}, {}).config.list).toEqual([1]);
  });

  test("a malformed manifest config is rejected", () => {
    expect(() => source("bundled", { a: 1 })).toThrow('"config.a"');
    expect(() => source("bundled", { a: { project: "yes" } })).toThrow('"config.a"');
  });

  test("a broken config file is ignored with a reason; a missing one is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jade-config-"));
    try {
      expect(await readConfigFile(path.join(dir, "none.json"))).toEqual({ config: {} });
      await writeFile(path.join(dir, "bad.json"), "{");
      expect((await readConfigFile(path.join(dir, "bad.json"))).error).toContain("ignored");
      await writeFile(path.join(dir, "mixed.json"), JSON.stringify({ "x/p": { a: 1 }, "y/q": 5 }));
      const mixed = await readConfigFile(path.join(dir, "mixed.json"));
      expect(mixed.config).toEqual({ "x/p": { a: 1 } });
      expect(mixed.error).toContain("y/q");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
