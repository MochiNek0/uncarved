// jade/serve：jade --serve，无头、常驻，一个进程同时跑多个会话。stdin 每行一个 JSON 请求，stdout 每行一个 JSON 事件；提示写到 stderr。
// 会话用核心的 sessions.start 开：彼此并存，没有"当前会话"。不能向用户提问：ui@1 的 select 总是返回 undefined，要审批的调用由审批插件拒绝。

import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { Block, LogEvent, RuntimeNotice, Usage } from "uncarved";
import { definePlugin, type Frontend, type StartedSession, type UI } from "@uncarved/jade-api";

const USAGE = `usage: jade --serve

Runs until stdin closes, with any number of sessions at once. One JSON object per line.
Requests (stdin); "id" is optional and is copied into the reply:
  {"type":"open", "id"?, "resume"?: "<session id>"}   -> {"type":"opened", "id"?, "session"}
  {"type":"send", "id"?, "session", "text"}           -> {"type":"done", "id"?, "session", "reason", "error"?} when that turn
                                                         has ended, however it ended (reason as in turn_end: "end", "aborted",
                                                         "error", ...); "error" only if the message never started a turn
  {"type":"abort", "session"}                          stops the running turn
  {"type":"close", "id"?, "session"}                  -> {"type":"closed", "id"?, "session"} (it can be resumed later)
Events (stdout), each with "session":
  {"type":"text", "text"}                       reply text as it is written
  {"type":"tool_use", "name", "input"}
  {"type":"tool_error", "message"} / {"type":"denied", "reason"?}
  {"type":"turn_end", "reason", "error"?, "result", "usage"}   result is the turn's final reply
A request that cannot be carried out gets {"type":"error", "id"?, "session"?, "error"} instead of its reply.
Notices from plugins go to stderr. Exit code: 0 when stdin closes, 130 when interrupted.
Nobody can answer approval questions here, so calls that need approval are denied: in the default "ask" mode that
includes writing files. To let it change files in the working directory, put {"jade/approval": {"mode": "auto"}}
in $JADE_HOME/config.json.`;

/** --serve 的 ui@1（导出给测试） */
export const ui: UI = {
  interactive: false,
  notify(message, level = "info") {
    process.stderr.write(`${level === "info" ? "" : `[${level}] `}${stripVTControlCharacters(String(message))}\n`);
  },
  select: async () => undefined,
  input: async () => undefined,
};

