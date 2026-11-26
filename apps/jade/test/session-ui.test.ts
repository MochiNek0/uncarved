// 会话里的界面（4.3）：插件的 ctx.status、ctx.input 来自前端 ui@1.session 给出的那份；
// 插件的作用域关闭（换会话、隔离、退出）时核心调用它的 dispose。以及 jade/tui 的 ScreenBridge 怎么放这些段落。

import { describe, expect, test } from "bun:test";
import type { SessionUI } from "../src/api.ts";
import { PluginHost } from "../src/index.ts";
import { ScreenBridge } from "../plugins/tui/frontend.ts";
import type { Choice, JobInfo, Screen, StatusInfo } from "../plugins/tui/screen.ts";
import { world } from "./helpers.ts";

const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", { id: "fake", complete: async () => ({ model: "m", content: [], stopReason: "end" }) });
} };`;

/** ui@1：给每个插件开一份会话界面，把 status、输入框的操作和 dispose 记到 globalThis */
const FAKE_UI = `export default { process(ctx) {
  const g = () => globalThis.__jadeSessionUI;
  ctx.provide("ui@1", {
    interactive: true,
    notify: () => {},
    select: async () => undefined,
    input: async () => undefined,
    session: ({ session, plugin }) => {
      const h = { session, plugin, status: undefined, hint: undefined, disposed: false };
      g().handles.push(h);
      return {
        status(text) { h.status = text; g().shown.push({ plugin, text }); },
        panel(text) { h.panel = text; },
        draft: {
          text: () => g().draft,
          insert: (t) => { g().draft += t; g().inserted.push(t); },
          set: (t) => { g().draft = t; },
          hint: (t) => { h.hint = t; },
        },
        dispose() { h.disposed = true; g().disposed.push(plugin); },
      };
    },
  });
} };`;

const USER = `export default { session(ctx) {
  ctx.status("hello\\nworld");
  ctx.panel("a\\nb");
  ctx.input.hint("try @file");
  ctx.input.insert("@a.ts");
} };`;

const PLAIN_UI = `export default { process(ctx) {
  ctx.provide("ui@1", { interactive: false, notify: () => {}, select: async () => undefined, input: async () => undefined });
} };`;

interface Recorded {
  handles: { session: string; plugin: string; status?: string; panel?: string; hint?: string; disposed: boolean }[];
  shown: { plugin: string; text?: string }[];
  disposed: string[];
  draft: string;
  inserted: string[];
}

async function setup(ui = FAKE_UI) {
  const g = globalThis as { __jadeSessionUI?: Recorded };
  g.__jadeSessionUI = { handles: [], shown: [], disposed: [], draft: "", inserted: [] };
  const w = await world();
  await w.plugin("bundled", { id: "provider", provides: ["provider@1"] }, PROVIDER);
  await w.plugin("bundled", { id: "ui", provides: ["ui@1"] }, ui);
  await w.plugin("user", { id: "notes" }, USER);
  const host = await w.start();
  return { host, recorded: g.__jadeSessionUI };
}

describe("session UI", () => {
  test("a plugin gets ctx.status and ctx.input for its session; dispose runs when the session is left", async () => {
    const { host, recorded } = await setup();
    const one = await host.sessions.open();
    const handle = recorded.handles.find((h) => h.plugin === "notes")!;
    expect(handle.session).toBe(one.id);
    expect(handle.status).toBe("hello\nworld");
    expect(handle.panel).toBe("a\nb");
    expect(handle.hint).toBe("try @file");
    expect(recorded.draft).toBe("@a.ts");

    // 换会话：上一个会话里插件的东西被收掉，新会话里重新给一份
    const two = await host.sessions.open();
    expect(handle.disposed).toBe(true);
    expect(recorded.disposed).toEqual(["notes"]);
    expect(recorded.handles.filter((h) => h.plugin === "notes").map((h) => h.session)).toEqual([one.id, two.id]);

    await host.close();
    // 关掉的会话也收：两个会话的句柄都 dispose 过（第二个在关闭时）
    expect(recorded.disposed).toEqual(["notes", "notes"]);
  });

  test("a frontend without a session UI leaves ctx.status and ctx.input undefined", async () => {
    const { host, recorded } = await setup(PLAIN_UI);
    await host.sessions.open();
    // 同一段插件代码：ctx.status 不在，插件要能看出来
    expect(recorded.handles).toEqual([]);
    await host.close();
  });
});

// ---------- jade/tui 的 ScreenBridge ----------

function fakeScreen() {
  const statuses: Partial<StatusInfo>[] = [];
  const draft = { value: "", hint: undefined as string | undefined, inserted: [] as string[] };
  const screen: Screen = {
    interactive: true,
    log: () => {},
    amend: () => {},
    progress: () => {},
    stream: () => {},
    endStream: () => {},
    busy: () => {},
    status: (info) => statuses.push(structuredClone(info)),
    queued: () => {},
    select: async <T,>(_t: string, _c: Choice<T>[]) => undefined,
    input: async () => undefined,
    draft: {
      text: () => draft.value,
      insert: (t) => draft.inserted.push(t),
      set: (t) => void (draft.value = t),
      hint: (t) => void (draft.hint = t),
    },
    clear: () => {},
    close: async () => {},
  };
  return { screen, statuses, draft };
}

describe("ScreenBridge status segments", () => {
  test("segments belong to the session that set them and show only while it is current", () => {
    const { screen, statuses } = fakeScreen();
    const bridge = new ScreenBridge();
    bridge.attach(screen);
    const a = bridge.ui.session!({ session: "s1", plugin: "p/a" })!;
    const b = bridge.ui.session!({ session: "s2", plugin: "p/b" })!;

    a.status("3 notes");
    b.status("watching");
    // 界面还没说显示哪个会话：什么都不画
    expect(statuses).toEqual([]);

    bridge.show("s1");
    expect(statuses.at(-1)).toEqual({ plugins: [{ plugin: "p/a", text: "3 notes" }], panels: [] });
    bridge.show("s2");
    expect(statuses.at(-1)).toEqual({ plugins: [{ plugin: "p/b", text: "watching" }], panels: [] });

    // 回到 s1：它的段落还在
    bridge.show("s1");
    expect(statuses.at(-1)).toEqual({ plugins: [{ plugin: "p/a", text: "3 notes" }], panels: [] });

    // 关闭界面的会话：段落去掉，dispose 之后再调用也不显示
    a.dispose();
    expect(statuses.at(-1)).toEqual({ plugins: [], panels: [] });
    a.status("late");
    expect(statuses.at(-1)).toEqual({ plugins: [], panels: [] });
    bridge.show(undefined);
    expect(statuses.at(-1)).toEqual({ plugins: [], panels: [] });
  });

  test("another plugin leaving the session does not lose a later segment", () => {
    const { screen, statuses } = fakeScreen();
    const bridge = new ScreenBridge();
    bridge.attach(screen);
    bridge.show("s1");
    const a = bridge.ui.session!({ session: "s1", plugin: "p/a" })!;
    const b = bridge.ui.session!({ session: "s1", plugin: "p/b" })!;
    // b 离开时会话里还没有段落
    b.dispose();
    a.status("building");
    expect(statuses.at(-1)).toEqual({ plugins: [{ plugin: "p/a", text: "building" }], panels: [] });
  });

  test("a segment is one clipped line, and the draft is forwarded to the input box", () => {
    const { screen, statuses, draft } = fakeScreen();
    const bridge = new ScreenBridge();
    bridge.attach(screen);
    bridge.show("s1");
    const ui = bridge.ui.session!({ session: "s1", plugin: "p/a" })!;
    ui.status("  two\nlines\there ");
    expect(statuses.at(-1)).toEqual({ plugins: [{ plugin: "p/a", text: "two lines here" }], panels: [] });
    ui.status(undefined);
    expect(statuses.at(-1)).toEqual({ plugins: [], panels: [] });

    // 输入框上方的一块：多行原样保留，太长的只留前几行；dispose 时和段落一起去掉
    ui.panel!(`Todos\n${Array.from({ length: 12 }, (_, i) => `  item ${i}`).join("\n")}\n`);
    const panel = statuses.at(-1)!.panels![0]!;
    expect(panel.plugin).toBe("p/a");
    expect(panel.text.split("\n")).toEqual(["Todos", ...Array.from({ length: 8 }, (_, i) => `  item ${i}`), "  … 4 more"]);
    ui.status("busy");
    ui.dispose();
    expect(statuses.at(-1)).toEqual({ plugins: [], panels: [] });

    ui.draft!.set("hello");
    ui.draft!.insert("!");
    ui.draft!.hint("Tab to accept");
    expect(draft.value).toBe("hello");
    expect(draft.inserted).toEqual(["!"]);
    expect(draft.hint).toBe("Tab to accept");
  });

  test("background jobs show only for the current session; output is batched, status at once; dispose removes them", async () => {
    const { screen } = fakeScreen();
    const shown: JobInfo[][] = [];
    screen.jobs = (jobs) => void shown.push(jobs);
    const bridge = new ScreenBridge();
    bridge.attach(screen);
    bridge.show("s1");
    let stops = 0;
    const a = bridge.ui.job!({ session: "s1", kind: "shell", title: "bg1 npm run dev", stop: () => void stops++ });
    bridge.ui.job!({ session: "s2", kind: "agent", title: "elsewhere" });
    expect(shown.at(-1)!.map((j) => j.title)).toEqual(["bg1 npm run dev"]);

    a.status("running");
    expect(shown.at(-1)![0]).toMatchObject({ status: "running", done: false, output: "" });
    const before = shown.length;
    a.append("one\n");
    a.append({ text: "two\n", style: "dim" });
    expect(shown.length).toBe(before);
    await Bun.sleep(150);
    expect(shown.at(-1)![0]!.output).toContain("one\n");
    expect(shown.at(-1)![0]!.output).toContain("two");
    shown.at(-1)![0]!.stop!();
    expect(stops).toBe(1);

    a.status("exited with code 0", true);
    expect(shown.at(-1)![0]!.done).toBe(true);
    bridge.show("s2");
    expect(shown.at(-1)!.map((j) => j.title)).toEqual(["elsewhere"]);
    bridge.show("s1");
    a.dispose();
    expect(shown.at(-1)).toEqual([]);
    // 去掉之后再更新不会让它回来
    a.status("late");
    expect(shown.at(-1)).toEqual([]);
  });

  test("a job's output line can carry a detail; when old output is dropped, the line numbers follow", async () => {
    const { screen } = fakeScreen();
    const shown: JobInfo[][] = [];
    screen.jobs = (jobs) => void shown.push(jobs);
    const bridge = new ScreenBridge();
    bridge.attach(screen);
    bridge.show("s1");
    const job = bridge.ui.job!({ session: "s1", kind: "agent", title: "look" });
    job.append("● read_file(a.ts)\n");
    job.append("  ⎿ line 1 (+2 lines)\n", "line 1\nline 2\nline 3");
    job.append("said\n\n");
    job.append("  ⎿ two\nrows\n", { text: "full", style: "dim" });
    await Bun.sleep(150);
    const details = shown.at(-1)![0]!.details!;
    expect(details.map((d) => d.line)).toEqual([1, 5]);
    expect(details[0]!.text).toBe("line 1\nline 2\nline 3");
    expect(details[1]!.text).toContain("full");
    // 输出超出上限，开头的行去掉了：行号跟着往前挪，挂在去掉的行上的不要了
    job.append(`${"x".repeat(100_000 - 20)}\n`);
    await Bun.sleep(150);
    const after = shown.at(-1)![0]!;
    const lines = after.output.split("\n");
    expect(after.details!.map((d) => d.line)).toEqual([lines.indexOf("rows")]);
  });
});
