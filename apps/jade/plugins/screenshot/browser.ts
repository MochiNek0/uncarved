// 用 DevTools 协议（CDP）让无头浏览器截一张图。
//
// 不用命令行的 --window-size + --screenshot：Windows 上浏览器窗口最窄 500px，要 390 宽时页面仍按 500 排版，
// 只截到左边 390px，看起来像内容被裁掉；也不能滚动到页面中间的某一段，页面一直不"加载完"时只有一句超时。
// 这里用 Emulation.setDeviceMetricsOverride 设视口（多窄都按给的宽度排版），可以先滚动到某个元素再截，
// 页面迟迟不触发 load 时照样截下当时的样子并说明。
//
// 连接用 --remote-debugging-port=0 加 WebSocket（Bun 和 Node ≥22 都有全局的 WebSocket）；
// --remote-debugging-pipe 在 Bun 下收不到数据。端口只监听本机，用完就连同临时用户目录一起关掉。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type Proc } from "./sys.ts";

/** 浏览器启动到能连接的最长时间 */
const READY_MS = 10_000;
/** 等页面 load 事件的最长时间；到时间还没有就按当时的样子截 */
const LOAD_MS = 15_000;
/** load 之后等网络安静下来（脚本、图片、字体）的最长时间 */
const SETTLE_MS = 3000;
/** 让浏览器自己关的最长时间，过了就直接结束进程 */
const CLOSE_MS = 5000;
/** 滚动之后给懒加载的图片、滚动触发的动画的时间 */
const SCROLL_SETTLE_MS = 400;

export interface CaptureRequest {
  /** file:// 或 http(s):// */
  target: string;
  width: number;
  height: number;
  /** CSS 选择器，或页面上出现的一段文字：先滚动到它再截 */
  scrollTo?: string;
  /** 浏览器的用户目录：每次给一个新的临时目录 */
  profile: string;
}

export interface Shot {
  png: Buffer;
  /** 整个页面的高度和截到的是哪一段 */
  pageHeight: number;
  scrollY: number;
  /** 滚动到的元素，例如 <h2> "Trusted by…" */
  scrolledTo?: string;
  /** 截图不是页面完全加载后的样子时的说明 */
  note?: string;
}

/** 截图失败、原因可以直接告诉模型的错误 */
export class CaptureError extends Error {}

export type Capture = (browser: string, req: CaptureRequest, signal: AbortSignal) => Promise<Shot>;

interface Cdp {
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>;
  /** 等一个事件；已经来过的也算。到时间还没有返回 false */
  seen(method: string, ms: number): Promise<boolean>;
  close(): void;
}

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 0;
    let closed = false;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const events = new Set<string>();
    const listeners = new Set<(method: string) => void>();
    ws.onerror = () => reject(new CaptureError("could not connect to the browser"));
    ws.onclose = () => {
      closed = true;
      for (const w of waiting.values()) w.reject(new CaptureError("the browser closed before the screenshot was taken"));
      waiting.clear();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; result?: unknown; error?: { message: string } };
      if (m.id !== undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.reject(new CaptureError(m.error.message));
        else w?.resolve(m.result);
      } else if (m.method) {
        // Page.lifecycleEvent 的名字在参数里：load、networkIdle……
        const name = m.method === "Page.lifecycleEvent" ? `lifecycle:${(m as { params?: { name?: string } }).params?.name}` : m.method;
        events.add(name);
        for (const l of listeners) l(name);
      }
    };
    ws.onopen = () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            if (closed) return rej(new CaptureError("the browser closed before the screenshot was taken"));
            const id = ++next;
            waiting.set(id, { resolve: res as (v: unknown) => void, reject: rej });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
          }),
        seen: (method, ms) =>
          new Promise((res) => {
            if (events.has(method)) return res(true);
            const done = (ok: boolean) => {
              clearTimeout(timer);
              listeners.delete(l);
              res(ok);
            };
            const l = (name: string) => name === method && done(true);
            const timer = setTimeout(() => done(false), ms);
            listeners.add(l);
          }),
        close: () => ws.close(),
      });
  });
}

