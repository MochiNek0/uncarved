// jade/hooks：配置里的 shell 命令在工具调用前后、一轮结束时运行。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseHooks } from "../plugins/hooks/index.ts";
import { cleanup, say, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);

describe("jade/hooks", () => {
  test("parseHooks keeps the valid entries and names the bad ones", () => {
    const { hooks, problems } = parseHooks([
      { on: "before", tool: "bash", command: "true" },
      { on: "after", tool: "*", command: "true", timeoutSeconds: 5 },
      { on: "later", command: "true" },
      { on: "turn" },
    ]);
    expect(hooks).toEqual([
      { on: "before", tool: "bash", command: "true", timeoutMs: 60_000 },
      { on: "after", command: "true", timeoutMs: 5000 },
    ]);
    expect(problems).toEqual(['hooks[2]: "on" must be "before", "after" or "turn"', 'hooks[3]: "command" must be a shell command']);
    expect(parseHooks(undefined)).toEqual({ hooks: [], problems: [] });
  });

  test("a failing before-hook denies the call with its output; after- and turn-hooks run with the call in the environment", async () => {
    const hooks = [
      // 只拦写 secret.txt 的调用
      { on: "before", tool: "write_file", command: 'case "$JADE_TOOL_PATH" in *secret*) echo "secrets are off limits"; exit 1;; esac' },
      { on: "after", tool: "write_file", command: 'echo "$JADE_TOOL" >> after.log; cat "$JADE_TOOL_INPUT" >> after.log' },
      { on: "after", tool: "write_file", command: "echo formatter broke; exit 2" },
      { on: "turn", command: "echo done > turn.log" },
    ];
    const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/hooks": { hooks } } });
    shared.script.push(
      use("u1", "write_file", { path: "secret.txt", content: "x" }),
      use("u2", "write_file", { path: "ok.txt", content: "fine" }),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "write them");
    // before：拒绝，理由是命令的输出
    expect(existsSync(path.join(cwd, "secret.txt"))).toBe(false);
    expect(textOf(shared.requests[1]!.messages.at(-1)!.content)).toContain("refused this write_file call:\nsecrets are off limits");
    // after：拿到工具名和参数
    expect(await readFile(path.join(cwd, "ok.txt"), "utf8")).toBe("fine");
    const log = await readFile(path.join(cwd, "after.log"), "utf8");
    expect(log).toStartWith("write_file\n");
    expect(JSON.parse(log.slice("write_file\n".length))).toEqual({ path: path.join(cwd, "ok.txt"), content: "fine" });
    // after 失败：告诉用户，也留给模型
    expect(shared.notes.join("\n")).toContain("hook after write_file (echo formatter broke; exit 2) failed:\nformatter broke");
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("[Note from jade] The user's hook after write_file");
    // turn：一轮结束后运行（不等它）
    for (let i = 0; i < 50 && !existsSync(path.join(cwd, "turn.log")); i++) await Bun.sleep(100);
    expect((await readFile(path.join(cwd, "turn.log"), "utf8")).trim()).toBe("done");
  }, 30_000);
});
