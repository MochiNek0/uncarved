// jade/print：jade -p "<prompt>" 跑一轮就退出。模型的回复写到 stdout，工具调用和提示写到 stderr。
// 不能向用户提问：ui@1 的 select 总是返回 undefined，要审批的调用由审批插件拒绝。

import type { Block, LogEvent, RuntimeNotice } from "uncarved";
import { definePlugin, type Frontend, type UI } from "../../src/api.ts";

const USAGE = `usage: jade -p <prompt> [--resume <session id>]
       echo <prompt> | jade -p
       cat <file> | jade -p - <prompt>

With "-", what comes in on stdin is added after the prompt (without a prompt, stdin is the prompt).

Runs one prompt and exits. The reply goes to stdout; tool calls and notices go to stderr.
Exit code: 0 when the turn ends normally, 1 on an error, 130 when interrupted.`;

const ui: UI = {
  interactive: false,
  notify(message, level = "info") {
    process.stderr.write(`${level === "info" ? "" : `[${level}] `}${message}\n`);
  },
  select: async () => undefined,
  input: async () => undefined,
};

const frontend: Frontend = {
  async run({ argv, sessions }) {
    const args = parse(argv);
    if (typeof args === "string") {
      process.stderr.write(`${args}\n\n${USAGE}\n`);
      return 2;
    }
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    // 有 prompt 参数时只在写了 "-" 时读 stdin：脚本启动 jade -p 时 stdin 常是没人关的管道，默认去读会一直等下去
    const piped = args.stdin || (args.prompt === undefined && !process.stdin.isTTY) ? (await readStdin()).trim() : "";
    const prompt = [args.prompt, piped].filter(Boolean).join("\n\n");
    if (!prompt) {
      process.stderr.write(`no prompt given\n\n${USAGE}\n`);
      return 2;
    }

    const session = await sessions.open(args.resume ? { resume: args.resume } : {});
    let ended: { reason: string; error?: string } | undefined;
    let midLine = false;
    const out = (text: string) => {
      process.stdout.write(text);
      midLine = !text.endsWith("\n");
    };
    /** 这次模型调用推送过文字增量；没推送的（不流式的服务），回复到了再一次写出 */
    let streamed = false;
    const unsubscribe = session.subscribe((n: RuntimeNotice) => {
      if (n.type === "delta" && n.delta.kind === "text") {
        streamed = true;
        out(n.delta.text);
      }
      if (n.type !== "event") return;
      const e = n.event as LogEvent;
      if (e.type === "model.responded") {
        const content = (e.data as { content: Block[] }).content;
        if (!streamed) for (const b of content) if (b.kind === "text") out(b.text);
        streamed = false;
        if (midLine) out("\n");
        for (const b of content) if (b.kind === "tool_use") process.stderr.write(`· ${b.name} ${summary(b.input)}\n`);
      }
      if (e.type === "tool.decided") {
        const d = e.data as { decision: string; reason?: string };
        if (d.decision === "deny") process.stderr.write(`  denied${d.reason ? `: ${d.reason}` : ""}\n`);
      }
      if (e.type === "tool.completed") {
        const d = e.data as { isError: boolean; content: Block[] };
        if (d.isError) process.stderr.write(`  failed: ${firstLine(d.content)}\n`);
      }
      if (e.type === "turn.ended") ended = e.data as { reason: string; error?: string };
    });

    const interrupt = () => session.abort(new Error("interrupted"));
    process.once("SIGINT", interrupt);
    let failure: unknown;
    try {
      if (args.resume) await session.recover();
      await session.send({ kind: "message", content: [{ kind: "text", text: prompt, origin: { by: "user" }, trust: "trusted" }] });
      await session.idle();
    } catch (e) {
      failure = e;
    } finally {
      process.off("SIGINT", interrupt);
      unsubscribe();
    }
    if (midLine) out("\n");
    process.stderr.write(`session ${session.id}\n`);
    const end = ended as { reason: string; error?: string } | undefined;
    if (end?.reason === "aborted") return 130;
    if (failure !== undefined || end?.reason === "error") {
      // 模型服务的错误经过膜时包成了 PluginError，用户要看的是原因
      const cause = failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure;
      process.stderr.write(`error: ${cause instanceof Error ? cause.message : (end?.error ?? String(cause ?? "the turn failed"))}\n`);
      return 1;
    }
    return 0;
  },
};

export default definePlugin({
  process(ctx) {
    ctx.provide("ui@1", ui);
    ctx.provide("frontend@1", frontend);
  },
});

function parse(argv: readonly string[]): { prompt?: string; resume?: string; help?: boolean; stdin?: boolean } | string {
  const out: { prompt?: string; resume?: string; help?: boolean; stdin?: boolean } = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--print") continue;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-") out.stdin = true;
    else if (a === "--resume") {
      const id = argv[++i];
      if (!id) return "--resume needs a session id";
      out.resume = id;
    } else if (a.startsWith("-")) return `unknown option ${a}`;
    else words.push(a);
  }
  if (words.length > 0) out.prompt = words.join(" ");
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 工具参数的一行摘要：常见的 path、command、pattern，其余是截断的 JSON */
function summary(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  const s = typeof i?.command === "string" ? i.command : typeof i?.path === "string" ? i.path : typeof i?.pattern === "string" ? i.pattern : JSON.stringify(input);
  const line = (s ?? "").split("\n")[0]!;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function firstLine(content: Block[]): string {
  const text = content.find((b) => b.kind === "text");
  return text && "text" in text ? text.text.split("\n")[0]! : "(no message)";
}
