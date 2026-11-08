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
let lanUrl: string | undefined;
let failure: string | undefined;
let announced = false;

export default {
  async process(ctx) {
    url = lanUrl = failure = undefined;
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
    const lan = host === "0.0.0.0" || host === "::" ? lanAddress() : undefined;
    lanUrl = lan ? `http://${lan}:${actual}/?token=${token}` : undefined;

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
  return [`Approvals can also be answered at ${url}`, ...(lanUrl ? [`  from a phone on this network: ${lanUrl}`] : [])].join("\n");
}

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
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
  <label class="who">Your name <input id="name" autocomplete="name" placeholder="recorded in the audit log"></label>
  <div id="list"><div class="empty">Loading…</div></div>
</main>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const nameInput = document.getElementById("name");
  try { nameInput.value = localStorage.getItem("jade-approver-name") || ""; } catch {}
  nameInput.addEventListener("input", () => { try { localStorage.setItem("jade-approver-name", nameInput.value); } catch {} });
  const list = document.getElementById("list");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let shown = "";

  async function refresh() {
    let items;
    try {
      const res = await fetch("/api/pending", { headers: { "x-token": token } });
      if (!res.ok) throw new Error(await res.text());
      items = await res.json();
    } catch (e) {
      list.replaceChildren(el("div", "empty", "Cannot reach jade: " + e.message));
      shown = "";
      return;
    }
    const key = items.map((i) => i.id).join(",");
    if (key === shown) return;
    shown = key;
    if (items.length === 0) { list.replaceChildren(el("div", "empty", "Nothing waiting for approval.")); return; }
    list.replaceChildren(...items.map(card));
  }

  function card(item) {
    const c = el("div", "card");
    c.append(el("div", "title", item.title));
    c.append(el("div", "meta", item.call.cwd + " · " + item.call.effect + " · mode " + item.call.mode + " · " + new Date(item.since).toLocaleTimeString()));
    if (item.call.review) c.append(el("div", "review", "Model review: " + item.call.review));
    c.append(el("pre", "", item.detail || JSON.stringify(item.call.input, null, 2)));
    const buttons = el("div", "buttons");
    const error = el("div", "error");
    for (const o of item.options) {
      const b = el("button", o.value, o.label);
      b.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) { error.textContent = "Fill in your name first."; nameInput.focus(); return; }
        for (const x of buttons.children) x.disabled = true;
        const res = await fetch("/api/answer", { method: "POST", headers: { "content-type": "application/json", "x-token": token }, body: JSON.stringify({ id: item.id, answer: o.value, name }) });
        if (!res.ok) { error.textContent = (await res.json().catch(() => ({}))).error || "Failed"; for (const x of buttons.children) x.disabled = false; }
        shown = ""; refresh();
      });
      buttons.append(b);
    }
    c.append(buttons, error);
    return c;
  }

  refresh();
  setInterval(refresh, 1500);
</script>
</body>
</html>`;
