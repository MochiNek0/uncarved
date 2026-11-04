// 规则表（docs/plugins.md）里由宿主决定的一行：斜杠命令同名时谁生效。
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, type Provider } from "uncarved";
import { pluginMenu } from "../src/commands.ts";
import { createJade, type Jade, type LoadedPlugin } from "../src/index.ts";


describe("slash command names", () => {
  test("host commands, then custom commands and skills, win over third-party plugin commands", () => {
    const run = () => undefined;
    const commands: Jade["commands"] = new Map([
      ["undo", { plugin: "jade/undo", command: { name: "undo", description: "Undo", run }, builtin: true }],
      ["help", { plugin: "x/a", command: { name: "help", run }, builtin: false }],
      ["review", { plugin: "x/a", command: { name: "review", run }, builtin: false }],
      ["lint", { plugin: "x/b", command: { name: "lint", run }, builtin: false }],
      ["deploy", { plugin: "x/b", command: { name: "deploy", description: "Ship it", run }, builtin: false }],
    ]);
    const menu = pluginMenu(commands, { host: new Set(["help"]), custom: new Set(["review"]), skill: new Set(["lint"]) });
    expect(menu.builtin).toEqual([{ name: "undo", args: undefined, about: "Undo" }]);
    expect(menu.plugins).toEqual([{ name: "deploy", args: undefined, about: "Ship it (plugin x/b)" }]);
    expect(menu.warnings).toEqual([
      "command /help of plugin x/a is ignored: a built-in command has that name",
      "command /review of plugin x/a is ignored: a custom command has that name",
      "command /lint of plugin x/b is ignored: a skill has that name",
    ]);
  });

  test("a built-in plugin's command wins over a third-party one, unless the third-party plugin replaces it", async () => {
    const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-rules-")));
    const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-rules-home-")));
    const provider: Provider = { id: "none", complete: () => Promise.reject(new Error("unused")) };
    const fake = (name: string, replaces?: string[]): LoadedPlugin => ({
      name,
      id: `x/${name}`,
      dir: path.join(home, "plugins", name),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", replaces, json: { id: `x/${name}`, replaces }, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => ({ id: `x/${name}`, version: "1.0.0", kernel: "^0.1", commands: [{ name: "undo", run: () => "mine" }] }) as never,
    });
    const make = (p: LoadedPlugin) => createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {}, extensions: [p] });

    const plain = await make(fake("plain"));
    expect(plain.commands.get("undo")).toMatchObject({ plugin: "jade/undo", builtin: true });
    expect(plain.warnings).toContain("plugin x/plain: command /undo is ignored: plugin jade/undo already provides it");
    plain.shutdown();

    const replacing = await make(fake("better-undo", ["jade/undo"]));
    expect(replacing.commands.get("undo")).toMatchObject({ plugin: "x/better-undo", builtin: false });
    expect(replacing.builtins.find((b) => b.id === "jade/undo")).toMatchObject({ state: "replaced", by: "x/better-undo" });
    replacing.shutdown();
  });
});
