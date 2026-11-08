// acme/audit：审计。
//
// - 每个会话开始时记一个 `acme/audit/identity` 事件：谁（员工）、哪台机器、哪个目录。
// - 配置了 endpoint 时，会话日志里的每个事件写入后都转发过去（攒一秒发一批），公司那边有一份不在员工电脑上的副本。
//   发送失败的留着下次再发，不影响会话。
// - `/audit [会话 id]`：把会话日志整理成一份审计报告（Markdown），写到 $JADE_HOME/audit/<id>.md。
//   报告里每个工具调用都说清楚是怎么放行或拒绝的：规则自动放行、模型审查放行、谁经哪个渠道批准，或者撞了哪条公司红线。
//
// 报告只读日志，不依赖这些插件当时是否在场：日志是唯一的事实来源（宪法 I-5）。
// 只用类型导入，不依赖 jade 的运行时代码：装到任何地方都能加载。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, LogEvent } from "uncarved";
import type { PluginModule, UI } from "../../../src/api.ts";
import type { Commands } from "../../../plugins/commands/index.ts";

/** 会话开始时记的身份 */
export interface IdentityEvent {
  employee: string;
  host: string;
  cwd: string;
}

const FLUSH_MS = 1000;
/** 发不出去时最多留多少个事件，再多就丢最旧的并告诉用户 */
const MAX_QUEUE = 10_000;
const SESSION_ID = /^[\w.-]+$/;

