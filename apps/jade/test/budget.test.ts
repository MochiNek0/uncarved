// jade/budget：一轮里模型回复的次数达到配置的上限就停下。从旧 jade 的 test/jade.test.ts "the step budget stops a runaway turn" 移植。

import { describe, expect, test } from "bun:test";
import type { State } from "uncarved";
import { stepsThisTurn } from "../plugins/budget/index.ts";
import { msg, scripted, turn, use } from "./scripted-host.ts";

describe("jade/budget", () => {
  test("counts the model's replies since the last user input", () => {
    const text = (role: "user" | "assistant", kind = "text") => ({ role, content: [kind === "text" ? { kind: "text", text: "x" } : { kind: "tool_result" }] });
    const s = { messages: [text("assistant"), text("user"), text("assistant"), text("user", "tool_result"), text("assistant")] } as unknown as State;
    expect(stepsThisTurn(s)).toBe(2);
  });

  test("the step budget stops a runaway turn and says why", async () => {
    let n = 0;
    // 模型没完没了地调用工具
    const loop = () => use([`u${++n}`, "todo_write", { todos: [{ content: `step ${n}`, status: "pending" }] }]);
    const { host, requests } = await scripted([loop, loop, loop, loop, loop], { config: { "jade/budget": { maxSteps: 2 } } });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("go"));
      expect(requests).toHaveLength(2);
      const events = await s.history();
      expect(events.findLast((e) => e.type === "turn.ended")!.data).toEqual({ reason: "stopped" });
      const notice = events.find((e) => e.type === "jade/budget/notice");
      expect((notice!.data as { text: string }).text).toContain("stopped after 2 model responses");
    } finally {
      await host.close();
    }
  });
});
