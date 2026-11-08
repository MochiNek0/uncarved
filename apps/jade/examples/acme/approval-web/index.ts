// acme/approval-web：网页审批渠道。jade 要问人时，问题同时出现在终端和一个网页上（手机也能打开），先回答的算数。
//
// 经 approval@1.addApprover 登记，所以和终端是平等的两个渠道：网页上点了，终端的问题自动消失；终端先答了，
// 网页上的那条也消失。回答带 by（"web:<页面上填的名字>"），jade/approval 把它和渠道（本插件 id）记进日志，审计报告里看得到。
//
// 安全：链接里带一个随机 token，没有它什么都看不到、什么也批不了；默认只听 127.0.0.1，
// 要让手机打开得把 host 设成 0.0.0.0（同一个网络里拿到链接的人都能批准，演示用；正式用请换成公司的 IM 或审批系统）。
// 页面只用 textContent 显示命令和参数：它们来自模型，不能当 HTML。
//
// 只用类型导入，不依赖 jade 的运行时代码：装到任何地方都能加载。

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import type { PluginModule, UI } from "../../../src/api.ts";
import type { Answer, Approval, ApprovalCall, ApprovalRequest } from "../../../plugins/approval/index.ts";
import type { Commands } from "../../../plugins/commands/index.ts";

const ANSWERS: readonly string[] = ["once", "always", "deny"] satisfies Answer[];
const MAX_BODY = 4096;
const MAX_NAME = 60;

/** 页面看到的一条待审批 */
interface Pending {
  id: string;
  title: string;
  detail?: string;
  options: { label: string; value: Answer }[];
  call: ApprovalCall;
  since: string;
}

/** 本进程里页面的链接；监听失败时是 failure。第一个会话打开时告诉用户一次（announced） */
let url: string | undefined;
let lanUrls: string[] = [];
let failure: string | undefined;
let announced = false;

export default {
  async process(ctx) {
    url = failure = undefined;
    lanUrls = [];
    announced = false;
    const pending = new Map<string, { item: Pending; answer: (a: { answer: Answer; by: string }) => void }>();
    const token = typeof ctx.config.token === "string" && ctx.config.token ? ctx.config.token : randomBytes(18).toString("base64url");
    const host = typeof ctx.config.host === "string" && ctx.config.host ? ctx.config.host : "127.0.0.1";
    const port = typeof ctx.config.port === "number" ? ctx.config.port : 7788;
    let next = 0;

    const authorized = (req: IncomingMessage, u: URL) => {
      const given = Buffer.from(u.searchParams.get("token") ?? req.headers["x-token"]?.toString() ?? "");
      const want = Buffer.from(token);
      return given.length === want.length && timingSafeEqual(given, want);
    };

    const server = createServer((req, res) => {
      void handle(req, res).catch(() => send(res, 500, "text/plain", "error"));
    });
    async function handle(req: IncomingMessage, res: ServerResponse) {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (!authorized(req, u)) return send(res, 403, "text/plain", "forbidden: open the link jade printed, with its token");
      if (req.method === "GET" && u.pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && u.pathname === "/api/pending") return send(res, 200, "application/json", JSON.stringify([...pending.values()].map((p) => p.item)));
      if (req.method === "POST" && u.pathname === "/api/answer") {
        const body = JSON.parse(await readBody(req)) as { id?: unknown; answer?: unknown; name?: unknown };
        const p = typeof body.id === "string" ? pending.get(body.id) : undefined;
        if (!p) return send(res, 404, "application/json", JSON.stringify({ error: "already answered or withdrawn" }));
        if (typeof body.answer !== "string" || !ANSWERS.includes(body.answer)) return send(res, 400, "application/json", JSON.stringify({ error: "bad answer" }));
        const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
        if (!name) return send(res, 400, "application/json", JSON.stringify({ error: "fill in your name first" }));
        pending.delete(body.id as string);
        p.answer({ answer: body.answer as Answer, by: `web:${name}` });
        return send(res, 200, "application/json", JSON.stringify({ ok: true }));
      }
      return send(res, 404, "text/plain", "not found");
    }

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
    } catch (err) {
      failure = `cannot listen on ${host}:${port} (${(err as Error).message}); set another port in {"acme/approval-web": {"port": …}}`;
      return;
    }
    await ctx.effect(() => () => {
      server.close();
      server.closeAllConnections();
    });
    const actual = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${actual}/?token=${token}`;
    lanUrls = host === "0.0.0.0" || host === "::" ? lanAddresses().map((ip) => `http://${ip}:${actual}/?token=${token}`) : [];

    ctx.require<Approval>("approval@1").addApprover((request: ApprovalRequest, signal) => {
      const id = String(++next);
      return new Promise((resolve) => {
        const done = () => {
          pending.delete(id);
          resolve(undefined);
        };
        // 终端或别的渠道先答了、超时了：撤回这条
        if (signal.aborted) return done();
        signal.addEventListener("abort", done, { once: true });
        pending.set(id, {
          item: { id, title: request.title, detail: request.detail, options: request.options, call: request.call, since: new Date().toISOString() },
          answer: (a) => {
            signal.removeEventListener("abort", done);
            resolve(a);
          },
        });
      });
    });

    ctx.service<Commands>("commands@1")?.register({
      name: "approvals",
      description: "the link of the web page where approvals can also be answered",
      instant: true,
      run: () => links(),
    });
  },

  session(ctx) {
    // 第一个会话打开时告诉用户链接（process 里可能还拿不到 ui@1）
    const ui = ctx.service<UI>("ui@1");
    if (failure) ui?.notify(`acme/approval-web: ${failure}`, "warning");
    else if (url && !announced) ui?.notify(links(), "info");
    announced = true;
  },
} satisfies PluginModule;

