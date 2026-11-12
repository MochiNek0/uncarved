// /rewind（jade/sessions）：回到某条消息之前。原会话不动，复制出它在那条消息之前的部分作为新会话（sessions.open 的 fork）。

import { afterEach, expect, test } from "bun:test";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { cleanup, say, scriptedHost, textOf } from "./scripted-ui.ts";

afterEach(cleanup);

test("/rewind opens a copy of the session as it was before the chosen message and puts that message back in the input", async () => {
  const { host, shared, send } = await scriptedHost();
  const commands = host.service<Commands>("commands@1")!;
  const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
  const s = await host.sessions.open();
  shared.script.push(say("one done"), say("two done"), say("three done"));
  await send(s, "first");
  await send(s, "second\nwith two lines");
  await send(s, "third");

  // 选项新的在前：选第二条
  const sent = (await s.history()).filter((e) => e.type === "input.received");
  const second = sent[1]!.seq;
  shared.answers.push(String(second));
  const out = await commands.get("rewind")!.command.run("", c);
  expect(out).toContain(`jade --resume ${s.id}`);
  expect(shared.asked.at(-1)).toBe("Rewind to before which message?");

  const now = host.sessions.current!;
  expect(now.id).not.toBe(s.id);
  expect(now.state.messages.map((m) => textOf(m.content))).toEqual(["first", "one done"]);
  expect(shared.drafts).toEqual(["second\nwith two lines"]);
  // 原会话不动：三条消息都还在
  expect((await s.history()).filter((e) => e.type === "input.received").length).toBe(3);

  // 新会话接着用
  shared.script.push(say("again"));
  await send(now, "second, differently");
  expect(textOf(shared.requests.at(-1)!.messages.at(-1)!.content)).toBe("second, differently");
  expect(shared.requests.at(-1)!.messages.map((m) => textOf(m.content))).toEqual(["first", "one done", "second, differently"]);
});

test("/rewind with nothing sent says so, and cancelling changes nothing", async () => {
  const { host, shared, send } = await scriptedHost();
  const commands = host.service<Commands>("commands@1")!;
  const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
  const s = await host.sessions.open();
  expect(await commands.get("rewind")!.command.run("", c)).toContain("Nothing to rewind to");
  shared.script.push(say("ok"));
  await send(s, "hello");
  shared.answers.push("");
  expect(await commands.get("rewind")!.command.run("", c)).toBeUndefined();
  expect(host.sessions.current!.id).toBe(s.id);
});

test("sessions.open refuses to fork from something that is not a user message", async () => {
  const { host } = await scriptedHost();
  const s = await host.sessions.open();
  await expect(host.sessions.open({ fork: { session: s.id, before: 1 } })).rejects.toThrow("is not a message from the user");
  expect(host.sessions.current!.id).toBe(s.id);
});
