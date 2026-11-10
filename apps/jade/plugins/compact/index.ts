// jade/compact：历史接近上下文窗口时压缩投影（见 compact.ts）；/compact 让下一次请求前总结一次；
// 请求因为超出上下文窗口失败时，压缩后用 { kind: "retry" } 重试一次（session.afterTurn，设计 4.3）。

import type { LogEvent } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";
import type { Models } from "../models/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { compactor, compactThreshold, isContextOverflow, parseTokens } from "./compact.ts";
import { dim } from "./style.ts";

/** 认不出窗口时的阈值 */
const FALLBACK_THRESHOLD = 120_000;
/** Claude 默认的回复上限，阈值要给它留出位置 */
const ANTHROPIC_REPLY_TOKENS = 64_000;
/** 总结要调用模型，比 hook 默认的 30 秒长 */
const SUMMARY_TIMEOUT_MS = 300_000;

/** compact@1 */
export interface Compact {
  /** 历史超过这么多 token 时自动压缩（界面显示用） */
  threshold(): number;
}

/** 自动压缩的阈值：配置的 thresholdTokens，否则按当前模型的上下文窗口算 */
function thresholdFor(config: Record<string, unknown>, models: Models): () => number {
  const configured = parseTokens(config.thresholdTokens);
  return () => {
    if (configured) return configured;
    const m = models.current();
    // 别的模型插件可能不给窗口（或给错）
    if (!m || !(typeof m.contextWindow === "number" && m.contextWindow > 0)) return FALLBACK_THRESHOLD;
    return compactThreshold(m.contextWindow, m.kind === "anthropic" ? ANTHROPIC_REPLY_TOKENS : 0);
  };
}

/** /compact 请求过的会话：下一次投影时无论是否超过阈值都总结一次。值是命令后面写的、要总结特别留意的事 */
const requested = new Map<string, string>();

export default definePlugin({
  process(ctx) {
    ctx.provide("compact@1", { threshold: thresholdFor(ctx.config, ctx.require<Models>("models@1")) } satisfies Compact);
    const commands = ctx.service<Commands>("commands@1");
    commands?.register({
      name: "compact",
      args: "[what to keep]",
      description: "compact the history before the next request; text after the command tells the summary what to pay attention to",
      run(args, c) {
        const s = c.sessions.current;
        if (!s) return "No session is open.";
        requested.set(s.id, args.trim());
        return dim("History will be compacted before the next request.");
      },
    });
    const renderers = ctx.service<Renderers>("renderers@1");
    if (renderers) {
      renderers.event({
        event: "compacted",
        render: (data) => {
          const d = data as { from: number; upTo: number; before: number };
          return { line: dim(`[compacted ${d.upTo - d.from} messages, ~${d.before} tokens before]`) };
        },
      });
      renderers.event({ event: "trimmed", render: (data) => ({ line: dim(`[cleared old tool output, ~${(data as { saved: number }).saved} tokens]`) }) });
    }
  },

  session(ctx) {
    const models = ctx.require<Models>("models@1");
    const configured = parseTokens(ctx.config.thresholdTokens);
    const keepTokens = parseTokens(ctx.config.keepTokens);
    const threshold = thresholdFor(ctx.config, models);
    const c = compactor({ complete: (req, o) => models.complete(req, o), threshold, keepTokens, id: ctx.plugin });
    const id = ctx.session.id;

    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // 排在其他改投影的插件（例如 jade/mentions 附上引用的文件）之后：估算的是最终的投影
      order: 100,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      fn: (messages, hook) => {
        const focus = requested.get(id);
        if (focus !== undefined) {
          requested.delete(id);
          c.request(focus || undefined);
        }
        return c.project(messages, hook);
      },
    });

    // 上下文溢出后压缩重试，每次用户输入只重试一次
    let retried = false;
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e: LogEvent) => {
        c.observe(e);
        if (e.type === "input.received" && (e.data as { kind: string }).kind === "message") retried = false;
        if (e.type !== "turn.ended") return;
        const d = (e as LogEvent<"turn.ended">).data;
        if (d.reason !== "error" || retried || !isContextOverflow(d.error)) return;
        retried = true;
        c.request();
        const ui = ctx.service<UI>("ui@1");
        const window = models.current()?.contextWindow;
        ui?.notify(
          "the request exceeded the model's context window; compacting the history and retrying" +
            (configured || !window ? "" : ` (jade assumed a ${window}-token window; set the real one with JADE_CONTEXT_WINDOW)`),
          "warning",
        );
        // 不能在这里等 send：它要等这一轮结束，而这一轮在等这个 hook
        ctx.session.afterTurn(() => {
          ctx.session.send({ kind: "retry" }).catch((err: unknown) => ctx.signal.aborted || ui?.notify(`retry after compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
        });
      },
    });
  },
});

