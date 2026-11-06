// jade/suggest：一轮正常结束后预测用户的下一条消息，经 ctx.input.hint 显示。默认关着；model 选 /model 保存过的模型。

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "uncarved";
import type { UI } from "../src/api.ts";
import type { PluginHost } from "../src/index.ts";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import { frame, SYSTEM, tidy, transcriptOf } from "../plugins/suggest/index.ts";
import { cleanup, MODEL, say, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);

const suggestCommand = (host: PluginHost) => host.service<Commands>("commands@1")!.get("suggest")!.command;
const ctxFor = (host: PluginHost): CommandContext => ({ signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} });

/** 预测在后台进行：等到条件成立 */
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}

describe("jade/suggest", () => {
  test("is off by default", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(say("done"));
    const s = await host.sessions.open();
    await send(s, "fix it");
    await new Promise((r) => setTimeout(r, 50));
    expect(shared.requests).toHaveLength(1);
    expect(shared.hints.filter(Boolean)).toEqual([]);
  });

  test("after a turn, predicts the next message with the session's model and shows it as a hint", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true } } });
    // 一轮里调了一次工具：工具结果不算用户说的，工具调用只留名字，助手的两步并成一条
    shared.script.push(use("t1", "todo_write", { todos: [] }), say("Fixed. Should I add a test?"), say('User: "yes, add one"\nextra line'));
    const s = await host.sessions.open();
    await send(s, "fix the bug");
    await until(() => shared.hints.includes("yes, add one"));

    const predict = shared.requests.at(-1)!;
    expect(predict.system.map((x) => x.text)).toEqual([SYSTEM]);
    expect(predict.tools).toEqual([]);
    expect(textOf(predict.messages[0]!.content)).toBe(
      [
        "Recent conversation, oldest first:",
        "",
        "<user>\nfix the bug\n</user>",
        "",
        "<assistant>\n[called tool: todo_write]\nFixed. Should I add a test?\n</assistant>",
        "",
        "Predict the user's next message.",
      ].join("\n"),
    );
    expect(shared.modelOptions).toEqual([undefined]);

    // 下一轮开始时去掉上一条建议（这一轮之后的预测因脚本用完而失败，不显示）
    shared.script.push(say("ok"));
    await send(s, "something else");
    await new Promise((r) => setTimeout(r, 50));
    expect(shared.hints.slice(-2)).toEqual(["yes, add one", undefined]);
  });

  test("uses the configured model", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true, model: "small" } } });
    shared.script.push(say("done"), say("thanks"));
    const s = await host.sessions.open();
    await send(s, "fix it");
    await until(() => shared.hints.includes("thanks"));
    expect(shared.modelOptions).toEqual(["small"]);
  });

  test("shows nothing when the model answers NONE", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true } } });
    shared.script.push(say("done"), say("NONE"));
    const s = await host.sessions.open();
    await send(s, "fix it");
    await until(() => shared.modelOptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(shared.hints.filter(Boolean)).toEqual([]);
  });

  test("/suggest on turns it on right away and is remembered over config.json on the next launch", async () => {
    const first = await scriptedHost();
    const run = (args: string) => suggestCommand(first.host).run(args, ctxFor(first.host));
    expect(await run("")).toContain("suggestions are off, predicted by the session's model");
    expect(await run("on")).toBe("suggestions are on, predicted by the session's model.");
    first.shared.script.push(say("done"), say("thanks"));
    const s = await first.host.sessions.open();
    await first.send(s, "fix it");
    await until(() => first.shared.hints.includes("thanks"));
    expect(JSON.parse(await readFile(path.join(first.home, "state", "suggest.json"), "utf8"))).toEqual({ enabled: true, model: "" });

    // 下次启动时 state/suggest.json 盖过 config.json
    const next = await scriptedHost({ config: { "jade/suggest": { enabled: false, model: "big" } }, files: { "state/suggest.json": JSON.stringify({ enabled: true, model: "small" }) } });
    expect(await suggestCommand(next.host).run("", ctxFor(next.host))).toContain("suggestions are on, predicted by the saved model small");
  });

  test("/suggest model checks the name against the saved models, and the picker can go back to the session's model", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true } } });
    shared.saved = ["small", "big"];
    const run = (args: string) => suggestCommand(host).run(args, ctxFor(host));
    expect(await run("model tiny")).toBe("tiny is not a model saved by /model. Saved: small, big.");
    expect(await run("model small")).toBe("suggestions are on, predicted by the saved model small.");
    shared.script.push(say("done"), say("thanks"));
    const s = await host.sessions.open();
    await send(s, "fix it");
    await until(() => shared.hints.includes("thanks"));
    expect(shared.modelOptions).toEqual(["small"]);

    // 选第一项：会话的模型
    expect(await run("model")).toBe("suggestions are on, predicted by the session's model.");
    expect(shared.asked).toEqual(["Which model predicts your next message?"]);
  });

  test("/suggest off removes the suggestion on screen and stops predicting", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true } } });
    shared.script.push(say("done"), say("thanks"));
    const s = await host.sessions.open();
    await send(s, "fix it");
    await until(() => shared.hints.includes("thanks"));
    await suggestCommand(host).run("off", ctxFor(host));
    expect(shared.hints.at(-1)).toBeUndefined();

    shared.script.push(say("ok"));
    await send(s, "again");
    await new Promise((r) => setTimeout(r, 50));
    expect(shared.modelOptions).toHaveLength(1);
  });

  test("does not predict after a failed turn", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/suggest": { enabled: true } } });
    shared.script.push({ error: "boom" });
    const s = await host.sessions.open();
    await send(s, "fix it");
    await new Promise((r) => setTimeout(r, 50));
    expect(shared.modelOptions).toEqual([]);
    expect(shared.hints.filter(Boolean)).toEqual([]);
  });
});

