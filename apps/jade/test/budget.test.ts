// jade/budget：一轮里模型回复的次数达到配置的上限就停下。从旧 jade 的 test/jade.test.ts "the step budget stops a runaway turn" 移植。

import { describe, expect, test } from "bun:test";
import type { State } from "uncarved";
import { stepsThisTurn, WRAP_UP_NOTE } from "../plugins/budget/index.ts";
import { msg, say, scripted, turn, use } from "./scripted-host.ts";

describe("jade/budget", () => {
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
