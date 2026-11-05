// auto 模式的审查（jade/approval）：规则判断不了、本来要问的调用先让模型审一次。
// 审查只能放行或转给用户；出错、看不懂、超时都转给用户。模型和界面换成假的。

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseVerdict } from "../plugins/approval/review.ts";
import { cleanup, say, scriptedHost, use } from "./scripted-ui.ts";

afterEach(cleanup);

const AUTO = { "jade/approval": { mode: "auto" } };

describe("parseVerdict", () => {
  test("takes the first usable JSON answer and clips the reason", () => {
    expect(parseVerdict('noise {"decision": "allow", "reason": "fine"} more')).toEqual({ decision: "allow", reason: "fine" });
    expect(parseVerdict('```json\n{"decision":"ask"}\n```')).toEqual({ decision: "ask", reason: undefined });
    expect(parseVerdict('{"decision": "maybe"}')).toBeUndefined();
    expect(parseVerdict("I think it is fine")).toBeUndefined();
    expect(parseVerdict(`{"decision": "ask", "reason": "${"x".repeat(400)}"}`)!.reason!.length).toBeLessThan(400);
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

  test("passes the call to the user when the review says ask, showing its reason", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(
      use("u1", "write_file", { path: outside, content: "hi" }),
      say('{"decision": "ask", "reason": "it writes outside the working directory"}'),
      say("done"),
    );
    shared.answers.push("once");
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.asked).toEqual(["Allow write_file?"]);
    expect(shared.dialogs[0]!.detail).toContain("it writes outside the working directory");
    expect(await readFile(outside, "utf8")).toBe("hi");
  });

  test("a failed review is passed to the user with the reason", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: AUTO });
    const outside = path.join(home, "outside.txt");
    shared.script.push(use("u1", "write_file", { path: outside, content: "hi" }), { error: "boom" }, say("done"));
    shared.answers.push("deny");
    const s = await host.sessions.open();
    await send(s, "write it");

    expect(shared.dialogs[0]!.detail).toContain("The automatic review failed: boom");
    // 用户拒绝了：文件没有写
    expect(await readFile(outside, "utf8").catch(() => undefined)).toBeUndefined();
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