describe("jade/suggest helpers", () => {
  const text = (t: string, by: "user" | "plugin" = "user") => ({ kind: "text" as const, text: t, origin: by === "user" ? { by } : { by, id: "x/y" }, trust: "trusted" as const });

  test("the transcript keeps only what the user typed and merges consecutive turns of one side", () => {
    const messages: Message[] = [
      { role: "user", content: [text("hi"), text("[Note from jade] continue", "plugin")] },
      { role: "assistant", content: [{ kind: "tool_use", id: "1", name: "read_file", input: {}, origin: MODEL, trust: "trusted" }] },
      { role: "user", content: [{ kind: "tool_result", toolUseId: "1", content: [text("file body")], isError: false, origin: { by: "tool", name: "read_file" }, trust: "untrusted" }] },
      { role: "assistant", content: [{ ...text("done"), origin: MODEL }] },
    ];
    expect(transcriptOf(messages)).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "[called tool: read_file]\ndone" },
    ]);
  });

  test("frame keeps the newest entries within the budget and clips long ones at both ends", () => {
    const long = `${"a".repeat(3000)}${"z".repeat(3000)}`;
    const framed = frame([{ role: "user", text: "old" }, { role: "assistant", text: long }], 1000);
    // 最后一条总是放进去（截掉中间），放不下的旧的不要
    expect(framed).not.toContain("<user>");
    expect(framed).toContain("aaa\n…\nzzz");
  });

  test("tidy keeps the first line without prefix or quotes, and drops NONE", () => {
    expect(tidy('  "run the tests"  \nmore')).toBe("run the tests");
    expect(tidy("用户：「好的」")).toBe("好的");
    expect(tidy("NONE")).toBeUndefined();
    expect(tidy("none.")).toBeUndefined();
    expect(tidy("   ")).toBeUndefined();
    expect(tidy("x".repeat(400))).toBe(`${"x".repeat(299)}…`);
  });
});
