// jade/screenshot：用无头浏览器截图。浏览器换成假的：测试里传给工具的是"启动后写出一个 PNG"的 spawn。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult } from "uncarved";
import { findBrowser, screenshotTool } from "../plugins/screenshot/tool.ts";
import type { Proc } from "../plugins/screenshot/sys.ts";

/** 1x1 的 PNG */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "jade-shot-test-"));
  tmp.push(d);
  return d;
}

/** 假的浏览器：记下命令行，把 --screenshot= 指向的文件写出来 */
function fakeBrowser(opts: { write?: boolean } = {}) {
  const calls: string[][] = [];
  const spawn = async (cmd: string[]): Promise<Proc> => {
    calls.push(cmd);
    const flag = cmd.find((a) => a.startsWith("--screenshot="));
    if (opts.write !== false && flag) await writeFile(flag.slice("--screenshot=".length), PNG);
    return { pid: 1, exited: Promise.resolve(0), kill: () => {} };
  };
  return { calls, spawn };
}

const exec = (tools: Tool[], name: string, input: unknown): Promise<ToolResult> => {
  const tool = tools.find((t) => t.name === name)!;
  return tool.execute(input, { signal: new AbortController().signal } as never);
};

describe("screenshot tool", () => {
  test("renders a local file at the requested size and returns a PNG", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "page.html"), "<h1>hi</h1>");
    const { calls, spawn } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", spawn })!;
    const r = await exec([tool], "screenshot", { path: "page.html", width: 400, height: 300 });
    expect(r.isError).toBeFalsy();
    const content = r.content as { kind: string; text?: string; source?: { media_type: string; data: string } }[];
    expect(content[0]!.text).toBe("Screenshot of page.html at 400x300:");
    expect(content[1]!.kind).toBe("image");
    expect(content[1]!.source!.media_type).toBe("image/png");
    expect(content[1]!.source!.data).toBe(PNG.toString("base64"));
    // 浏览器的参数：新的临时用户目录、窗口大小、结算时间，目标是 file:// URL
    expect(calls[0]).toContain("--headless=new");
    expect(calls[0]).toContain("--window-size=400,300");
    expect(calls[0]!.at(-1)).toStartWith("file://");
    expect(calls[0]!.at(-1)).toContain("page.html");
  });

  test("fetches a URL, and rejects bad input", async () => {
    const cwd = await dir();
    const { calls, spawn } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", spawn })!;
    await exec([tool], "screenshot", { url: "http://localhost:3000/" });
    expect(calls[0]!.at(-1)).toBe("http://localhost:3000/");

    expect((await exec([tool], "screenshot", {})).content).toContain("exactly one of path or url");
    expect((await exec([tool], "screenshot", { path: "a", url: "http://x/" })).content).toContain("exactly one of path or url");
    expect((await exec([tool], "screenshot", { url: "file:///etc/passwd" })).content).toContain("only http and https");
    expect((await exec([tool], "screenshot", { url: "nonsense" })).content).toContain("invalid URL");
    expect((await exec([tool], "screenshot", { path: "missing.html" })).content).toContain("file not found");
    expect((await exec([tool], "screenshot", { path: "page.html", width: 10 })).content).toContain("between 100 and 4000");
  });

  test("a model that cannot see images gets an explanation instead of a screenshot", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "page.html"), "x");
    const { calls, spawn } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", spawn, available: () => false })!;
    const r = await exec([tool], "screenshot", { path: "page.html" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("JADE_VISION is off");
    expect(calls).toHaveLength(0);
  });

  test("reports a browser that writes nothing, and one that cannot start", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "page.html"), "x");
    const silent = screenshotTool({ cwd, browser: "chrome", spawn: fakeBrowser({ write: false }).spawn })!;
    expect((await exec([silent], "screenshot", { path: "page.html" })).content).toContain("without writing a screenshot");

    const broken = screenshotTool({ cwd, browser: "chrome", spawn: async () => Promise.reject(new Error("ENOENT")) })!;
    expect((await exec([broken], "screenshot", { path: "page.html" })).content).toContain("could not start the browser (chrome): ENOENT");
  });

  test("no browser means no tool", () => {
    expect(screenshotTool({ cwd: os.tmpdir(), browser: undefined, env: { JADE_BROWSER: path.join(os.tmpdir(), "nope", "nope") } })).toBeUndefined();
    // JADE_BROWSER 指向一个存在的文件时就用它
    expect(findBrowser({ JADE_BROWSER: process.execPath })).toBe(process.execPath);
  });
});
