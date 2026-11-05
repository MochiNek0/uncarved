import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, type Message, type Provider } from "uncarved";
import { createJade, POLICY_KEY, type Mode } from "../src/index.ts";
import { CONTINUE_NOTE, continueTurns, MAX_CONTINUES, overflowTurns, planTurns, turns, type TurnContext, type TurnInfo, type TurnUI } from "../src/plugins/turns.ts";
import { policy } from "../src/plugins/policy.ts";

const provider: Provider = { id: "none", complete: () => Promise.reject(new Error("unused")) };

function fakeUi(answer?: unknown) {
  const logged: string[] = [];
  const asked: string[] = [];
  const ui: TurnUI = {
    interactive: true,
    log: (t) => void logged.push(t.replace(/\x1b\[[0-9;]*m/g, "")),
    select: async (title) => (asked.push(title), answer as never),
  };
  return { ui, logged, asked };
}

const turn = (t: Partial<TurnInfo>): TurnInfo => ({ canRetry: false, byMessage: true, followUps: 0, queued: false, ...t });
const text = (role: Message["role"], t: string): Message => ({ role, content: [{ kind: "text", text: t, origin: { by: "user" }, trust: "trusted" }] });

function context(mode: Mode, last?: Message): TurnContext {
  return { sessionId: "s", derived: (key) => (key === POLICY_KEY ? { mode, rules: [] } : undefined), lastMessage: () => last };
}

describe("turns moved out of the host", () => {
  test("jade/continue asks the model to go on after a cut-off reply, at most MAX_CONTINUES times per input", async () => {
    const { ui, logged } = fakeUi();
    const part = continueTurns(ui);
    const ctx = context("ask");
    for (let i = 0; i < MAX_CONTINUES; i++) expect(await part.afterTurn!(turn({ end: "max_tokens", followUps: i }), ctx)).toEqual({ kind: "continue", note: CONTINUE_NOTE });
    expect(await part.afterTurn!(turn({ end: "max_tokens", followUps: MAX_CONTINUES }), ctx)).toBeUndefined();
    expect(logged.at(-1)).toBe(`[asking the model to continue (${MAX_CONTINUES}/${MAX_CONTINUES})]`);
    // 下一次输入重新计数；正常结束的不管
    expect(await part.afterTurn!(turn({ end: "max_tokens", followUps: 0 }), ctx)).toMatchObject({ kind: "continue" });
    expect(await part.afterTurn!(turn({ end: "end" }), ctx)).toBeUndefined();
  });

  test("jade/compact compacts and retries once when the request overflowed the context window", async () => {
    const { ui, logged } = fakeUi();
    let compacted = 0;
    const part = overflowTurns({ request: () => void compacted++ }, ui);
    const ctx = context("ask");
    const overflow = turn({ error: "prompt is too long: 210000 tokens > 200000 maximum", canRetry: true });
    expect(await part.afterTurn!(overflow, ctx)).toEqual({ kind: "retry" });
    expect(compacted).toBe(1);
    expect(logged[0]).toContain("exceeded the model's context window");
    // 同一次输入里只重试一次；没法重试（已经有回复了）或者别的错误不管
    expect(await part.afterTurn!({ ...overflow, followUps: 1 }, ctx)).toBeUndefined();
    expect(await part.afterTurn!({ ...overflow, canRetry: false }, ctx)).toBeUndefined();
    expect(await part.afterTurn!(turn({ error: "connection reset", canRetry: true }), ctx)).toBeUndefined();
    expect(compacted).toBe(1);
  });

  test("jade/policy tells the model about plan mode, and after a plan offers to execute it", async () => {
    const pol = policy({ cwd: "/" });
    const { ui, asked } = fakeUi("auto");
    const part = planTurns(pol, ui);
    const plan = text("assistant", "1. change a.ts\n2. run the tests");
    expect(await part.beforeMessage!("hi", context("ask"))).toEqual({ notes: [] });
    // 这一轮中途才切到计划模式：模型不知道要给计划，不问
    expect(await part.afterTurn!(turn({ end: "end" }), context("plan", plan))).toBeUndefined();
    const on = await part.beforeMessage!("plan the change", context("plan"));
    expect(on!.notes![0]).toContain("now in plan mode");
    expect(await part.beforeMessage!("more", context("plan"))).toEqual({ notes: [] });
    // 排了别的输入、不是消息开始的、没有正常结束、没有文字回复时不问
    for (const t of [turn({ end: "end", queued: true }), turn({ end: "end", byMessage: false }), turn({ end: "max_tokens" })])
      expect(await part.afterTurn!(t, context("plan", plan))).toBeUndefined();
    expect(await part.afterTurn!(turn({ end: "end" }), context("plan", text("assistant", "  ")))).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await part.afterTurn!(turn({ end: "end" }), context("plan", plan))).toEqual({ kind: "say", text: "The plan is approved. Implement it now.", mode: "auto" });
    expect(asked).toEqual(["Execute this plan?"]);
    const off = await part.beforeMessage!("The plan is approved. Implement it now.", context("auto"));
    expect(off!.notes![0]).toContain("left plan mode");
    // 选"继续计划"、不能交互时不发消息
    expect(await planTurns(pol, fakeUi("plan").ui).afterTurn!(turn({ end: "end" }), context("plan", plan))).toBeUndefined();
  });

  test("the first participant with a next step wins; one that throws is reported and skipped", async () => {
    const warned: string[] = [];
    const flow = turns(
      [
        { id: "x/broken", part: { afterTurn: async () => Promise.reject(new Error("boom")), beforeMessage: async () => Promise.reject(new Error("bad")) } },
        { id: "x/first", part: { afterTurn: async () => ({ kind: "retry" }), beforeMessage: async () => ({ notes: ["n"] }) } },
        { id: "x/second", part: { afterTurn: async () => ({ kind: "continue", note: "go" }) } },
      ],
      (t) => void warned.push(t),
    );
    expect(await flow.afterTurn(turn({}), context("ask"))).toEqual({ kind: "retry" });
    expect(await flow.beforeMessage("hi", context("ask"))).toEqual({ notes: ["n"], blocks: [] });
    expect(warned).toEqual(["[warning] x/broken: boom", "[warning] x/broken: bad"]);
  });

  test("createJade wires the participants of the built-ins it keeps; @ references are attached by jade/mentions", async () => {
    const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-turns-")));
    const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-turns-home-")));
    await writeFile(path.join(cwd, "a.txt"), "hello from a\n");
    const { ui, logged } = fakeUi();
    const ctx = context("ask");
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {}, turnUi: ui });
    const { blocks } = await jade.turns.beforeMessage("look at @a.txt", ctx);
    expect(JSON.stringify(blocks)).toContain("hello from a");
    expect(logged).toEqual(["[attached @a.txt]"]);
    expect(await jade.turns.afterTurn(turn({ end: "max_tokens" }), ctx)).toMatchObject({ kind: "continue" });
    jade.shutdown();

    // 停用的内置插件不参与
    const off = await createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {}, turnUi: ui, disabled: ["jade/mentions", "jade/continue"] });
    expect((await off.turns.beforeMessage("look at @a.txt", ctx)).blocks).toEqual([]);
    expect(await off.turns.afterTurn(turn({ end: "max_tokens" }), ctx)).toBeUndefined();
    off.shutdown();
  });
});
