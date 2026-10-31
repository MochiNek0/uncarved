// 把运行时的通知和日志事件显示成对话：模型的流式输出、工具调用和结果、轮次结束的原因，
// 以及恢复会话时重新显示历史。顺带统计本会话的 token 用量、更新状态栏的上下文用量。
//
// 只负责显示和统计，不驱动运行时；宿主（main.ts）用 lastEnd、turnFailed 决定接下来做什么。

import { readAll, type Block, type EventDataMap, type LogEvent, type LogStore, type Runtime, type TurnEndReason, type Usage } from "uncarved";
import type { ShellProgress } from "../tools/shell.ts";
import type { TaskProgress } from "../tools/task.ts";
import { renderTodos, type Todo } from "../tools/todo.ts";
import { clip, detailsOf, summarize } from "./render.ts";
import { bold, cyan, dim, green, red, yellow, type Screen } from "./screen.ts";

export type Notice = Parameters<Parameters<Runtime["subscribe"]>[0]>[0];

export interface TranscriptOptions {
  screen: Screen;
  cwd: string;
  /** 子 Agent 的用量在它自己的日志里，从这里读 */
  store: LogStore;
  /** 模型的上下文窗口（状态栏显示用） */
  contextWindow(): number;
  /** 上一轮失败后能否用 /retry 重新请求 */
  canRetry(): boolean;
}

export interface Transcript {
  onNotice(n: Notice): void;
  /** 恢复的会话里已有的内容：show 为 true 时重新显示对话，否则只统计用量 */
  replay(events: LogEvent[], show: boolean): Promise<void>;
  /** 把用户的输入回显到输出里 */
  echo(text: string): void;
  /** 本会话的用量，包括子 Agent 和压缩 */
  readonly usage: Readonly<Required<Usage>>;
  /** 最近一轮的结束原因；宿主开始新一轮前清掉 */
  lastEnd: TurnEndReason | undefined;
  /** 本轮已经以 turn.ended（error/aborted）结束并显示过原因，随后抛出的同一个错误不再重复显示 */
  turnFailed: boolean;
  /** 开始新会话时清空 */
  reset(): void;
}

