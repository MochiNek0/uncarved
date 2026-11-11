// jade/screenshot：用无头浏览器截图。工具的测试里浏览器换成假的（交回一张 PNG 的 capture）；
// 本机有浏览器时另外用真的浏览器验证视口宽度和滚动（browser.ts）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool, ToolResult } from "uncarved";
import { findBrowser, screenshotTool } from "../plugins/screenshot/tool.ts";
import { capture as realCapture, CaptureError, type Capture, type CaptureRequest, type Shot } from "../plugins/screenshot/browser.ts";
import { cleanup, say, scriptedHost } from "./scripted-ui.ts";

/** 1x1 的 PNG */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

let tmp: string[] = [];
afterEach(async () => {
  await cleanup();
  // Windows 上浏览器主进程退出后，子进程还会锁住 profile 一小会儿
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10 });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "jade-shot-test-"));
  tmp.push(d);
  return d;
}

/** 假的浏览器：记下每次截图的请求，交回一张 PNG */
function fakeBrowser(shot: Partial<Shot> = {}) {
  const calls: CaptureRequest[] = [];
  const capture: Capture = async (_browser, req) => {
    calls.push(req);
    return { png: PNG, pageHeight: req.height, scrollY: 0, ...shot };
  };
  return { calls, capture };
}

const exec = (tools: Tool[], name: string, input: unknown): Promise<ToolResult> => {
  const tool = tools.find((t) => t.name === name)!;
  return tool.execute(input, { signal: new AbortController().signal } as never);
};

describe("screenshot tool", () => {
  test("renders a local file at the requested size and returns a PNG", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "page.html"), "<h1>hi</h1>");
    const { calls, capture } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", capture })!;
    const r = await exec([tool], "screenshot", { path: "page.html", width: 400, height: 300 });
    expect(r.isError).toBeFalsy();
    const content = r.content as { kind: string; text?: string; source?: { media_type: string; data: string } }[];
    expect(content[0]!.text).toBe("Screenshot of page.html at 400x300:");
    expect(content[1]!.kind).toBe("image");
    expect(content[1]!.source!.media_type).toBe("image/png");
    expect(content[1]!.source!.data).toBe(PNG.toString("base64"));
    // 交给浏览器的：视口大小、新的临时用户目录，目标是 file:// URL
    expect(calls[0]).toMatchObject({ width: 400, height: 300 });
    expect(calls[0]!.scrollTo).toBeUndefined();
    expect(calls[0]!.profile).toContain("jade-shot-");
    expect(calls[0]!.target).toStartWith("file://");
    expect(calls[0]!.target).toContain("page.html");
  });

  test("scroll_to is passed on, and the result says which part of a long page is shown", async () => {
    const cwd = await dir();
    const { calls, capture } = fakeBrowser({ pageHeight: 5000, scrollY: 3100, scrolledTo: '<h2> "Trusted by"' });
    const tool = screenshotTool({ cwd, browser: "chrome", capture })!;
    const r = await exec([tool], "screenshot", { url: "http://localhost:3000/", width: 390, height: 900, scroll_to: "Trusted by" });
    expect(calls[0]!.scrollTo).toBe("Trusted by");
    expect((r.content as { text?: string }[])[0]!.text).toBe(
      'Screenshot of http://localhost:3000/ at 390x900: The page is 5000px tall; this shows y=3100–4000, scrolled to <h2> "Trusted by".',
    );

    // 页面没加载完时照样给截图，并说明
    const note = "The page had not finished loading after 15s; this is how it looked at that point.";
    const slow = screenshotTool({ cwd, browser: "chrome", capture: fakeBrowser({ note }).capture })!;
    const s = await exec([slow], "screenshot", { url: "http://localhost:3000/" });
    expect(s.isError).toBeFalsy();
    expect((s.content as { text?: string }[])[0]!.text).toBe(`Screenshot of http://localhost:3000/ at 1280x800: ${note}`);
  });

  test("fetches a URL, and rejects bad input", async () => {
    const cwd = await dir();
    const { calls, capture } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", capture })!;
    await exec([tool], "screenshot", { url: "http://localhost:3000/" });
    expect(calls[0]!.target).toBe("http://localhost:3000/");

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
    const { calls, capture } = fakeBrowser();
    const tool = screenshotTool({ cwd, browser: "chrome", capture, available: () => false })!;
    const r = await exec([tool], "screenshot", { path: "page.html" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("JADE_VISION is off");
    expect(calls).toHaveLength(0);
  });

  test("reports why the capture failed, and a browser that cannot start", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "page.html"), "x");
    const failing = screenshotTool({ cwd, browser: "chrome", capture: async () => Promise.reject(new CaptureError('nothing on the page matches scroll_to "#x"')) })!;
    const r = await exec([failing], "screenshot", { path: "page.html", scroll_to: "#x" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe('nothing on the page matches scroll_to "#x"');

    const broken = screenshotTool({ cwd, browser: "chrome", capture: async () => Promise.reject(new Error("ENOENT")) })!;
    expect((await exec([broken], "screenshot", { path: "page.html" })).content).toContain("could not start the browser (chrome): ENOENT");
  });

  test("no browser means no tool", () => {
    expect(screenshotTool({ cwd: os.tmpdir(), browser: undefined, env: { JADE_BROWSER: path.join(os.tmpdir(), "nope", "nope") } })).toBeUndefined();
    // JADE_BROWSER 指向一个存在的文件时就用它
    expect(findBrowser({ JADE_BROWSER: process.execPath })).toBe(process.execPath);
  });
});