export default {
  process(ctx) {
    ctx.service<Commands>("commands@1")?.register({
      name: "audit",
      args: "[session id]",
      description: "write an audit report of this session (or another one) to $JADE_HOME/audit",
      instant: true,
      async run(args, c) {
        const id = args.trim() || c.sessions.current?.id;
        if (!id) return "No session yet. /audit <session id> reports on an earlier one.";
        if (!SESSION_ID.test(id)) return `Not a session id: ${id}`;
        let events: LogEvent[];
        try {
          events = id === c.sessions.current?.id ? await c.sessions.current.history() : await readLog(ctx.home, id);
        } catch (err) {
          return `Cannot read session ${id}: ${(err as Error).message}`;
        }
        const r = report(id, events);
        const dir = path.join(ctx.home, "audit");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${id}.md`);
        await writeFile(file, r.markdown);
        return `${r.summary.join("\n")}\n\nFull report: ${file}`;
      },
    });
  },

  async session(ctx) {
    const employee = typeof ctx.config.employee === "string" && ctx.config.employee ? ctx.config.employee : os.userInfo().username;
    ctx.kernel.hook({
      kind: "observe",
      point: "session.start",
      fn: async (_state, hook) => {
        const identity: IdentityEvent = { employee, host: os.hostname(), cwd: ctx.cwd };
        await hook.emit("identity", identity);
      },
    });

    const endpoint = typeof ctx.config.endpoint === "string" && ctx.config.endpoint ? ctx.config.endpoint : undefined;
    if (!endpoint) return;
    const ui = ctx.service<UI>("ui@1");
    const queue: { session: string; event: LogEvent }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sending: Promise<void> | undefined;
    let warned = false;
    const warn = (m: string) => {
      if (warned) return;
      warned = true;
      ui?.notify(`acme/audit: ${m}; events are kept and sent again later`, "warning");
    };
    const flush = async () => {
      timer = undefined;
      if (sending || queue.length === 0) return;
      const batch = queue.slice();
      sending = (async () => {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events: batch }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`the audit service answered ${res.status}`);
          queue.splice(0, batch.length);
          warned = false;
        } catch (err) {
          warn(`cannot send events to ${endpoint} (${(err as Error).message})`);
        } finally {
          sending = undefined;
        }
      })();
      await sending;
      if (queue.length > 0 && !warned) schedule();
    };
    const schedule = () => {
      timer ??= setTimeout(() => void flush(), FLUSH_MS);
    };
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (event) => {
        queue.push({ session: ctx.session.id, event });
        if (queue.length > MAX_QUEUE) {
          queue.splice(0, queue.length - MAX_QUEUE);
          warn(`more than ${MAX_QUEUE} events are waiting, the oldest were dropped`);
        }
        schedule();
      },
    });
    // 会话关闭时最后发一次；发不出去的留在本地日志里，/audit 仍然能看
    await ctx.effect(() => async () => {
      clearTimeout(timer);
      await sending;
      await flush();
    });
  },
} satisfies PluginModule;

async function readLog(home: string, id: string): Promise<LogEvent[]> {
  const text = await readFile(path.join(home, "sessions", `${id}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogEvent);
}

// ---------- 报告 ----------

interface ToolUse {
  name: string;
  input: unknown;
  model: string;
}

interface Answered {
  answer: "once" | "always" | "deny";
  channel: string;
  by?: string;
}

/** 把日志整理成报告：summary 是几行摘要（命令里显示），markdown 是完整报告 */
export function report(id: string, events: readonly LogEvent[]): { summary: string[]; markdown: string } {
  const uses = new Map<string, ToolUse>();
  const answered = new Map<string, Answered>();
  const blocked = new Map<string, { rule: string; detail: string }>();
  const reviewed = new Set<string>();
  const identities: IdentityEvent[] = [];
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "model.responded") {
      const model = modelOf(e);
      for (const b of (d.content as Block[]) ?? []) if (b.kind === "tool_use") uses.set(b.id, { name: b.name, input: b.input, model });
    } else if (e.type === "jade/approval/answered") answered.set(d.toolUseId as string, d as unknown as Answered);
    else if (e.type === "acme/guard/blocked") blocked.set(d.toolUseId as string, d as unknown as { rule: string; detail: string });
    else if (e.type === "jade/approval/reviewed") reviewed.add(d.toolUseId as string);
    else if (e.type === "acme/audit/identity") identities.push(d as unknown as IdentityEvent);
  }

  const stats = { requests: 0, input: 0, output: 0, calls: 0, auto: 0, review: 0, person: 0, policy: 0, refused: 0, other: 0, failed: 0 };
  const models = new Set<string>();
  const changed = new Set<string>();
  const commands: string[] = [];
  const rows: string[] = [];
  const row = (e: LogEvent, what: string, detail: string) => rows.push(`| ${time(e.at)} | ${cell(what)} | ${cell(detail)} |`);

  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case "acme/audit/identity": {
        const i = d as unknown as IdentityEvent;
        row(e, "Session opened", `${i.employee} on ${i.host}, in ${i.cwd}`);
        break;
      }
      case "input.received":
        if (d.kind === "message") row(e, "User", short(textOf(d.content as Block[]), 300));
        else if (d.kind === "approval") row(e, "User answer", `${d.approved ? "approved" : "denied"} ${d.toolUseId}`);
        break;
      case "model.responded": {
        stats.requests++;
        const usage = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        stats.input += usage?.inputTokens ?? 0;
        stats.output += usage?.outputTokens ?? 0;
        const model = modelOf(e);
        models.add(model);
        const content = (d.content as Block[]) ?? [];
        const calls = content.flatMap((b) => (b.kind === "tool_use" ? [`${b.name} ${short(describe(b.name, b.input), 120)}`] : []));
        const said = short(textOf(content), 200);
        row(e, `Model (${model})`, [said, ...calls.map((c) => `→ ${c}`)].filter(Boolean).join("<br>") || "(no text)");
        break;
      }
      case "tool.decided": {
        stats.calls++;
        const id = d.toolUseId as string;
        const use = uses.get(id);
        const name = use?.name ?? "?";
        const how = decision(d, answered.get(id), blocked.get(id), reviewed.has(id));
        stats[how.kind]++;
        if (d.decision === "allow") {
          for (const p of filesOf(d.input)) if (isWrite(name)) changed.add(p);
          const command = (d.input as { command?: unknown } | null)?.command;
          if (typeof command === "string") commands.push(command);
        }
        row(e, `${d.decision === "allow" ? "Allowed" : d.decision === "deny" ? "Denied" : "Asking"}: ${name}`, `${short(describe(name, d.input), 160)}<br>${how.text}`);
        break;
      }
      case "tool.completed":
        if (d.isError) {
          stats.failed++;
          row(e, `Failed: ${uses.get(d.toolUseId as string)?.name ?? "?"}`, short(textOf(d.content as Block[]), 200));
        }
        break;
      case "turn.ended":
        if (d.reason !== "end") row(e, "Turn ended", `${d.reason}${d.error ? `: ${d.error}` : ""}`);
        break;
    }
  }

  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  const who = identities.length > 0 ? [...new Set(identities.map((i) => `${i.employee}@${i.host}`))].join(", ") : "unknown (acme/audit was not installed)";
  const summary = [
    `Audit of session ${id}`,
    `  who       ${who}`,
    `  when      ${first ? new Date(first).toLocaleString() : "?"} – ${last ? new Date(last).toLocaleString() : "?"}`,
    `  models    ${[...models].join(", ") || "none"} (${stats.requests} replies, ${stats.input} tokens in, ${stats.output} out)`,
    `  tools     ${stats.calls} calls: ${stats.auto} allowed by rule, ${stats.review} by model review, ${stats.person} answered by a person, ` +
      `${stats.policy} blocked by company rules, ${stats.refused} refused by other plugins; ${stats.failed} failed`,
    `  changed   ${changed.size} files, ${commands.length} commands run`,
  ];
  const markdown = [
    `# Audit report: ${id}`,
    "",
    "```",
    ...summary.slice(1).map((l) => l.trimStart()),
    "```",
    "",
    ...(changed.size > 0 ? ["## Files changed", "", ...[...changed].map((f) => `- \`${f}\``), ""] : []),
    ...(commands.length > 0 ? ["## Commands run", "", ...commands.map((c) => `- \`${short(c, 300).replaceAll("`", "'")}\``), ""] : []),
    "## Timeline",
    "",
    "| Time | Event | Detail |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  return { summary, markdown };
}

/** 一个工具调用是怎么放行或拒绝的 */
function decision(
  d: Record<string, unknown>,
  answer: Answered | undefined,
  block: { rule: string; detail: string } | undefined,
  wasReviewed: boolean,
): { kind: "auto" | "review" | "person" | "policy" | "refused" | "other"; text: string } {
  const by = typeof d.decidedBy === "string" ? d.decidedBy : undefined;
  if (block && d.decision === "deny") return { kind: "policy", text: `**blocked by company rule \`${block.rule}\`** (${by ?? "acme/guard"}): ${block.detail}` };
  if (answer) {
    const who = answer.by ? `${answer.by} via ${answer.channel}` : answer.channel === "terminal" ? "the user in the terminal" : `someone via ${answer.channel}`;
    const what = answer.answer === "once" ? "allowed once" : answer.answer === "always" ? "allowed for the rest of the session" : "denied";
    return { kind: "person", text: `${what} by **${who}**` };
  }
  if (d.decision === "allow") return wasReviewed ? { kind: "review", text: `allowed after a model review (${by ?? "?"})` } : { kind: "auto", text: `allowed by rule (${by ?? "no gate"})` };
  if (d.decision === "deny") return { kind: by === "jade/approval" ? "other" : "refused", text: `denied by ${by ?? "?"}${d.reason ? `: ${short(String(d.reason), 160)}` : ""}` };
  return { kind: "other", text: "waiting for a person" };
}

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
const isWrite = (name: string) => WRITE_TOOLS.has(name);
const filesOf = (input: unknown): string[] => {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === "string" ? [p] : [];
};

/** 工具调用的一行说明：命令、路径或网址，其余的给 JSON */
function describe(_name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["command", "url", "path", "query", "pattern"]) if (typeof i[k] === "string") return String(i[k]);
  return JSON.stringify(input);
}

function modelOf(e: LogEvent): string {
  const o = e.origin as { by: string; provider?: string; model?: string };
  return o.by === "model" ? `${o.provider}/${o.model}` : "?";
}

const textOf = (blocks: readonly Block[] | undefined) => (blocks ?? []).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join(" ");
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const time = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString();
};