const MAX_PROGRESS_LINES = 20;
/** 工具结果折叠起来的完整内容最多这么多行 */
const MAX_DETAIL_LINES = 2000;

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function transcript(opts: TranscriptOptions): Transcript {
  const { screen, cwd, store } = opts;

  const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u?: Usage) => {
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u?.[k] ?? 0;
  };
  /** 一个事件带来的用量：模型回复、压缩时的总结调用；子 Agent 的用量在它自己的日志里 */
  async function countUsage(e: LogEvent) {
    if (e.type === "model.responded") addUsage((e as LogEvent<"model.responded">).data.usage);
    else if (e.type === "jade/compact/compacted") addUsage((e.data as { usage?: Usage }).usage);
    else if (e.type === "tool.completed") {
      const child = (e as LogEvent<"tool.completed">).data.child;
      if (child) for (const c of await readAll(store, child.sessionId)) await countUsage(c);
    }
  }

  /** 服务端报过缓存命中数。有的服务只在命中时才带这个字段，报过一次之后没带就是没命中 */
  let reportsCache = false;
  /** 上下文用量：最近一次回复的输入加输出，就是下一次请求的大致起点；以及这次输入的缓存命中率 */
  function showContext(u: Usage | undefined) {
    if (u?.inputTokens === undefined) return;
    if (u.cacheReadTokens !== undefined) reportsCache = true;
    screen.status({
      context: { used: u.inputTokens + (u.outputTokens ?? 0), limit: opts.contextWindow() },
      cache: reportsCache && u.inputTokens > 0 ? (u.cacheReadTokens ?? 0) / u.inputTokens : undefined,
    });
  }

  const toolNames = new Map<string, string>();
  /** 正在重新显示恢复的会话里已有的内容：只输出，不显示进行中的状态 */
  let replaying = false;
  const activity = (label: string) => {
    if (!replaying) screen.busy(label);
  };
  /** 结果不用再显示的工具调用 */
  const quiet = new Set<string>();
  let streamed = false;
  /** 每个工具已经显示了多少行进度输出 */
  const progressLines = new Map<string, number>();

  const self: Transcript = {
    usage,
    lastEnd: undefined,
    turnFailed: false,
    onNotice,
    replay,
    echo: (text) => screen.log(text.startsWith("/") ? cyan(`› ${text}`) : `\n${bold(`› ${text.replace(/\n/g, "\n  ")}`)}`),
    reset() {
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] = 0;
      reportsCache = false;
      toolNames.clear();
      quiet.clear();
      progressLines.clear();
      self.lastEnd = undefined;
    },
  };

  function onNotice(n: Notice) {
    switch (n.type) {
      case "delta":
        if (n.delta.kind === "reset") {
          // 已经输出的内容收不回来，标记一下
          if (streamed) {
            screen.endStream();
            screen.log(yellow("[output above discarded; retrying]"));
          }
          streamed = false;
          return;
        }
        streamed = true;
        if (n.delta.kind === "thinking") {
          screen.busy("Thinking");
          screen.stream("thinking", n.delta.text);
        } else {
          screen.busy("Writing");
          screen.stream("text", n.delta.text);
        }
        return;
      case "hook-error":
        screen.log(yellow(`[hook error] ${n.info.plugin} at ${n.info.point}: ${errorText(n.info.error)}`));
        return;
      case "warning":
        screen.log(yellow(`[warning] ${n.code}`));
        return;
      case "awaiting":
        return;
      case "tool-progress":
        return renderProgress(n.toolUseId, n.update as ShellProgress | TaskProgress);
      case "event":
        return renderEvent(n.event);
    }
  }

  function renderProgress(toolUseId: string, p: ShellProgress | TaskProgress) {
    if (p.kind === "task-start") return screen.log(dim(`  ↳ sub-agent: ${p.description}`));
    if (p.kind === "task-tool") {
      // 要用户批准的调用在审批时显示
      if (p.decision === "ask") return;
      return screen.log(dim(`    ${p.decision === "deny" ? "✗" : "·"} ${p.name}(${summarize(cwd, p.name, p.input)})`));
    }
    const shown = progressLines.get(toolUseId) ?? 0;
    if (shown > MAX_PROGRESS_LINES) return;
    const lines = p.text.replace(/\n$/, "").split("\n");
    const room = MAX_PROGRESS_LINES - shown;
    progressLines.set(toolUseId, shown + Math.min(lines.length, room + 1));
    for (const l of lines.slice(0, room)) screen.log(dim(`  │ ${clip(l, 200)}`));
    if (lines.length > room) screen.log(dim("  │ …"));
  }

  function renderEvent(e: LogEvent) {
    switch (e.type) {
      case "model.requested":
        activity("Waiting for the model");
        return;
      case "model.responded": {
        const d = e.data as EventDataMap["model.responded"];
        void countUsage(e);
        showContext(d.usage);
        for (const b of d.content) if (b.kind === "tool_use") toolNames.set(b.id, b.name);
        // 不支持流式的 provider：直接打印最终文本
        if (!streamed) {
          const text = textOf(d.content).trim();
          if (text) screen.log(text);
        }
        streamed = false;
        screen.endStream();
        return;
      }
      case "tool.decided": {
        const d = e.data as EventDataMap["tool.decided"];
        const name = toolNames.get(d.toolUseId) ?? "?";
        if (d.decision === "ask") return;
        const head = `${bold(name)}(${summarize(cwd, name, d.input)})`;
        if (d.decision === "deny") screen.log(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
        else {
          activity(`Running ${name}`);
          if (name === "todo_write") {
            // 清单本身就是参数：直接显示，结果不再显示
            quiet.add(d.toolUseId);
            screen.log(cyan("● ") + bold("Todos"));
            screen.log(renderTodos((d.input as { todos?: Todo[] }).todos ?? []).replace(/^/gm, "  "));
          } else if (d.decidedBy !== "user" || replaying) {
            // 用户批准的调用在审批时已经显示过；重新显示历史时没有审批这一步
            screen.log(cyan("● ") + head);
          }
        }
        return;
      }
      case "tool.completed": {
        const d = e.data as EventDataMap["tool.completed"];
        void countUsage(e);
        activity("Working");
        if (quiet.delete(d.toolUseId) && !d.isError) return;
        const text = textOf(d.content).trim();
        const lines = text.split("\n");
        // 摘要省略了内容时，把完整结果折叠在摘要下面，点击展开
        const shown = d.isError ? 4 : 1;
        const width = d.isError ? 200 : 160;
        const hidden = lines.length > shown || lines.some((l) => l.length > width);
        const details = hidden ? detailsOf(lines, d.isError ? red : (s) => s, MAX_DETAIL_LINES) : undefined;
        if (d.isError) screen.log(red(`  ⎿ ${lines.slice(0, shown).map((l) => clip(l, width)).join("\n    ")}`), { details });
        else screen.log(dim(`  ⎿ ${clip(lines[0] ?? "", width)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`), { details });
        return;
      }
      case "tool.interrupted":
        screen.log(yellow(`  ⎿ interrupted before finishing; not retried`));
        return;
      case "turn.ended": {
        const d = e.data as EventDataMap["turn.ended"];
        self.lastEnd = d.reason;
        self.turnFailed = d.reason === "error" || d.reason === "aborted";
        if (d.reason === "stopped") screen.log(yellow("[stopped: step budget for this turn used up; send a message to continue]"));
        else if (d.reason === "aborted") screen.log(yellow("[interrupted]"));
        else if (d.reason === "max_tokens") {
          const limit = process.env.JADE_MAX_TOKENS ? `${process.env.JADE_MAX_TOKENS} tokens` : "the provider's default";
          screen.log(yellow(`[reply cut off at the output limit (${limit}); raise it with /model if this keeps happening]`));
        } else if (d.reason !== "end") screen.log(yellow(`[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`));
        if (self.turnFailed && !replaying && opts.canRetry()) screen.log(dim("[send /retry to request again without adding a message]"));
        return;
      }
      case "jade/compact/compacted": {
        const d = e.data as { from: number; upTo: number; before: number };
        void countUsage(e);
        screen.log(dim(`[compacted ${d.upTo - d.from} messages, ~${d.before} tokens before]`));
        return;
      }
      case "jade/compact/trimmed": {
        const d = e.data as { saved: number };
        screen.log(dim(`[cleared old tool output, ~${d.saved} tokens]`));
        return;
      }
    }
  }

  async function replay(events: LogEvent[], show: boolean) {
    if (!show) {
      for (const e of events) {
        await countUsage(e);
        if (e.type === "model.responded") showContext((e as LogEvent<"model.responded">).data.usage);
      }
      return;
    }
    replaying = true;
    /** 等待用户审批的调用的参数，用户的决定记在之后的 input.received 里 */
    const asked = new Map<string, unknown>();
    try {
      for (const e of events) {
        if (e.type === "tool.decided") {
          const d = e.data as EventDataMap["tool.decided"];
          if (d.decision === "ask") asked.set(d.toolUseId, d.input);
        }
        if (e.type !== "input.received") {
          renderEvent(e);
          continue;
        }
        const d = e.data as EventDataMap["input.received"];
        if (d.kind === "approval") {
          const name = toolNames.get(d.toolUseId) ?? "?";
          const head = `${bold(name)}(${summarize(cwd, name, asked.get(d.toolUseId))})`;
          screen.log(d.approved ? green(`✓ ${head}`) : red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
          continue;
        }
        if (d.kind === "retry") {
          screen.log(dim("[retried]"));
          continue;
        }
        if (d.kind !== "message") continue;
        // 宿主附带的说明（例如自动续写）不是用户说的话
        const text = d.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join("\n");
        if (text) self.echo(text);
      }
    } finally {
      replaying = false;
    }
    screen.log(dim("─".repeat(20) + " resumed " + "─".repeat(20)));
  }

  return self;
}