// 真的浏览器：本机没有时跳过
const browser = findBrowser(process.env);
describe.skipIf(!browser)("capture with a real browser", () => {
  const shoot = async (html: string, req: Partial<CaptureRequest>) => {
    const d = await dir();
    await writeFile(path.join(d, "page.html"), html);
    return realCapture(
      browser!,
      { target: pathToFileURL(path.join(d, "page.html")).href, width: 390, height: 600, profile: path.join(d, "profile"), ...req },
      new AbortController().signal,
    );
  };

  test("a narrow viewport is laid out at the width given, not at the browser window's minimum", async () => {
    // 页面把自己的高度设成 innerWidth 的 10 倍：按 500px 排版时会是 5000
    const shot = await shoot(`<body style="margin:0"><script>document.body.style.height = innerWidth * 10 + "px"</script>`, {});
    expect(shot.pageHeight).toBe(3900);
    // PNG 头里的宽高
    expect([shot.png.readUInt32BE(16), shot.png.readUInt32BE(20)]).toEqual([390, 600]);
    expect(shot.note).toBeUndefined();
  }, 30_000);

  test("scroll_to finds an element by selector or by text; nothing matching is an error", async () => {
    const html = `<body style="margin:0"><div style="height:2000px"></div><h2 id="t" style="margin:0;height:40px">Trusted by leaders</h2><div style="height:2000px"></div>`;
    const bySelector = await shoot(html, { scrollTo: "#t" });
    // 元素放在视口中间：2000 + 20 - 300
    expect(bySelector.scrollY).toBe(1720);
    expect(bySelector.scrolledTo).toBe('<h2> "Trusted by leaders"');
    expect(bySelector.pageHeight).toBe(4040);
    expect((await shoot(html, { scrollTo: "Trusted by" })).scrollY).toBe(1720);
    expect(shoot(html, { scrollTo: "no such thing" })).rejects.toThrow('nothing on the page matches scroll_to "no such thing"');
  }, 60_000);
});

describe("screenshot in requests", () => {
  const saved = process.env.JADE_BROWSER;
  afterEach(() => {
    if (saved === undefined) delete process.env.JADE_BROWSER;
    else process.env.JADE_BROWSER = saved;
  });

  test("a model that cannot see images is offered neither the tool nor the note; switching models brings them back", async () => {
    // 会话开始时要找得到浏览器，工具才会注册；随便指向一个存在的可执行文件
    process.env.JADE_BROWSER = process.execPath;
    const { host, shared, send } = await scriptedHost();
    shared.current = { ...shared.current!, vision: false };
    shared.script.push(say("one"), say("two"));
    const s = await host.sessions.open();
    const system = (i: number) => shared.requests[i]!.system.map((x) => x.text).join("\n");
    const tools = (i: number) => shared.requests[i]!.tools.map((t) => t.name);

    await send(s, "look at the page");
    expect(tools(0)).not.toContain("screenshot");
    expect(system(0)).not.toContain("take a screenshot");

    // 换成能看图的模型（/model），下一次请求就有
    shared.current = { ...shared.current!, vision: true };
    await send(s, "again");
    expect(tools(1)).toContain("screenshot");
    expect(system(1)).toContain("take a screenshot");
  });
});
