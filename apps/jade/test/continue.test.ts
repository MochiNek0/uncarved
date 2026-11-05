// jade/continue：回复被输出上限截断时让模型接着做，每次用户输入之后最多 maxContinues 次。
// 从旧 jade 的 test/turns.test.ts 移植；现在经 turn.ended 事件和 session.afterTurn / send，在真实的会话里测。

import { describe, expect, test } from "bun:test";
import { CONTINUE_NOTE } from "../plugins/continue/index.ts";
import { msg, say, scripted, turn } from "./scripted-host.ts";

const lastText = (m: { content: { kind: string; text?: string }[] } | undefined) => m?.content.map((b) => b.text ?? "").join("") ?? "";

describe("jade/continue", () => {
  test("asks the model to go on after a cut-off reply, at most maxContinues times per input", async () => {
    const cut = (text: string) => say(text, "max_tokens");
    const { host, requests } = await scripted([cut("a"), cut("b"), cut("c"), cut("d"), cut("e"), say("f"), say("g")]);
    try {
      const s = await host.sessions.open();
      await turn(s, msg("write it"));
      // 第一次加三次续写，第四次截断之后不再续写
      expect(requests).toHaveLength(4);
      for (const i of [1, 2, 3]) expect(lastText(requests[i]!.messages.at(-1))).toBe(`[Note from jade] ${CONTINUE_NOTE}`);
      expect(requests[1]!.messages.at(-1)!.content[0]!.origin).toEqual({ by: "plugin", id: "jade/continue" });

      // 下一次输入重新计数；正常结束的不管
      await turn(s, msg("more"));
      expect(requests).toHaveLength(6);
      expect(lastText(requests[4]!.messages.at(-1))).toBe("more");
      expect(lastText(requests[5]!.messages.at(-1))).toBe(`[Note from jade] ${CONTINUE_NOTE}`);
      await turn(s, msg("done?"));
      expect(requests).toHaveLength(7);
    } finally {
      await host.close();
    }
  });

  test("maxContinues 0 turns it off", async () => {
    const { host, requests } = await scripted([say("a", "max_tokens"), say("b")], { config: { "jade/continue": { maxContinues: 0 } } });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("write it"));
      expect(requests).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});
