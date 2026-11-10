// jade/memory：记忆文件、memory 工具、系统提示词里的记忆、/memory。从旧 jade 的 test/jade.test.ts（memory）移植。

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { Memory, projectRoot } from "../plugins/memory/memory.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

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
    const m = new Memory(home, cwd);
    expect(await m.add("user", "Reply  in\nChinese")).toBe(true);
    expect(await m.add("user", "Reply in Chinese")).toBe(false);
    await m.add("user", "Prefer bun over npm");
    expect(await m.list("user")).toEqual(["Reply in Chinese", "Prefer bun over npm"]);
    expect(await readFile(m.files.user, "utf8")).toBe("- Reply in Chinese\n- Prefer bun over npm\n");
    await expect(m.remove("user", "e")).rejects.toThrow("2 user memories contain");
    expect(await m.remove("user", "bun")).toBe("Prefer bun over npm");
    expect(await m.remove("user", "nothing")).toBeUndefined();

    await m.add("project", "Tests run with bun test");
    expect(await new Memory(home, path.join(cwd, "other")).list("project")).toEqual([]);
    expect(await new Memory(home, cwd).list("project")).toEqual(["Tests run with bun test"]);
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
    expect(memory?.text).toContain("- The user likes short answers");
    expect(memory?.trust).toBe("trusted");
  });

  test("/memory removes an entry and tells the model with the next request", async () => {
    const { home, cwd, host, shared, send } = await scriptedHost();
    await new Memory(home, cwd).add("project", "Use tabs");
    const s = await host.sessions.open();
    const memory = host.service<Commands>("commands@1")!.get("memory")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    // 第一项是"Add a memory…"，第二项是这条记忆；然后确认
    shared.answers.push("0", "yes");
    expect(await memory.run("", c)).toContain("Removed from project memory: Use tabs");
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
    expect(await memory.run("Answer briefly", c)).toContain("Saved to user memory");
    expect(await new Memory(home, cwd).list("user")).toEqual(["Answer briefly"]);
  });
});
