// jade/repeats：重复调用的拒绝和提醒。从旧 jade 的 test/jade.test.ts 的 repeats 测试移植。

import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block } from "uncarved";
import { repeatsHooks } from "../plugins/repeats/index.ts";
import { msg, resultText, say, scripted, turn, use } from "./scripted-host.ts";

/** 直接调用 hook：model.before 算一次回复 */
function hooks(cwd = path.resolve("/work")) {
  const list = repeatsHooks({ cwd, shell: (t) => (t === "bash" ? "command" : undefined) }) as unknown as { kind: string; point: string; fn: (x: unknown) => unknown }[];
  const fn = (point: string) => list.find((h) => h.point === point)!.fn;
  return {
    respond: () => fn("model.before")({}),
    gate: fn("tool.gate") as (c: unknown) => { decision: string },
    after: fn("tool.after") as (o: unknown) => { content: Block[] } | undefined,
    observe: fn("event"),
  };
}

describe("jade/repeats", () => {
  test("identical calls in one response run once; repeated failures get a note", async () => {
    const { host, requests } = await scripted([
      use(["u1", "read_file", { path: "missing.txt" }], ["u2", "read_file", { path: "missing.txt" }]),
      use(["u3", "read_file", { path: "missing.txt" }]),
      say("gave up"),
    ]);
    try {
      const s = await host.sessions.open();
      await turn(s, msg("read it"));
      const [first, dup] = requests[1]!.messages.at(-1)!.content.map(resultText);
      expect(first).not.toContain("failed");
      expect(dup).toContain("identical to an earlier call");
      // 下一次回复里再发同一个调用会执行，第二次失败时提醒模型
      expect(resultText(requests[2]!.messages.at(-1)!.content[0])).toContain("This exact call has now failed 2 times");
    } finally {
      await host.close();
    }
  });

  test("a successful call repeated with nothing changed in between gets a note, until the user says something", async () => {
    const read = (id: string) => use([id, "read_file", { path: "a.txt" }]);
    const { cwd, host, requests } = await scripted([read("u1"), read("u2"), say("done"), read("u3"), say("ok")]);
    try {
      await writeFile(path.join(cwd, "a.txt"), "x\n");
      const last = (i: number) => resultText(requests[i]!.messages.at(-1)!.content[0]);
      const s = await host.sessions.open();
      await turn(s, msg("read it"));
      expect(last(1)).not.toContain("already ran earlier");
      expect(last(2)).toContain("already ran earlier");
      await turn(s, msg("read it again"));
      expect(last(4)).not.toContain("already ran earlier");
    } finally {
      await host.close();
    }
  });

  test("repeated failures: an edit in between restarts the count; compaction resets repeat notes", () => {
    const { respond, gate, after, observe } = hooks();
    let n = 0;
    const run = (name: string, input: unknown, isError: boolean, effect = "external") => {
      respond();
      const call = { toolUseId: `t${++n}`, name, input };
      gate({ ...call, tool: { effect } });
      const r = after({ call, content: [{ kind: "text", text: "out", origin: { by: "tool", name } }], isError });
      const last = r?.content.at(-1);
      return last?.kind === "text" ? last.text : "";
    };
    const t = { command: "bun test" };
    expect(run("bash", t, true)).not.toContain("failed");
    // 修了代码再跑：不算连续失败
    run("edit_file", { path: "a.ts" }, false, "write");
    expect(run("bash", t, true)).not.toContain("has now failed");
    expect(run("bash", t, true)).toContain("has now failed 2 times");

    expect(run("read_file", { path: "a.ts" }, false, "read")).not.toContain("already ran earlier");
    expect(run("read_file", { path: "a.ts" }, false, "read")).toContain("already ran earlier");
    // 压缩之后之前的结果可能已经不在上下文里
    observe({ type: "derived.recorded", data: { key: "jade/compact", value: {} } });
    expect(run("read_file", { path: "a.ts" }, false, "read")).not.toContain("already ran earlier");
  });

  test("the same text switched back and forth in a file gets a note the third time, until the user says something", () => {
    const { respond, gate, after, observe } = hooks();
    let n = 0;
    const edit = (name: string, input: object) => {
      respond();
      const call = { toolUseId: `t${++n}`, name, input };
      gate({ ...call, tool: { effect: "write" } });
      const r = after({ call, content: [{ kind: "text", text: "Edited", origin: { by: "tool", name } }], isError: false });
      const last = r?.content.at(-1);
      return last?.kind === "text" ? last.text : "";
    };
    const on = { path: "a.tsx", old_string: 'className="bg"', new_string: 'className="overflow-hidden bg"' };
    const off = { path: "a.tsx", old_string: on.new_string, new_string: on.old_string };
    expect(edit("edit_file", on)).toBe("");
    // 改回去一次是正常的撤销
    expect(edit("edit_file", off)).toBe("");
    // 别的文件里同样的文字、同一个文件里别的修改都不算
    expect(edit("edit_file", { ...on, path: "b.tsx" })).toBe("");
    expect(edit("edit_file", { path: "a.tsx", old_string: "gap-6", new_string: "gap-4" })).toBe("");
    expect(edit("edit_file", on)).toContain("back and forth 3 times");
    expect(edit("multi_edit", { path: "a.tsx", edits: [{ old_string: "x", new_string: "y" }, off] })).toContain("back and forth 4 times");
    // 用户发了新消息（可能就是让它改回去）：重新计
    observe({ type: "input.received", data: { kind: "message" } });
    expect(edit("edit_file", on)).toBe("");
  });

  test("repeat notes: a command repeated with nothing else run in between, but not when its output changed", () => {
    const { respond, gate, after } = hooks();
    let n = 0;
    const run = (command: string, out: string, effect = "external") => {
      respond();
      const call = { toolUseId: `t${++n}`, name: "bash", input: { command } };
      gate({ ...call, tool: { effect } });
      const r = after({ call, content: [{ kind: "text", text: out, origin: { by: "tool", name: "bash" }, trust: "untrusted" }], isError: false });
      return r?.content.at(-1)?.kind === "text" && (r.content.at(-1) as { text: string }).text.includes("already ran earlier");
    };
    const open = 'start "" page.html';
    expect(run(open, "Exit code 0")).toBe(false);
    expect(run(open, "Exit code 0")).toBe(true);
    expect(run("bun run build", "ok")).toBe(false);
    expect(run(open, "Exit code 0")).toBe(false);
    // 在等外面的变化：输出变了就不提醒
    expect(run("gh run view 1", "in progress")).toBe(false);
    expect(run("gh run view 1", "completed")).toBe(false);
  });

  test("re-opening an unchanged file in the same turn is denied; reading back a file just written gets a note", () => {
    const cwd = path.resolve("/work");
    const { respond: next, gate, after, observe } = hooks(cwd);
    let n = 0;
    /** 一次回复里的调用：先全部过关卡，再依次执行；返回每个调用的决定和结果末尾的提醒 */
    const respond = (...calls: [name: string, input: object, effect: string][]) => {
      next();
      const made = calls.map(([name, input, effect]) => ({ toolUseId: `t${++n}`, name, input, tool: { effect } }));
      const decisions = made.map((c) => gate(c).decision);
      return made.map((c, i) => {
        if (decisions[i] === "deny") return "deny";
        const r = after({ call: c, content: [{ kind: "text", text: "ok", origin: { by: "tool", name: c.name }, trust: "untrusted" }], isError: false });
        const last = r?.content.at(-1);
        return last?.kind === "text" && last.text.startsWith("[Note from jade]") ? last.text : "allow";
      });
    };
    const open = (p: string): [string, object, string] => ["bash", { command: `start "" ${p}` }, "external"];
    const write = (p: string): [string, object, string] => ["write_file", { path: p, content: "x" }, "write"];
    const read = (p: string): [string, object, string] => ["read_file", { path: p }, "read"];

    expect(respond(write("page.html"), open("page.html"))).toEqual(["allow", "allow"]);
    // 只读调用不算改动；路径写法不同也认得出（绝对路径、引号）
    expect(respond(["glob", { pattern: "*.html" }, "read"], open(`"${path.join(cwd, "page.html")}"`))).toEqual(["allow", "deny"]);
    // 改了之后再打开可以；同一次回复里先改后开也可以
    expect(respond(write("page.html"), open("page.html"))).toEqual(["allow", "allow"]);
    expect(respond(open("page.html"))).toEqual(["deny"]);
    // 别的文件、网址不受影响；网址也只开一次
    expect(respond(open("other.html"), open("https://example.com"))).toEqual(["allow", "allow"]);
    expect(respond(open("https://example.com"))).toEqual(["deny"]);
    // 不是单纯的打开命令不管
    expect(respond(["bash", { command: 'start "" page.html && echo hi' }, "external"])).toEqual(["allow"]);

    // 刚写完就读回来：提醒；中间有别的改动：不提醒
    const [, back] = respond(write("a.txt"), read("a.txt"));
    expect(back).toContain("You wrote this file with write_file");
    expect(respond(write("b.txt"), ["bash", { command: "bun run build" }, "external"], read("b.txt"))[2]).toBe("allow");
    // 用户发了新消息：都重新算
    observe({ type: "input.received", data: { kind: "message", content: [] } });
    expect(respond(open("page.html"), read("a.txt"))).toEqual(["allow", "allow"]);
  });
});
