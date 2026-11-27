// jade/computer：驱动换成假的，记下每个动作；真的 Windows 驱动要桌面会话，不在这里测。

import { describe, expect, test } from "bun:test";
import type { ToolResult } from "uncarved";
import { computerTool, parseKeys } from "../plugins/computer/tool.ts";
import { StoppedError, type Driver } from "../plugins/computer/windows.ts";

/** 屏幕 2560x1440，截图缩成 1280x720：坐标乘 2 */
function fakeDriver(opts: { stop?: boolean; stopOnType?: boolean } = {}) {
  const calls: string[] = [];
  const driver: Driver = {
    async screenshot(maxSide) {
      calls.push(`shot ${maxSide}`);
      return { png: Buffer.from("png"), width: 2560, height: 1440, shotWidth: 1280, shotHeight: 720 };
    },
    async click(x, y, button, count) {
      if (opts.stop) throw new StoppedError("stopped");
      calls.push(`click ${x} ${y} ${button} ${count}`);
    },
    async type(text) {
      if (opts.stopOnType) throw new StoppedError("stopped");
      calls.push(`type ${text}`);
    },
    async key(vks) {
      calls.push(`key ${vks.join(",")}`);
    },
    async scroll(x, y, n) {
      calls.push(`scroll ${x} ${y} ${n}`);
    },
    close() {},
  };
  return { calls, driver };
}

function setup(opts: { stop?: boolean; stopOnType?: boolean; available?: boolean } = {}) {
  const { calls, driver } = fakeDriver(opts);
  const tool = computerTool({ driver: () => driver, available: () => opts.available ?? true, settleMs: 0 });
  const run = (input: unknown): Promise<ToolResult> => tool.execute(input, { signal: new AbortController().signal } as never);
  return { calls, run, tool };
}

const firstText = (r: ToolResult) => (typeof r.content === "string" ? r.content : (r.content[0] as { text: string }).text);

describe("computer tool", () => {
  test("is an exclusive external tool", () => {
    const { tool } = setup();
    expect(tool.effect).toBe("external");
    expect(tool.concurrency).toBe("exclusive");
  });

  test("screenshot returns the downscaled image", async () => {
    const { calls, run } = setup();
    const r = await run({ action: "screenshot" });
    expect(r.isError).toBeFalsy();
    expect(firstText(r)).toBe("Screenshot. Screen now (1280x720):");
    expect((r.content as { kind: string }[])[1]!.kind).toBe("image");
    expect(calls).toEqual(["shot 1280"]);
  });

  test("clicks map screenshot coordinates to the screen and return a new screenshot", async () => {
    const { calls, run } = setup();
    await run({ action: "screenshot" });
    const r = await run({ action: "click", x: 100, y: 50, clicks: 2 });
    expect(r.isError).toBeFalsy();
    expect(firstText(r)).toBe("Done: clicked left x2 at (100, 50). Screen now (1280x720):");
    expect(calls).toEqual(["shot 1280", "click 200 100 left 2", "shot 1280"]);
  });

  test("a click before any screenshot does nothing and hands over a screenshot", async () => {
    const { calls, run } = setup();
    const r = await run({ action: "click", x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain("Nothing was done yet");
    expect(calls).toEqual(["shot 1280"]);
  });

  test("coordinates outside the screenshot are rejected", async () => {
    const { calls, run } = setup();
    await run({ action: "screenshot" });
    const r = await run({ action: "click", x: 1280, y: 10 });
    expect(r.isError).toBe(true);
    expect(calls).toEqual(["shot 1280"]);
  });

  test("type, key and scroll", async () => {
    const { calls, run } = setup();
    await run({ action: "screenshot" });
    await run({ action: "type", text: "hi\n" });
    await run({ action: "key", keys: "ctrl+shift+t" });
    await run({ action: "scroll", x: 10, y: 20, amount: -3 });
    expect(calls.filter((c) => !c.startsWith("shot"))).toEqual(["type hi\n", "key 17,16,84", "scroll 20 40 -3"]);
  });

  test("bad arguments are rejected before touching the screen", async () => {
    const { calls, run } = setup();
    for (const input of [{}, { action: "drag" }, { action: "type" }, { action: "key", keys: "ctrl+nope" }, { action: "click", x: 1, y: 1, clicks: 4 }, { action: "scroll", x: 1, y: 1 }, { action: "wait", ms: 20_000 }, { actions: [] }, { action: "key", keys: "a", actions: [{ action: "key", keys: "b" }] }, { actions: [{ action: "screenshot" }] }]) {
      expect((await run(input)).isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("a list of actions runs in order and returns one screenshot at the end", async () => {
    const { calls, run } = setup();
    const r = await run({
      actions: [
        { action: "key", keys: "win" },
        { action: "type", text: "notepad" },
        { action: "key", keys: "enter" },
        { action: "wait", ms: 1 },
        { action: "type", text: "hello" },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(firstText(r)).toBe("Done: pressed win, typed 7 characters, pressed enter, waited 1 ms, typed 5 characters. Screen now (1280x720):");
    expect(calls).toEqual(["key 91", "type notepad", "key 13", "type hello", "shot 1280"]);
  });

  test("a bad step rejects the whole list before anything runs", async () => {
    const { calls, run } = setup();
    await run({ action: "screenshot" });
    const r = await run({ actions: [{ action: "type", text: "a" }, { action: "click", x: 5000, y: 1 }] });
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain("step 2:");
    const r2 = await run({ actions: [{ action: "type", text: "a" }, { action: "key", keys: "nope" }] });
    expect(firstText(r2)).toBe("step 2: unknown keys: nope");
    expect(calls).toEqual(["shot 1280"]);
  });

  test("stopping in the middle of a list says what was done", async () => {
    const { calls, run } = setup({ stopOnType: true });
    const r = await run({ actions: [{ action: "key", keys: "win" }, { action: "type", text: "x" }, { action: "key", keys: "enter" }] });
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain("Done before that: pressed win.");
    expect(calls).toEqual(["key 91"]);
  });

  test("the user moving the mouse to the corner stops it", async () => {
    const { run } = setup({ stop: true });
    await run({ action: "screenshot" });
    const r = await run({ action: "click", x: 1, y: 1 });
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain("The user stopped computer use");
  });

  test("does nothing when the model cannot see images", async () => {
    const { calls, run } = setup({ available: false });
    expect((await run({ action: "screenshot" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("parseKeys", () => {
  test("names, letters, digits and function keys", () => {
    expect(parseKeys("enter")).toEqual([0x0d]);
    expect(parseKeys("Ctrl+C")).toEqual([0x11, 0x43]);
    expect(parseKeys("alt+f4")).toEqual([0x12, 0x73]);
    expect(parseKeys("f24")).toEqual([0x87]);
    expect(parseKeys("win+1")).toEqual([0x5b, 0x31]);
    expect(parseKeys("ctrl+")).toBeUndefined();
    expect(parseKeys("f25")).toBeUndefined();
  });
});
