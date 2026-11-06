// jade/todo：todo_write 和它的显示。从旧 jade 的 todo 工具和 ui/renderers.ts 移植。

import { describe, expect, test } from "bun:test";
import type { Message, ToolContext } from "uncarved";
import { latestTodos, renderTodos, todoRenderer, todoTool } from "../plugins/todo/index.ts";
import { msg, resultText, say, scripted, turn, use } from "./scripted-host.ts";

const ctx: ToolContext = { sessionId: "s", toolUseId: "t", signal: new AbortController().signal, parent: { sessionId: "s", eventId: "e" }, progress: () => {} };
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("todo_write", () => {
  test("replaces the list and warns about more than one item in progress", async () => {
    const todos = [
      { content: "read", status: "completed" },
      { content: "edit", status: "in_progress" },
      { content: "test", status: "in_progress" },
      { content: "ship", status: "pending" },
    ];
    const r = await todoTool().execute({ todos }, ctx);
    expect(r.content).toBe("Todo list updated:\n[x] read\n[~] edit\n[~] test\n[ ] ship\nNote: keep only one item in_progress at a time.");
    expect(renderTodos([])).toBe("(empty)");
    expect(todoTool().effect).toBe("read");
  });

  test("latestTodos finds the last list in the history", () => {
    const call = (todos: unknown): Message => ({ role: "assistant", content: [{ kind: "tool_use", id: "x", name: "todo_write", input: { todos }, origin: { by: "model", provider: "p", model: "m" }, trust: "trusted" }] });
    expect(latestTodos([call([{ content: "a", status: "pending" }]), call([{ content: "b", status: "completed" }])])).toEqual([{ content: "b", status: "completed" }]);
    expect(latestTodos([])).toBeUndefined();
  });

  test("shows the list when called and hides a successful result", () => {
    const input = { todos: [{ content: "edit", status: "in_progress" }] };
    expect(todoRenderer.summary!(input)).toBe("1 items");
    expect(plain(todoRenderer.call!(input)!)).toBe("Todos\n  [~] edit");
    expect(todoRenderer.result!({ toolUseId: "t", input, text: "ok", isError: false })).toBeNull();
    expect(todoRenderer.result!({ toolUseId: "t", input, text: "bad", isError: true })).toBeUndefined();
    expect(todoRenderer.summary!(null)).toBe("0 items");
  });

  test("runs in a session without asking, and the prompt mentions it", async () => {
    const todos = [{ content: "one", status: "pending" }];
    const { host, requests } = await scripted([use(["u1", "todo_write", { todos }]), say("done")]);
    try {
      const s = await host.sessions.open();
      await turn(s, msg("plan it"));
      expect(requests[0]!.tools.map((t) => t.name)).toContain("todo_write");
      expect(requests[0]!.system.map((x) => x.text).join("\n")).toContain("keep a todo list with todo_write");
      expect(resultText(requests[1]!.messages.at(-1)!.content[0])).toBe("Todo list updated:\n[ ] one");
    } finally {
      await host.close();
    }
  });
});
