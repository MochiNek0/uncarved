// jade/modes：计划模式的告知和"执行这个计划？"。模式本身在 jade/approval；这里用真实的 bundled 插件、假模型和假界面。

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { APPROVED_NOTE, PLAN_NOTE, type Modes } from "../plugins/modes/index.ts";
import { PluginHost } from "../src/index.ts";
import type { Approval } from "../plugins/approval/index.ts";
import { cleanup, say, scriptedHost, textOf, use } from "./scripted-ui.ts";

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

describe("plan mode", () => {
  test("tells the model it is planning, then asks whether to execute the plan", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.script.push(say("Here is the plan: change a.ts."), say("Implemented."));
    shared.answers.push("auto");
    const s = await host.sessions.open();
    await send(s, "fix the bug");

    // 第一次请求的系统提示词里有计划模式的说明
    expect(shared.requests[0]!.system.map((x) => x.text).join("\n")).toContain("The session is in plan mode");
    expect(shared.asked).toEqual(["Execute this plan?"]);

    // 批准之后：模式换成 auto，替用户发了"开始做"，系统提示词里不再有那段
    expect(host.service<Approval>("approval@1")!.mode()).toBe("auto");
    expect(shared.requests[1]).toBeDefined();
    expect(textOf(shared.requests[1]!.messages.at(-1)!.content)).toBe(APPROVED_NOTE);
    expect(shared.requests[1]!.system.map((x) => x.text).join("\n")).not.toContain("The session is in plan mode");
  });

  test("'No, keep planning' changes nothing", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    shared.script.push(say("Here is the plan."), say("Still here."));
    shared.answers.push("plan");
    const s = await host.sessions.open();
    await send(s, "fix the bug");

    expect(shared.asked).toEqual(["Execute this plan?"]);
    expect(host.service<Approval>("approval@1")!.mode()).toBe("plan");
    // 没有替用户发消息：只有用户那一条
    expect(shared.requests).toHaveLength(1);
    const second = await s.send({ kind: "message", content: [{ kind: "text", text: "go on", origin: { by: "user" }, trust: "trusted" }] });
    await second;
    await s.idle();
    // 计划模式下仍然会说"这是计划"
    expect(shared.asked).toEqual(["Execute this plan?", "Execute this plan?"]);
  });

  test("ask mode never asks about a plan", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/approval": { mode: "ask" } } });
    shared.script.push(say("Here is the plan."));
    const s = await host.sessions.open();
    await send(s, "fix the bug");
    expect(shared.asked).toEqual([]);
    expect(shared.requests[0]!.system.map((x) => x.text).join("\n")).not.toContain("The session is in plan mode");
  });

  test("a reply that is only tool calls is not a plan", async () => {
    const { host, shared, send } = await scriptedHost({ config: PLAN });
    // 只读工具在计划模式下照常放行
    shared.script.push(use("u1", "list_dir", { path: "." }), say("Here is the plan."));
    shared.answers.push("keep planning");
    const s = await host.sessions.open();
    await send(s, "look around");
    // 第一轮以工具调用结束：不问；第二轮给出文字计划才问
    expect(shared.asked).toEqual(["Execute this plan?"]);
  });
});