/** 浏览器把调试端口和连接路径写在用户目录的 DevToolsActivePort 里；等它出现 */
async function debuggerUrl(profile: string, proc: Proc, signal: AbortSignal): Promise<string> {
  let exited = false;
  void proc.exited.then(() => (exited = true));
  const deadline = Date.now() + READY_MS;
  for (;;) {
    signal.throwIfAborted();
    try {
      const [port, wsPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch {
      // 还没写出来
    }
    if (exited) throw new CaptureError("the browser exited before it was ready");
    if (Date.now() > deadline) throw new CaptureError(`the browser was not ready within ${READY_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * 在页面里执行：滚动到 CSS 选择器匹配的第一个元素；选择器无效或没有匹配时，找第一个包含这段文字的元素。
 * 比视口高的元素对齐到顶部，其余的放在中间
 */
const SCROLL = (what: string) => `(() => {
  const what = ${JSON.stringify(what)};
  let el = null;
  try { el = document.querySelector(what); } catch {}
  if (!el) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes(what) && n.parentElement && n.parentElement.getClientRects().length) { el = n.parentElement; break; }
    }
  }
  if (!el) return null;
  el.scrollIntoView({ block: el.getBoundingClientRect().height > innerHeight ? "start" : "center", behavior: "instant" });
  const text = (el.textContent || "").trim().replace(/\\s+/g, " ");
  return "<" + el.tagName.toLowerCase() + ">" + (text ? ' "' + (text.length > 40 ? text.slice(0, 40) + "…" : text) + '"' : "");
})()`;

const METRICS = "JSON.stringify({ h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), y: Math.round(scrollY) })";

export const capture: Capture = async (browser, req, signal) => {
  const proc = await spawn(
    [
      browser,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${req.profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  // 中止（用户打断、总的超时）时不等页面：下面的等待都按自己的时间走，这里直接结束
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => (abort = () => reject(signal.reason)));
  signal.addEventListener("abort", abort, { once: true });
  let cdp: Cdp | undefined;
  const work = async (): Promise<Shot> => {
    cdp = await connect(await debuggerUrl(req.profile, proc, signal));
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = <T>(method: string, params?: object) => cdp!.send<T>(method, params, sessionId);
    const evaluate = async <T>(expression: string) => (await page<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true })).result.value;

    await page("Emulation.setDeviceMetricsOverride", { width: req.width, height: req.height, deviceScaleFactor: 1, mobile: false });
    await page("Page.enable");
    await page("Page.setLifecycleEventsEnabled", { enabled: true });
    const { errorText } = await page<{ errorText?: string }>("Page.navigate", { url: req.target });
    if (errorText) throw new CaptureError(`the page could not be loaded: ${errorText}`);
    const loaded = await cdp.seen("Page.loadEventFired", LOAD_MS);
    if (loaded) await cdp.seen("lifecycle:networkIdle", SETTLE_MS);
    signal.throwIfAborted();

    let scrolledTo: string | undefined;
    if (req.scrollTo !== undefined) {
      const found = await evaluate<string | null>(SCROLL(req.scrollTo));
      if (found === null) {
        throw new CaptureError(
          `nothing on the page matches scroll_to ${JSON.stringify(req.scrollTo)} (tried as a CSS selector, then as text)` +
            (loaded ? "" : `; the page had not finished loading after ${LOAD_MS / 1000}s`),
        );
      }
      scrolledTo = found;
      await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
    }
    const { h, y } = JSON.parse(await evaluate<string>(METRICS)) as { h: number; y: number };
    const { data } = await page<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return {
      png: Buffer.from(data, "base64"),
      pageHeight: h,
      scrollY: y,
      scrolledTo,
      note: loaded ? undefined : `The page had not finished loading after ${LOAD_MS / 1000}s; this is how it looked at that point.`,
    };
  };
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
    // 先让浏览器自己关：直接结束主进程时，Windows 上它的子进程还会占着 profile 好几秒，临时目录删不掉
    if (cdp) {
      void cdp.send("Browser.close").catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([proc.exited, new Promise((r) => (timer = setTimeout(r, CLOSE_MS)))]);
      clearTimeout(timer);
      cdp.close();
    }
    proc.kill();
    await proc.exited;
  }
};
