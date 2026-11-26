// auto 模式的审查（jade/approval）：规则判断不了、本来要问的调用先让模型审一次。
// 审查放行或拦下，不问用户；出错、看不懂、超时也拦下，告诉模型可以再试。模型和界面换成假的。

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseVerdict } from "../plugins/approval/review.ts";
import { scratchDir } from "../plugins/scratch/index.ts";
import { cleanup, say, scriptedHost, use } from "./scripted-ui.ts";

afterEach(cleanup);

const AUTO = { "jade/approval": { mode: "auto" } };

describe("parseVerdict", () => {
  test("takes the first usable JSON answer and clips the reason", () => {
    expect(parseVerdict('noise {"decision": "allow", "reason": "fine"} more')).toEqual({ decision: "allow", reason: "fine" });
    expect(parseVerdict('```json\n{"decision":"block"}\n```')).toEqual({ decision: "deny", reason: undefined });
    expect(parseVerdict('{"decision": "maybe"}')).toBeUndefined();
    expect(parseVerdict('{"decision": "ask"}')).toBeUndefined();
    expect(parseVerdict("I think it is fine")).toBeUndefined();
    expect(parseVerdict(`{"decision": "block", "reason": "${"x".repeat(400)}"}`)!.reason!.length).toBeLessThan(400);
  });
});