function links(): string {
  if (failure) return `acme/approval-web: ${failure}`;
  const [lan, ...others] = lanUrls;
  return [
    `Approvals can also be answered at ${url}`,
    ...(lan ? [`  from a phone on this network: ${lan}`] : []),
    ...(others.length > 0 ? [`  other addresses: ${others.map((u) => new URL(u).hostname).join(", ")}`] : []),
  ].join("\n");
}

/**
 * 手机能连上的地址，最可能的排前面：家里和公司的局域网（192.168、10、172.16–31），然后是 Tailscale 这类 100.64/10。
 * 198.18/15 是代理软件（Clash 等 TUN 模式）的虚拟网卡、169.254 是没拿到地址的网卡，手机连不上，不要
 */
export function lanAddresses(nets: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const rank = (ip: string): number | undefined => {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 198 && (b === 18 || b === 19)) return undefined;
    if (a === 169 && b === 254) return undefined;
    if (a === 192 && b === 168) return 0;
    if (a === 10) return 1;
    if (a === 172 && b >= 16 && b <= 31) return 2;
    if (a === 100 && b >= 64 && b <= 127) return 3;
    return 4;
  };
  const found: { ip: string; rank: number }[] = [];
  for (const list of Object.values(nets)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const r = rank(a.address);
      if (r !== undefined) found.push({ ip: a.address, rank: r });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map((f) => f.ip);
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jade approvals</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1d2125; --muted: #66707a; --line: #dde1e6; --code: #f0f2f5;
          --ok: #1f7a4d; --ok-text: #fff; --no: #b3261e; --no-text: #fff; --warn: #8a5a00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15181c; --card: #1e2227; --text: #e6e8eb; --muted: #9aa3ad; --line: #30363d; --code: #262b31;
            --ok: #3fb27f; --ok-text: #0b1f15; --no: #f2766d; --no-text: #2a0d0b; --warn: #e3b341; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 18px; margin: 4px 0 12px; }
  .who { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; color: var(--muted); }
  .who input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; }
  .empty { color: var(--muted); text-align: center; padding: 48px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
  .title { font-weight: 600; font-size: 16px; }
  .meta { color: var(--muted); font-size: 13px; margin: 2px 0 10px; overflow-wrap: anywhere; }
  .review { color: var(--warn); font-size: 13px; margin-bottom: 8px; }
  pre { background: var(--code); border-radius: 8px; padding: 10px; margin: 0 0 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, Consolas, monospace; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { flex: 1 1 140px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
  button.once { background: var(--ok); color: var(--ok-text); border-color: var(--ok); }
  button.deny { background: var(--no); color: var(--no-text); border-color: var(--no); }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: var(--no); font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>jade approvals</h1>
  <label class="who">Your name <input id="name" autocomplete="name" placeholder="e.g. li.si (recorded in the audit log)"></label>
  <div id="list"><div class="empty">Loading…</div></div>
</main>
<script>
  // 只用老浏览器也有的写法（ES5、XMLHttpRequest、appendChild）：手机上常用微信、QQ 等 App 里的内置浏览器打开，
  // 它们的内核可能很旧，用了新 API 页面会停在 Loading。脚本出错时把原因显示在页面上，而不是卡住
  var list = document.getElementById("list");
  var nameInput = document.getElementById("name");
  var shown = "";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function show(nodes) {
    while (list.firstChild) list.removeChild(list.firstChild);
    for (var i = 0; i < nodes.length; i++) list.appendChild(nodes[i]);
  }
  window.onerror = function (message) {
    show([el("div", "empty", "Page error: " + message)]);
    shown = "";
  };

  var match = /[?&]token=([^&]*)/.exec(location.search);
  var token = match ? decodeURIComponent(match[1]) : "";
  try { nameInput.value = window.localStorage.getItem("jade-approver-name") || ""; } catch (e) {}
  nameInput.addEventListener("input", function () {
    try { window.localStorage.setItem("jade-approver-name", nameInput.value); } catch (e) {}
  });

  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader("x-token", token);
    if (body) xhr.setRequestHeader("content-type", "application/json");
    xhr.timeout = 10000;
    xhr.onload = function () {
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = undefined; }
      done(xhr.status, data, xhr.responseText);
    };
    xhr.onerror = xhr.ontimeout = function () { done(0, undefined, "network error"); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  function refresh() {
    request("GET", "/api/pending", null, function (status, items, text) {
      if (status !== 200 || !items) {
        show([el("div", "empty", "Cannot reach jade: " + (status ? status + " " : "") + text)]);
        shown = "";
        return;
      }
      var key = items.map(function (i) { return i.id; }).join(",");
      if (key === shown) return;
      shown = key;
      if (items.length === 0) {
        show([el("div", "empty", "Connected. Nothing is waiting for approval: when jade asks before running something, it shows up here.")]);
        return;
      }
      show(items.map(card));
    });
  }

  function card(item) {
    var c = el("div", "card");
    c.appendChild(el("div", "title", item.title));
    c.appendChild(el("div", "meta", item.call.cwd + " · " + item.call.effect + " · mode " + item.call.mode + " · " + new Date(item.since).toLocaleTimeString()));
    if (item.call.review) c.appendChild(el("div", "review", "Model review: " + item.call.review));
    c.appendChild(el("pre", "", item.detail || JSON.stringify(item.call.input, null, 2)));
    var buttons = el("div", "buttons");
    var error = el("div", "error");
    var all = [];
    function disable(off) { for (var i = 0; i < all.length; i++) all[i].disabled = off; }
    item.options.forEach(function (o) {
      var b = el("button", o.value, o.label);
      all.push(b);
      b.addEventListener("click", function () {
        var name = nameInput.value.replace(/^\\s+|\\s+$/g, "");
        if (!name) { error.textContent = "Fill in your name first."; nameInput.focus(); return; }
        disable(true);
        request("POST", "/api/answer", { id: item.id, answer: o.value, name: name }, function (status, data) {
          if (status !== 200) { error.textContent = (data && data.error) || "Failed"; disable(false); }
          shown = "";
          refresh();
        });
      });
      buttons.appendChild(b);
    });
    c.appendChild(buttons);
    c.appendChild(error);
    return c;
  }

  refresh();
  setInterval(refresh, 1500);
</script>
</body>
</html>`;
