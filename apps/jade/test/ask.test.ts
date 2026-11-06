// jade/ask：ask_user 经 ui@1 问用户。从旧 jade 的 test/jade.test.ts 的 ask_user 测试和 main.ts 的对话框移植。

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "uncarved";
import type { InputRequest, SelectRequest, UI } from "../src/index.ts";
import { askRenderer, askUserTool, askVia, DISMISSED } from "../plugins/ask/index.ts";
import { msg, resultText, say, scripted, turn, use } from "./scripted-host.ts";

const ctx = (signal = new AbortController().signal): ToolContext => ({ sessionId: "s", toolUseId: "t", signal, parent: { sessionId: "s", eventId: "e" }, progress: () => {} });

/** 按脚本选择（选项的 label）、输入的 UI，记下问过的标题 */
function fakeUi(picks: (string | undefined)[], typed: (string | undefined)[] = [], interactive = true) {
  const asked: string[] = [];
  const ui: UI = {
    interactive,
    notify: () => {},
    async select<T extends string>(r: SelectRequest<T>) {
      asked.push(r.title);
      const label = picks.shift();
      return r.options.find((o) => o.label === label)?.value;
    },
    async input(r: InputRequest) {
      asked.push(`input: ${r.title}`);
      return typed.shift();
    },
  };
  return { ui, asked };
}

const q = (question: string, ...labels: string[]) => ({ question, options: labels.map((label) => ({ label })) });

describe("ask_user", () => {
  test("asks each question in turn; Other lets the user type an answer", async () => {
    const { ui, asked } = fakeUi(["Postgres", "Other (type your answer)"], ["  a queue  "]);
    const tool = askUserTool(askVia(ui));
    const r = await tool.execute({ questions: [q("Which database?", "SQLite", "Postgres"), q("Which cache?", "None", "Redis")] }, ctx());
    expect(r.content).toBe("Q: Which database?\nA: Postgres\n\nQ: Which cache?\nA: a queue");
    expect(asked).toEqual(["Which database? (1/2)", "Which cache? (2/2)", "input: Which cache?"]);
  });

  test("a cancelled question means no answers; a question with a short tag is accepted", async () => {
    const { ui } = fakeUi(["SQLite", undefined]);
    const tool = askUserTool(askVia(ui));
    expect((await tool.execute({ questions: [{ label: "DB", ...q("Which database?", "SQLite", "Postgres") }, q("Which cache?", "None", "Redis")] }, ctx())).content).toBe(DISMISSED);
  });

  test("the user can go back and change an earlier answer; the earlier choice is marked", async () => {
    const hints: (string | undefined)[][] = [];
    const { ui, asked } = fakeUi(["SQLite", "← Previous question", "Postgres", "Redis"]);
    const select = ui.select.bind(ui);
    ui.select = (r, s) => (hints.push(r.options.map((o) => o.hint)), select(r, s));
    const r = await askUserTool(askVia(ui)).execute({ questions: [q("Which database?", "SQLite", "Postgres"), q("Which cache?", "None", "Redis")] }, ctx());
    expect(r.content).toBe("Q: Which database?\nA: Postgres\n\nQ: Which cache?\nA: Redis");
    expect(asked).toEqual(["Which database? (1/2)", "Which cache? (2/2)", "Which database? (1/2)", "Which cache? (2/2)"]);
    // 第一个问题没有"上一个问题"；回去时标出原来的答案
    expect(hints[0]).toEqual([undefined, undefined, undefined]);
    expect(hints[2]).toEqual(["your answer", undefined, undefined]);
  });

  test("cancelling the typed answer goes back to the options instead of dismissing everything", async () => {
    const { ui, asked } = fakeUi(["Other (type your answer)", "Other (type your answer)"], [undefined, "MySQL"]);
    const r = await askUserTool(askVia(ui)).execute({ questions: [q("Which database?", "SQLite", "Postgres")] }, ctx());
    expect(r.content).toBe("Q: Which database?\nA: MySQL");
    expect(asked).toEqual(["Which database?", "input: Which database?", "Which database?", "input: Which database?"]);
  });

  test("checks the number of questions and options", async () => {
    const tool = askUserTool(async () => ["x"]);
    expect((await tool.execute({ questions: [] }, ctx())).isError).toBe(true);
    const bad = await tool.execute({ questions: [q("Only one?", "yes")] }, ctx());
    expect(bad.content).toContain("each question needs 2-4 options");
  });

  test("an abort closes the dialog and fails the call", async () => {
    const ac = new AbortController();
    const ui: UI = {
      interactive: true,
      notify: () => {},
      select: (_r, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(undefined))),
      input: async () => undefined,
    };
    const run = askUserTool(askVia(ui)).execute({ questions: [q("Go?", "yes", "no")] }, ctx(ac.signal));
    ac.abort(new Error("stop"));
    await expect(run).rejects.toThrow("stop");
  });

  test("shows the question and the answers", () => {
    expect(askRenderer.summary!({ questions: [q("Which database?", "a", "b")] })).toBe("Which database?");
    expect(askRenderer.summary!({ questions: [q("a?", "x", "y"), q("b?", "x", "y")] })).toBe("2 questions");
    const two = "Q: a?\nA: x\n\nQ: b?\nA: y";
    expect(askRenderer.result!({ toolUseId: "t", input: {}, text: two, isError: false })).toEqual({ line: "x · y", details: "a? → x\nb? → y" });
    expect(askRenderer.result!({ toolUseId: "t", input: {}, text: DISMISSED, isError: false })).toEqual({ line: "dismissed" });
  });

  test("the bundled plugin offers the tool when the frontend can ask, and the prompt tells the model when to use it", async () => {
    // tui 的 ui@1 能提问（没有界面时 select 返回 undefined，也就是用户没有回答）
    const { host, requests } = await scripted([use(["u1", "ask_user", { questions: [q("Which?", "a", "b")] }]), say("ok")]);
    try {
      const s = await host.sessions.open();
      await turn(s, msg("do it"));
      expect(requests[0]!.tools.map((t) => t.name)).toContain("ask_user");
      expect(requests[0]!.system.map((x) => x.text).join("\n")).toContain("ask with ask_user");
      expect(resultText(requests[1]!.messages.at(-1)!.content[0])).toBe(DISMISSED);
    } finally {
      await host.close();
    }
  });

  test("with a frontend that cannot ask (print), there is no ask_user tool and the prompt does not mention it", async () => {
    const { host, requests } = await scripted([say("hi")], { flags: ["-p"] });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("hello"));
      expect(requests[0]!.tools.map((t) => t.name)).not.toContain("ask_user");
      expect(requests[0]!.system.map((x) => x.text).join("\n")).not.toContain("ask_user");
    } finally {
      await host.close();
    }
  });
});