describe("auto-mode review", () => {
  test("allows a call the rules would ask about, without a dialog", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "allow", "reason": "writes one small file"}'),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "write it");

    // 第二次请求是审查：系统提示是审查的，用户最近的请求在里面
    const review = shared.requests[1]!;
    expect(review.system[0]!.text).toContain("You review actions");
    expect(review.messages[0]!.content[0]!.kind === "text" && (review.messages[0]!.content[0] as { text: string }).text).toContain("<user-requests>\nwrite it");
    // 没有弹对话框，工具照常执行
    expect(shared.asked).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("hi");
    expect(shared.requests[2]!.messages.at(-1)!.content[0]!.kind).toBe("tool_result");
  });

  test("the review is told about the session's scratch directory, which is writable like the working directory", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    shared.script.push(use("u1", "write_file", { path: path.join(home, "outside.txt"), content: "hi" }), say('{"decision": "allow"}'), say("done"));
    const s = await host.sessions.open();
    await send(s, "write it");
    const review = shared.requests[1]!.messages[0]!.content[0] as { text: string };
    expect(review.text).toContain(`Also writable like the working directory: ${realpathSync.native(scratchDir(s.id))}`);
  });

  test("blocks the call without a dialog when the review says block, telling the model to ask the user with ask_user", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "block", "reason": "it writes outside the working directory"}'),
      say("May I write outside.txt outside the working directory?"),
    );
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.asked).toEqual([]);
    expect(await readFile(outside, "utf8").catch(() => undefined)).toBeUndefined();
    const result = JSON.stringify(shared.requests[2]!.messages.at(-1)!.content);
    expect(result).toContain("it writes outside the working directory");
    expect(result).toContain("ask the user with ask_user");
  });

  test("the user allows a blocked call through ask_user: the review sees the answer and the retried call runs in the same turn", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "block", "reason": "outside the working directory"}'),
      use("q1", "ask_user", { questions: [{ question: "Write outside.txt outside the working directory?", options: [{ label: "Yes, allow it" }, { label: "No" }] }] }),
      use("u2", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "allow", "reason": "the user allowed it"}'),
      say("done"),
    );
    // ask_user 的对话框选第一个选项（"Yes, allow it"）
    const s = await host.sessions.open();
    await send(s, "write it");

    const review = (shared.requests[4]!.messages[0]!.content[0] as { text: string }).text;
    expect(review).toContain("The user answered the agent's question (ask_user):");
    expect(review).toContain("A: Yes, allow it");
    // 只有 ask_user 的问题，没有审批框
    expect(shared.asked).toEqual(["Write outside.txt outside the working directory?"]);
    expect(await readFile(outside, "utf8")).toBe("hi");
  });

  test("a sub-agent's review sees the user's requests from the main session and the task; when blocked, the sub-agent is told to report it", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const notes = path.join(home, "notes.txt");
    await writeFile(notes, "secret plans");
    shared.script.push(
      use("u1", "task", { description: "notes", prompt: "read the notes file and summarize it" }),
      // 子 Agent：读工作目录之外的文件，要审查
      use("c1", "read_file", { path: notes }),
      say('{"decision": "block", "reason": "outside the working directory"}'),
      say("report: the read was blocked"),
      // 主会话
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "summarize my notes in the home directory");

    const review = (shared.requests[2]!.messages[0]!.content[0] as { text: string }).text;
    expect(review).toContain("<user-requests>\nsummarize my notes in the home directory");
    expect(review).toContain("<task>\nread the notes file and summarize it");
    expect(shared.asked).toEqual([]);
    expect(JSON.stringify(shared.requests[3]!.messages.at(-1)!.content)).toContain("so the main agent can ask the user");
  });

  test("after three blocks in a row, auto mode asks the user this time, saying why", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    const block = say('{"decision": "block", "reason": "outside the working directory"}');
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "1" }),
      block,
      use("u2", "write_file", { path: outside, content: "2" }),
      block,
      use("u3", "write_file", { path: outside, content: "3" }),
      block,
      say("done"),
    );
    shared.answers.push("once");
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.asked).toEqual(["Allow write_file?"]);
    expect(shared.dialogs[0]!.detail).toContain("Auto mode has blocked several actions");
    expect(shared.dialogs[0]!.detail).toContain("outside the working directory");
    expect(await readFile(outside, "utf8")).toBe("3");
  });

  test("after the user confirms, the review sees the confirmation and the retried call runs", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "block", "reason": "outside the working directory"}'),
      say("May I write outside.txt?"),
      use("u2", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "allow", "reason": "the user confirmed"}'),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "write it");
    await send(s, "yes, go ahead");

    // 第二次审查（第五个请求）里有用户的确认和 agent 刚才的提问
    const review = (shared.requests[4]!.messages[0]!.content[0] as { text: string }).text;
    expect(review).toContain("yes, go ahead");
    expect(review).toContain("<agent-said>\nMay I write outside.txt?");
    expect(shared.asked).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("hi");
  });

  test("a failed review blocks the call and tells the model it may retry", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(use("u1", "write_file", { path: outside, content: "hi" }), { error: "boom" }, say("done"));
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.asked).toEqual([]);
    expect(await readFile(outside, "utf8").catch(() => undefined)).toBeUndefined();
    const result = JSON.stringify(shared.requests[2]!.messages.at(-1)!.content);
    expect(result).toContain("The automatic review failed: boom");
    expect(result).toContain("You may try it once more");
  });

  test("review: false in the config skips the model and asks directly", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: { "jade/approval": { mode: "auto", review: false } } });
    const outside = path.join(home, "outside.txt");
    shared.script.push(use("u1", "write_file", { path: outside, content: "hi" }), say("done"));
    shared.answers.push("once");
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.asked).toEqual(["Allow write_file?"]);
    // 第一个请求就是会话的：没有审查
    expect(shared.requests[0]!.system[0]!.text).not.toContain("You review actions");
    expect(await readFile(outside, "utf8")).toBe("hi");
  });

  test("an allowed fetch does not let a different URL on the same host skip the review", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("page", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    try {
      const { host, shared, send } = await scriptedHost({ config: AUTO });
      shared.script.push(
        use("u1", "web_fetch", { url: "https://example.com/raw/abc" }),
        say('{"decision": "allow", "reason": "a public page"}'),
        // 同一个主机，但 URL 里带着本地的数据
        use("u2", "web_fetch", { url: "https://example.com/api?data=SECRET" }),
        say('{"decision": "block", "reason": "it sends local data to another host"}'),
        say("done"),
      );
      const s = await host.sessions.open();
      await send(s, "read the paste");
      // 第二个调用也审查了（第四个请求），被拦下
      expect(shared.requests[3]!.system[0]!.text).toContain("You review actions");
      expect(JSON.stringify(shared.requests[4]!.messages.at(-1)!.content)).toContain("it sends local data to another host");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("ask mode never reviews: it goes straight to the user", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: { "jade/approval": { mode: "ask" } } });
    const outside = path.join(home, "outside.txt");
    shared.script.push(use("u1", "write_file", { path: outside, content: "hi" }), say("done"));
    shared.answers.push("deny");
    const s = await host.sessions.open();
    await send(s, "write it");
    expect(shared.asked).toEqual(["Allow write_file?"]);
    expect(shared.requests[0]!.system[0]!.text).not.toContain("You review actions");
  });
});
