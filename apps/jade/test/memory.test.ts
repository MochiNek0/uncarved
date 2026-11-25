// jade/memory：记忆文件、memory 工具、系统提示词里的记忆、/memory。从旧 jade 的 test/jade.test.ts（memory）移植。

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { Memory, memoryTool, projectRoot } from "../plugins/memory/memory.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";
import { plain as plainText } from "../plugins/tui/screen.ts";
import type { Text } from "@uncarved/jade-api";
/** 插件给的是带样式的文字（Text）：只比文字 */
const shown = (r: unknown) => plainText(r as Text);

afterEach(cleanup);

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

async function dirs() {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-mem-")));
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-mem-cwd-")));
  tmp.push(home, cwd);
  return { home, cwd };
}

describe("jade/memory", () => {
  test("entries are added once, removed by exact text or a unique part, and kept per project", async () => {
    const { home, cwd } = await dirs();
    const m = new Memory(home, cwd, () => "2026-11-25");
    expect(await m.add("user", "Reply  in\nChinese")).toBe(true);
    expect(await m.add("user", "Reply in Chinese")).toBe(false);
    await m.add("user", "Prefer bun over npm");
    expect(await m.list("user")).toEqual(["Reply in Chinese", "Prefer bun over npm"]);
    expect(await readFile(m.files.user, "utf8")).toBe("- [2026-11-25] Reply in Chinese\n- [2026-11-25] Prefer bun over npm\n");
    await expect(m.remove("user", "e")).rejects.toThrow("2 user memories contain");
    expect(await m.remove("user", "bun")).toBe("Prefer bun over npm");
    expect(await m.remove("user", "nothing")).toBeUndefined();

    await m.add("project", "Tests run with bun test");
    expect(await new Memory(home, path.join(cwd, "other")).list("project")).toEqual([]);
    expect(await new Memory(home, cwd).list("project")).toEqual(["Tests run with bun test"]);
  });

  test("entries keep their dates; undated lines written by hand still count, and the prompt shows the dates", async () => {
    const { home, cwd } = await dirs();
    let day = "2026-11-01";
    const m = new Memory(home, cwd, () => day);
    await mkdir(path.dirname(m.files.user), { recursive: true });
    await writeFile(m.files.user, "# notes\n- Written by hand\n* [2026-10-01] Old entry\n");
    expect(await m.entries("user")).toEqual([{ text: "Written by hand" }, { text: "Old entry", date: "2026-10-01" }]);
    await m.add("user", "New entry");
    // 别的条目的日期原样保留
    expect(await readFile(m.files.user, "utf8")).toBe("- Written by hand\n- [2026-10-01] Old entry\n- [2026-11-01] New entry\n");

    // replace 原地换掉，日期更新
    day = "2026-11-25";
    expect(await m.replace("user", "Old", "Updated entry")).toBe("Old entry");
    expect(await m.entries("user")).toEqual([{ text: "Written by hand" }, { text: "Updated entry", date: "2026-11-25" }, { text: "New entry", date: "2026-11-01" }]);
    expect(await m.replace("user", "missing", "x")).toBeUndefined();
    await expect(m.replace("user", "entry", "x")).rejects.toThrow("2 user memories contain");
    await expect(m.replace("user", "Updated", "New entry")).rejects.toThrow("already has");

    expect(await m.prompt()).toContain("- Written by hand\n- [2026-11-25] Updated entry\n- [2026-11-01] New entry");
  });

  test("each scope has a character budget; merging with replace still works when the file is over it", async () => {
    const { home, cwd } = await dirs();
    const m = new Memory(home, cwd);
    for (let i = 0; i < 8; i++) await m.add("project", `${i}`.padEnd(490, "x"));
    await expect(m.add("project", "y".repeat(100))).rejects.toThrow("over its limit of 4000");
    expect(await m.add("user", "y".repeat(100))).toBe(true);

    // 用户手改得超出上限：加不进去，但缩短、合并可以
    await writeFile(m.files.project, Array.from({ length: 10 }, (_, i) => `- ${i}`.padEnd(490, "x")).join("\n"));
    await expect(m.add("project", "z")).rejects.toThrow("over its limit");
    await expect(m.replace("project", "1xxx", "1".padEnd(495, "x"))).rejects.toThrow("over its limit");
    expect(await m.replace("project", "1xxx", "merged 0 and 1")).toBeDefined();
    expect(await m.remove("project", "0xxx")).toBeDefined();
  });

  test("the memory tool replaces an entry and needs old for it", async () => {
    const { home, cwd } = await dirs();
    const m = new Memory(home, cwd);
    const tool = memoryTool(m);
    const run = (input: object) => tool.execute(input, {} as never) as Promise<{ content: string; isError?: boolean }>;
    await m.add("project", "Tests run with npm test");
    expect(await run({ action: "replace", scope: "project", old: "npm test", text: "Tests run with bun test" })).toEqual({
      content: "Replaced in project memory: Tests run with npm test",
    });
    expect(await m.list("project")).toEqual(["Tests run with bun test"]);
    expect((await run({ action: "replace", scope: "project", text: "x" })).isError).toBe(true);
    expect((await run({ action: "replace", scope: "project", old: "nothing", text: "x" })).isError).toBe(true);
  });

  test("the project is the enclosing git repository", async () => {
    const { cwd } = await dirs();
    await mkdir(path.join(cwd, ".git"));
    await mkdir(path.join(cwd, "a", "b"), { recursive: true });
    expect(projectRoot(path.join(cwd, "a", "b"))).toBe(cwd);
  });

  test("memories reach the system prompt of the next session; the model saves them with the memory tool", async () => {
    const { home, cwd, host, shared, send } = await scriptedHost();
    shared.script.push(use("u1", "memory", { action: "add", scope: "user", text: "The user likes short answers" }), say("noted"));
    const s = await host.sessions.open();
    await send(s, "remember that I like short answers");
    expect(shared.requests[0]!.system.map((x) => x.text).join("\n")).not.toContain("# Memory");
    expect(await new Memory(home, cwd).list("user")).toEqual(["The user likes short answers"]);

    // 新会话的系统提示词里有它
    const next = await host.sessions.open();
    shared.script.push(say("ok"));
    await send(next, "hi");
    const memory = shared.requests[2]!.system.find((x) => x.text.startsWith("# Memory"));
    expect(memory?.text).toMatch(/- \[\d{4}-\d{2}-\d{2}\] The user likes short answers/);
    expect(memory?.trust).toBe("trusted");
  });

  test("/memory removes an entry and tells the model with the next request", async () => {
    const { home, cwd, host, shared, send } = await scriptedHost();
    await new Memory(home, cwd, () => "2026-11-25").add("project", "Use tabs");
    const s = await host.sessions.open();
    const memory = host.service<Commands>("commands@1")!.get("memory")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    // 列出来的时候带着日期
    expect(await memory.run("", { ...c, ui: { ...c.ui, interactive: false } })).toBe("project, 2026-11-25: Use tabs");
    // 第一项是"Add a memory…"，第二项是这条记忆；然后确认
    shared.answers.push("0", "yes");
    expect(shown(await memory.run("", c))).toContain("Removed from project memory: Use tabs");
    expect(await new Memory(home, cwd).list("project")).toEqual([]);

    shared.script.push(say("ok"), say("ok again"));
    await send(s, "hi");
    const last = shared.requests[0]!.messages.at(-1)!;
    expect(textOf(last.content)).toContain("[Note from jade] The user removed this project memory, so stop following it: Use tabs");
    // 之后的请求里说明还在原处
    await send(s, "and?");
    expect(textOf(shared.requests[1]!.messages[0]!.content)).toContain("stop following it");

    // 带参数：直接记住
    shared.answers.push("user");
    expect(shown(await memory.run("Answer briefly", c))).toContain("Saved to user memory");
    expect(await new Memory(home, cwd).list("user")).toEqual(["Answer briefly"]);
  });
});
