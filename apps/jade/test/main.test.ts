// jade 命令行入口：把 jade plugins 的子命令错写到顶层时（jade add x、jade remove plugins x），
// 不能当成第一条消息发给模型。

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/main.ts";

let errors: string[] = [];
const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
// 万一走到了启动宿主那一步，也不碰真的 ~/.jade
let home = "";
const savedHome = process.env.JADE_HOME;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "jade-main-"));
  process.env.JADE_HOME = home;
});
afterEach(async () => {
  errors = [];
  if (savedHome === undefined) delete process.env.JADE_HOME;
  else process.env.JADE_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe("a plugins subcommand written at the top level", () => {
  test("jade add does not start a session, and says what to run instead", async () => {
    expect(await main(["add", "./hello"])).toBe(2);
    expect(errors.join("\n")).toContain('did you mean "jade plugins add ./hello"?');
  });

  test("jade update is jade's own upgrade command, not a misspelled plugins update", async () => {
    // 不联网：未知选项在查 npm 之前就被拒绝
    expect(await main(["update", "--bogus"])).toBe(2);
    expect(errors.join("\n")).toContain("jade update: unknown option --bogus");
    expect(errors.join("\n")).not.toContain("did you mean");
  });

  test("jade upgrade points to jade update", async () => {
    expect(await main(["upgrade"])).toBe(2);
    expect(errors.join("\n")).toContain('did you mean "jade update"?');
  });

  test("the word plugins in the wrong place is moved to the front", async () => {
    expect(await main(["remove", "plugins", "suggest"])).toBe(2);
    expect(errors.join("\n")).toContain('did you mean "jade plugins remove suggest"?');
  });

  test("a quoted prompt that starts with the same word is one argument and is not mistaken for a command", async () => {
    // 不真的启动：只确认没有走到"不是命令"的提示。用 --help 让前端打印帮助后返回
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await main(["add a test for foo", "--help"]);
    } finally {
      out.mockRestore();
    }
    expect(errors.join("\n")).not.toContain("did you mean");
  });
});

process.on("exit", () => spy.mockRestore());

test("a broken plugins.json is reported with its path instead of crashing", async () => {
  await writeFile(path.join(home, "plugins.json"), '{"disabled": [],}');
  expect(await main(["--safe", "-p", "hi"])).toBe(1);
  expect(errors.join("\n")).toContain("plugins.json");
});
