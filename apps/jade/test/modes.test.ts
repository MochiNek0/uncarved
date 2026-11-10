// jade/modes：计划模式的告知和 propose_plan 的"执行这个计划？"。模式本身在 jade/approval；这里用真实的 bundled 插件、假模型和假界面。

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { APPROVED_NOTE, NOT_APPROVED } from "../plugins/modes/index.ts";
import { PluginHost } from "../src/index.ts";
import type { Approval, Modes } from "@uncarved/jade-api/services";
import type { ModelRequest } from "uncarved";
import { cleanup, MODEL, say, scriptedHost, textOf, type Step } from "./scripted-ui.ts";

afterEach(cleanup);

const PLAN = { "jade/approval": { mode: "plan" } };

/** 同一个 $JADE_HOME 再启动一次（scriptedHost 装的假模型和假界面还在 home/plugins 里） */
async function restart(home: string, cwd: string) {
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: path.resolve(import.meta.dir, "../plugins") },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd,
    report: () => {},
  });
  await host.sessions.open();
  const mode = host.service<Approval>("approval@1")!.mode();
  await host.close();
  return mode;
}

describe("the remembered mode", () => {
  test("the mode the user picked is used again after a restart; plan is not remembered", async () => {
    const { home, cwd, host } = await scriptedHost({ config: { "jade/approval": { mode: "ask" } } });
    await host.sessions.open();
    const modes = host.service<Modes>("modes@1")!;
    modes.set("auto");
    modes.set("plan");
    await host.close();
    expect(await restart(home, cwd)).toBe("auto");
  });

  test("a run that cannot ask the user keeps the configured mode", async () => {
    const { home, cwd, host, shared } = await scriptedHost({ config: { "jade/approval": { mode: "ask" } } });
    await host.sessions.open();
    host.service<Modes>("modes@1")!.set("auto");
    await host.close();
    shared.interactive = false;
    expect(await restart(home, cwd)).toBe("ask");
  });
});

/** 模型先写计划再调用 propose_plan（同一个回复里） */
const propose = (id: string, plan: string): Step => ({
  content: [
    { kind: "text", text: plan, origin: MODEL, trust: "trusted" },
    { kind: "tool_use", id, name: "propose_plan", input: {}, origin: MODEL, trust: "trusted" },
  ],
  stopReason: "tool_use",
});
const systemOf = (req: ModelRequest) => req.system.map((x) => x.text).join("\n");
const toolsOf = (req: ModelRequest) => req.tools.map((t) => t.name);

describe("plan mode", () => {
  test("tells the model it is planning; propose_plan asks whether to execute, and approving switches the mode", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.script.push(propose("p1", "Here is the plan: change a.ts."), say("Implemented."));
    shared.answers.push("auto");
    const s = await host.sessions.open();
    await send(s, "fix the bug");

    // 第一次请求的系统提示词里有计划模式的说明，工具里有 propose_plan
    expect(systemOf(shared.requests[0]!)).toContain("The session is in plan mode");
    expect(systemOf(shared.requests[0]!)).toContain("call propose_plan");
    expect(toolsOf(shared.requests[0]!)).toContain("propose_plan");
    expect(shared.asked).toEqual(["Execute this plan?"]);

    // 批准之后：模式换成 auto，工具结果让模型开始做，系统提示词和工具里不再有计划模式的东西
    expect(host.service<Approval>("approval@1")!.mode()).toBe("auto");
    expect(shared.requests).toHaveLength(2);
    expect(textOf(shared.requests[1]!.messages.at(-1)!.content)).toBe(`${APPROVED_NOTE} (mode: auto)`);
    expect(systemOf(shared.requests[1]!)).not.toContain("The session is in plan mode");
    expect(toolsOf(shared.requests[1]!)).not.toContain("propose_plan");
  });

  test("'No, keep planning' changes nothing and tells the model to wait", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.script.push(propose("p1", "Here is the plan."), say("Waiting for your feedback."));
    shared.answers.push("plan");
    const s = await host.sessions.open();
    await send(s, "fix the bug");

    expect(shared.asked).toEqual(["Execute this plan?"]);
    expect(host.service<Approval>("approval@1")!.mode()).toBe("plan");
    expect(textOf(shared.requests[1]!.messages.at(-1)!.content)).toBe(NOT_APPROVED);
  });

  test("a text reply without propose_plan is not a plan to execute", async () => {
    // 比如追问，或者用户要的就是计划本身（健身计划）：不问要不要执行
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.script.push(say("Weekly plan: Monday chest, Tuesday back, ..."));
    const s = await host.sessions.open();
    await send(s, "make me a workout plan");
    expect(shared.asked).toEqual([]);
    expect(shared.requests).toHaveLength(1);
  });

  test("ask mode has neither the plan note nor propose_plan", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/approval": { mode: "ask" } } });
    shared.script.push(say("Here is the plan."));
    const s = await host.sessions.open();
    await send(s, "fix the bug");
    expect(shared.asked).toEqual([]);
    expect(systemOf(shared.requests[0]!)).not.toContain("The session is in plan mode");
    expect(toolsOf(shared.requests[0]!)).not.toContain("propose_plan");
  });

  test("a run that cannot ask the user has no propose_plan and is told to stop after the plan", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.interactive = false;
    shared.script.push(say("Here is the plan."));
    const s = await host.sessions.open();
    await send(s, "fix the bug");
    expect(systemOf(shared.requests[0]!)).toContain("Then stop and wait for the user's approval.");
    expect(systemOf(shared.requests[0]!)).not.toContain("propose_plan");
    expect(toolsOf(shared.requests[0]!)).not.toContain("propose_plan");
  });
});
