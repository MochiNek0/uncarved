// jade/withdraw：中断时模型还没有回复的消息撤回：不再交给模型，文字放回输入框，会话还是这一个。

import { afterEach, describe, expect, test } from "bun:test";
import type { CommandContext, Commands, Steer, Withdraw } from "@uncarved/jade-api/services";
import type { Session, UI } from "../src/index.ts";
import { cleanup, say, scriptedHost, textOf, use, userText } from "./scripted-ui.ts";

const g = globalThis as { __withdraw?: Withdraw; __steer?: Steer; __hang?: boolean; __hanging?: () => void; __say?: string };
afterEach(async () => {
  await cleanup();
  delete g.__withdraw;
  delete g.__steer;
  delete g.__hang;
  delete g.__hanging;
  delete g.__say;
});

// 测试用的插件：把 withdraw@1 交给测试；__hang 时请求模型之前（投影已经做完）停住，直到这一轮被中止；
// wait 工具执行时同样停住；__say 时在投影开始时经 jade/steer 说一句话（附在这一轮的消息上）
const HELPER = {
  "plugins/helper/plugin.json": JSON.stringify({ id: "test/helper", version: "1.0.0", api: "^1", entry: "index.mjs", requires: ["withdraw@1", "steer@1"] }),
  "plugins/helper/index.mjs": `export default { session(ctx) {
    globalThis.__withdraw = ctx.require("withdraw@1");
    globalThis.__steer = ctx.require("steer@1");
    const hang = (signal) => new Promise((r) => { globalThis.__hanging?.(); signal.addEventListener("abort", r, { once: true }); });
    ctx.kernel.tool({ name: "wait", effect: "read", description: "wait", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
      async execute(input, t) { await hang(t.signal); return { content: "waited" }; } });
    ctx.kernel.hook({ kind: "transform", point: "context.project", order: -100, fn: (m) => {
      if (globalThis.__say) { globalThis.__steer.push(ctx.session.id, globalThis.__say); globalThis.__say = undefined; }
      return m;
    } });
    ctx.kernel.hook({ kind: "transform", point: "model.before", fn: async (req, hook) => {
      if (globalThis.__hang) { globalThis.__hang = false; await hang(hook.signal); }
      return req;
    } });
  } };`,
};

/** 发一条消息，停住时像用户按 esc 那样中断（arm 之后中止），等会话空闲 */
async function sendAndInterrupt(s: Session, text: string, opts: { arm?: boolean } = {}) {
  const hanging = new Promise<void>((r) => (g.__hanging = r));
  const sent = s.send({ kind: "message", content: userText(text) }).catch(() => {});
  await hanging;
  if (opts.arm !== false) expect(g.__withdraw!.arm(s.id)).toBe(true);
  s.abort(new Error("interrupted by user"));
  await sent;
  await s.idle();
}

const userTexts = (msgs: { role: string; content: Parameters<typeof textOf>[0] }[]) => msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));

describe("jade/withdraw", () => {
  test("a message interrupted before the model answered is withdrawn: back in the input, never sent again, also after a restart", async () => {
    const { host, shared, send, restart } = await scriptedHost({ files: HELPER });
    shared.script.push(say("hello"), say("ok"), say("again"));
    const s = await host.sessions.open();
    // 空闲时没有可中断的一轮
    expect(g.__withdraw!.arm(s.id)).toBe(false);
    await send(s, "hi");

    g.__hang = true;
    await sendAndInterrupt(s, "oops, wrong message");
    expect(shared.drafts.at(-1)).toBe("oops, wrong message");
    expect((await s.history()).filter((e) => e.type === "jade/withdraw/withdrawn").map((e) => e.data)).toEqual([{ text: "oops, wrong message" }]);
    // /retry 没有可以重新请求的消息：这一轮出错，不请求模型
    const requests = shared.requests.length;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    await Promise.resolve(host.service<Commands>("commands@1")!.get("retry")!.command.run("", c)).catch(() => {});
    await s.idle();
    expect(shared.requests.length).toBe(requests);
    expect((await s.history()).filter((e) => e.type === "turn.ended").at(-1)!.data).toMatchObject({ reason: "error", error: expect.stringContaining("withdrawn") });

    await send(s, "the right message");
    expect(userTexts(shared.requests.at(-1)!.messages)).toEqual(["hi", "the right message"]);

    // 恢复的会话里它也不在
    await host.close();
    const again = await restart();
    const r = await again.sessions.open({ resume: s.id });
    await send(r, "more");
    expect(userTexts(shared.requests.at(-1)!.messages)).toEqual(["hi", "the right message", "more"]);
  });

  test("not withdrawn when the interrupt was not the user's, or the model had already answered", async () => {
    const { host, shared, send } = await scriptedHost({ files: HELPER });
    shared.script.push(use("w1", "wait", {}), say("done"));
    const s = await host.sessions.open();

    // 别人中止的（没有 arm）：消息留着
    g.__hang = true;
    await sendAndInterrupt(s, "kept", { arm: false });
    // 模型已经回复、在执行工具时中断：消息留着
    await sendAndInterrupt(s, "also kept");
    expect(shared.drafts).toEqual([]);
    expect((await s.history()).some((e) => e.type === "jade/withdraw/withdrawn")).toBe(false);

    await send(s, "next");
    expect(userTexts(shared.requests.at(-1)!.messages)).toEqual(["kept", "also kept", "waited", "next"]);
  });

  test("what was said mid-turn with a withdrawn message goes with the next message instead", async () => {
    const { host, shared, send } = await scriptedHost({ files: HELPER });
    shared.script.push(say("ok"));
    const s = await host.sessions.open();
    g.__hang = true;
    g.__say = "and keep it short";
    await sendAndInterrupt(s, "oops");
    await send(s, "the real one");
    const last = shared.requests.at(-1)!.messages;
    expect(last.length).toBe(1);
    expect(textOf(last[0]!.content)).toContain("the real one");
    expect(textOf(last[0]!.content)).toContain("and keep it short");
    expect(textOf(last[0]!.content)).not.toContain("oops");
  });
});
