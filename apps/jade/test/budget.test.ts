// jade/budget：一轮里模型回复的次数达到配置的上限就停下。从旧 jade 的 test/jade.test.ts "the step budget stops a runaway turn" 移植。

import { describe, expect, test } from "bun:test";
import type { State } from "uncarved";
import { stepsThisTurn, WRAP_UP_NOTE } from "../plugins/budget/index.ts";
import { msg, say, scripted, turn, use } from "./scripted-host.ts";
import * as ui from "./scripted-ui.ts";

describe("jade/budget", () => {
  test("without maxSteps the interactive app has no step limit", async () => {
    const { host, shared, send } = await ui.scriptedHost();
    try {
      for (let n = 1; n <= 201; n++) shared.script.push(ui.use(`u${n}`, "todo_write", { todos: [{ content: `step ${n}`, status: "pending" }] }));
      shared.script.push(ui.say("done"));
      const s = await host.sessions.open();
      await send(s, "go");
      expect(shared.asked).toEqual([]);
      expect(shared.requests).toHaveLength(202);
      expect((await s.history()).filter((e) => e.type === "jade/budget/notice")).toEqual([]);
    } finally {
      await ui.cleanup();
    }
  }, 30_000);

  test("when jade can ask, the limit asks whether to keep going; continuing adds maxSteps without a summary", async () => {
    const { host, shared, send } = await ui.scriptedHost({ config: { "jade/budget": { maxSteps: 2 } } });
    try {
      const todo = (n: number) => ui.use(`u${n}`, "todo_write", { todos: [{ content: `step ${n}`, status: "pending" }] });
      shared.script.push(todo(1), todo(2), todo(3), todo(4), ui.say("summary"));
      shared.answers.push("more", "stop");
      const s = await host.sessions.open();
      await send(s, "go");
      // 2 次后问一次（继续），再 2 次后又问（停下），之后才收尾
      expect(shared.asked).toEqual(["Jade has made 2 model responses in this turn. Keep going?", "Jade has made 4 model responses in this turn. Keep going?"]);
      expect(shared.requests).toHaveLength(5);
      expect(JSON.stringify(shared.requests[3]!.messages)).not.toContain(WRAP_UP_NOTE);
      expect(JSON.stringify(shared.requests[4]!.messages.at(-1))).toContain(WRAP_UP_NOTE);
      const history = await s.history();
      // 用户选的"继续"是人工输入，记进了日志（I-5）
      expect(history.filter((e) => e.type === "jade/budget/continued").map((e) => e.data)).toEqual([{ steps: 2, limit: 4 }]);
      const notice = history.find((e) => e.type === "jade/budget/notice");
      expect((notice!.data as { text: string }).text).toContain("stopped after 4 model responses");
    } finally {
      await ui.cleanup();
    }
  });


  test("counts the model's replies since the last user input", () => {
    const text = (role: "user" | "assistant", kind = "text") => ({ role, content: [kind === "text" ? { kind: "text", text: "x" } : { kind: "tool_result" }] });
    const s = { messages: [text("assistant"), text("user"), text("assistant"), text("user", "tool_result"), text("assistant")] } as unknown as State;
    expect(stepsThisTurn(s)).toBe(2);
  });

  test("the step budget stops a runaway turn, says why, and asks the model to summarize", async () => {
    let n = 0;
    // 模型没完没了地调用工具
    const loop = () => use([`u${++n}`, "todo_write", { todos: [{ content: `step ${n}`, status: "pending" }] }]);
    const { host, requests } = await scripted([loop, loop, say("summary")], { config: { "jade/budget": { maxSteps: 2 } } });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("go"));
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2]!.messages.at(-1))).toContain(WRAP_UP_NOTE);
      const events = await s.history();
      expect(events.filter((e) => e.type === "turn.ended").map((e) => e.data)).toEqual([{ reason: "stopped" }, { reason: "end" }]);
      const notice = events.find((e) => e.type === "jade/budget/notice");
      expect((notice!.data as { text: string }).text).toContain("stopped after 2 model responses");
      expect(s.state.messages.at(-1)!.content).toMatchObject([{ kind: "text", text: "summary" }]);
    } finally {
      await host.close();
    }
  });

  test("the wrap-up turn refuses tools and cannot run away", async () => {
    let n = 0;
    // 收到收尾消息之后还是一直调用工具
    const loop = () => use([`u${++n}`, "todo_write", { todos: [{ content: `step ${n}`, status: "pending" }] }]);
    const { host, requests } = await scripted([loop, loop, loop, loop, loop, loop], { config: { "jade/budget": { maxSteps: 2 } } });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("go"));
      // 2 次正常回复 + 收尾最多 2 次，不会再发第三条收尾消息
      expect(requests).toHaveLength(4);
      const events = await s.history();
      const decided = events.filter((e) => e.type === "tool.decided").map((e) => (e.data as { decision: string }).decision);
      expect(decided).toEqual(["allow", "allow", "deny", "deny"]);
      expect(events.filter((e) => e.type === "turn.ended").map((e) => e.data)).toEqual([{ reason: "stopped" }, { reason: "stopped" }]);
      expect(events.filter((e) => e.type === "jade/budget/notice")).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});