type Request = { type?: unknown; id?: unknown; session?: unknown; text?: unknown; resume?: unknown };

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const frontend: Frontend = {
  async run({ argv, sessions }) {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const extra = argv.filter((a) => a !== "--serve");
    if (extra.length > 0) {
      process.stderr.write(`unknown argument ${extra[0]}\n\n${USAGE}\n`);
      return 2;
    }
    const start = sessions.start?.bind(sessions);
    if (!start) {
      process.stderr.write("jade: this jade cannot run several sessions at once\n");
      return 1;
    }

    const open = new Map<string, StartedSession>();
    /** 每个会话结束了几轮、最近一轮怎么结束的：send 的回复据此判断这一轮跑没跑 */
    const ended = new Map<string, { count: number; reason: string; error?: string }>();
    /** 还没处理完的请求：stdin 关了以后等它们 */
    const pending = new Set<Promise<void>>();
    const track = (p: Promise<void>) => {
      pending.add(p);
      void p.finally(() => pending.delete(p));
    };

    const attach = (s: StartedSession) => {
      const session = s.id;
      let result = "";
      let used: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      /** 这次模型调用推送过文字增量；没推送的（不流式的服务），回复到了再一次写出 */
      let streamed = false;
      s.subscribe((n: RuntimeNotice) => {
        if (n.type === "delta" && n.delta.kind === "text") {
          streamed = true;
          emit({ type: "text", session, text: n.delta.text });
        }
        if (n.type !== "event") return;
        const e = n.event as LogEvent;
        if (e.type === "model.responded") {
          const { content, usage } = e.data as { content: Block[]; usage?: Usage };
          const text = content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
          if (text) result = text;
          for (const k of Object.keys(used) as (keyof Usage)[]) used[k] += usage?.[k] ?? 0;
          if (!streamed && text) emit({ type: "text", session, text });
          streamed = false;
          for (const b of content) if (b.kind === "tool_use") emit({ type: "tool_use", session, name: b.name, input: b.input });
        }
        if (e.type === "tool.decided") {
          const d = e.data as { decision: string; reason?: string };
          if (d.decision === "deny") emit({ type: "denied", session, ...(d.reason ? { reason: stripVTControlCharacters(d.reason) } : {}) });
        }
        if (e.type === "tool.completed") {
          const d = e.data as { isError: boolean; content: Block[] };
          if (d.isError) emit({ type: "tool_error", session, message: stripVTControlCharacters(firstLine(d.content)) });
        }
        if (e.type === "turn.ended") {
          const d = e.data as { reason: string; error?: string };
          emit({ type: "turn_end", session, reason: d.reason, ...(d.error ? { error: d.error } : {}), result, usage: used });
          ended.set(session, { count: (ended.get(session)?.count ?? 0) + 1, reason: d.reason, ...(d.error ? { error: d.error } : {}) });
          result = "";
          used = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        }
      });
    };

    const handle = async (req: Request) => {
      const id = req.id !== undefined ? { id: req.id } : {};
      const fail = (e: unknown, session?: string) => emit({ type: "error", ...id, ...(session ? { session } : {}), error: errorText(e) });
      const target = (): StartedSession | undefined => {
        const s = typeof req.session === "string" ? open.get(req.session) : undefined;
        if (!s) fail(new Error(typeof req.session === "string" ? `no open session ${req.session}` : `"session" is missing`), typeof req.session === "string" ? req.session : undefined);
        return s;
      };
      switch (req.type) {
        case "open": {
          if (req.resume !== undefined && typeof req.resume !== "string") return fail(new Error(`"resume" must be a session id`));
          let s: StartedSession;
          try {
            s = await start(typeof req.resume === "string" ? { resume: req.resume } : {});
          } catch (e) {
            return fail(e);
          }
          open.set(s.id, s);
          attach(s);
          emit({ type: "opened", ...id, session: s.id });
          // 恢复的会话：先把日志里没做完的工作做完（排在之后发来的消息前面）
          if (typeof req.resume === "string") await s.recover().catch((e) => fail(e, s.id));
          return;
        }
        case "send": {
          if (typeof req.text !== "string" || !req.text) return fail(new Error(`"text" must be a non-empty string`), typeof req.session === "string" ? req.session : undefined);
          const s = target();
          if (!s) return;
          const before = ended.get(s.id)?.count ?? 0;
          // 中止、模型出错的轮次 send 会 reject；跑过的轮次一律回 done，带着结束原因。没跑起来的才回 error
          const done = () => {
            const last = ended.get(s.id);
            if (!last || last.count === before) return false;
            emit({ type: "done", ...id, session: s.id, reason: last.reason, ...(last.error ? { error: last.error } : {}) });
            return true;
          };
          try {
            await s.send({ kind: "message", content: [{ kind: "text", text: req.text, origin: { by: "user" }, trust: "trusted" }] });
            if (!done()) emit({ type: "done", ...id, session: s.id, reason: "end" });
          } catch (e) {
            if (!done()) fail(e, s.id);
          }
          return;
        }
        case "abort": {
          target()?.abort(new Error("aborted by the client"));
          return;
        }
        case "close": {
          const s = target();
          if (!s) return;
          open.delete(s.id);
          await s.close();
          emit({ type: "closed", ...id, session: s.id });
          return;
        }
        default:
          return fail(new Error(`unknown request type ${JSON.stringify(req.type)}`));
      }
    };

    let interrupted = false;
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const interrupt = () => {
      interrupted = true;
      for (const s of open.values()) s.abort(new Error("interrupted"));
      rl.close();
    };
    process.once("SIGINT", interrupt);
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let req: Request;
        try {
          req = JSON.parse(line) as Request;
          if (typeof req !== "object" || req === null || Array.isArray(req)) throw new Error("a request must be a JSON object");
        } catch (e) {
          emit({ type: "error", error: `bad request: ${errorText(e)}` });
          continue;
        }
        track(handle(req));
      }
      // stdin 关了：等发出的请求做完，再让会话离开
      while (pending.size > 0) await Promise.allSettled([...pending]);
      for (const s of open.values()) await s.close();
    } finally {
      process.off("SIGINT", interrupt);
    }
    return interrupted ? 130 : 0;
  },
};

export default definePlugin({
  process(ctx) {
    ctx.provide("ui@1", ui);
    ctx.provide("frontend@1", frontend);
  },
});

/** 经过膜的错误包成了 PluginError，带着插件名；调用方要看的是原因 */
function errorText(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
}

function firstLine(content: Block[]): string {
  const text = content.find((b) => b.kind === "text");
  return text && "text" in text ? text.text.split("\n")[0]! : "(no message)";
}
