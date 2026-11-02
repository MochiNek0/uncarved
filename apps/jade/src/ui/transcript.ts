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
  /** 自动压缩的阈值（状态栏显示用） */
  compactAt?(): number;
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
  /** 最近一轮以错误结束时的错误信息 */
  lastError: string | undefined;
  /** 本轮已经以 turn.ended（error/aborted）结束并显示过原因，随后抛出的同一个错误不再重复显示 */
  turnFailed: boolean;
  /** 开始新会话时清空 */
  reset(): void;
}

/** 工具结果折叠起来的完整内容最多这么多行 */
const MAX_DETAIL_LINES = 2000;

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function transcript(opts: TranscriptOptions): Transcript {
  const { screen, cwd, store } = opts;

  const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u?: Usage) => {
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u?.[k] ?? 0;
    if (u) screen.status({ spent: { input: usage.inputTokens, output: usage.outputTokens } });
  };
  /** 一个事件带来的用量：模型回复、压缩时的总结调用、auto 模式的审查；子 Agent 的用量在它自己的日志里 */
  async function countUsage(e: LogEvent) {
    if (e.type === "model.responded") addUsage((e as LogEvent<"model.responded">).data.usage);
    else if (e.type === "jade/compact/compacted" || e.type === "jade/policy/reviewed") addUsage((e.data as { usage?: Usage }).usage);
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
      context: { used: u.inputTokens + (u.outputTokens ?? 0), limit: opts.contextWindow(), compactAt: opts.compactAt?.() },
      cache: reportsCache && u.inputTokens > 0 ? (u.cacheReadTokens ?? 0) / u.inputTokens : undefined,
    });
  }

  /**
   * 输出速度：从第一个增量开始计时（不算等待首个 token 的时间），输出中按字数估 token 数，每半秒更新一次状态栏；
   * 回复结束后用服务端报的输出 token 数算准确值。工具参数的增量也算输出，只调用工具的回复同样从第一个增量开始计时。
   * 一个增量都没收到的回复（不支持流式的服务）不更新速度：从发出请求开始算会把等待首个 token 的时间也算进去，数字偏低
   */
  const speed = { first: 0, estimate: 0, shown: 0 };
  const startSpeed = () => {
    speed.first = 0;
    speed.estimate = 0;
  };
  const trackSpeed = (text: string) => {
    const now = Date.now();
    if (!speed.first) speed.first = now;
    const wide = text.match(/[^\x00-\x7f]/g)?.length ?? 0;
    speed.estimate += (text.length - wide) / 4 + wide;
    if (now - speed.shown < 500 || now - speed.first < 1000) return;
    speed.shown = now;
    screen.status({ speed: { tps: speed.estimate / ((now - speed.first) / 1000), live: true } });
  };
  const finishSpeed = (u: Usage | undefined) => {
    const seconds = (Date.now() - speed.first) / 1000;
    const tokens = u?.outputTokens ?? Math.round(speed.estimate);
    if (speed.first && tokens > 0 && seconds >= 0.2) screen.status({ speed: { tps: tokens / seconds } });
    speed.first = 0;
    speed.estimate = 0;
  };

  const toolNames = new Map<string, string>();
  /** 正在重新显示恢复的会话里已有的内容：只输出，不显示进行中的状态 */
  let replaying = false;
  const activity = (label: string) => {
    if (!replaying) screen.busy(label);
  };
  /** 结果不用再显示的工具调用 */
  const quiet = new Set<string>();
  let streamed = false;
  /** 正在运行、显示着进度的工具 */
  const running = new Set<string>();
  /** 子 Agent 调用过的工具，结束时放进 task 结果的折叠内容里 */
  const steps = new Map<string, string[]>();
  const progress = (id: string, line: string, o?: { output?: boolean }) => {
    running.add(id);
    screen.progress(id, line, o);
  };
  const doneProgress = (id: string) => {
    if (running.delete(id)) screen.progress(id, undefined);
  };

  const self: Transcript = {
    usage,
    lastEnd: undefined,
    lastError: undefined,
    turnFailed: false,
    onNotice,
    replay,
    echo: (text) => screen.log(text.startsWith("/") ? cyan(`› ${text}`) : `\n${bold(`› ${text.replace(/\n/g, "\n  ")}`)}`),
    reset() {
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] = 0;
      reportsCache = false;
      toolNames.clear();
      quiet.clear();
      for (const id of running) screen.progress(id, undefined);
      running.clear();
      steps.clear();
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
          startSpeed();
          return;
        }
        trackSpeed(n.delta.text);
        // 工具参数只用来计时，不显示；也不算已经输出了内容（重试时不用标记作废，回复结束时照常打印没流式输出的正文）
        if (n.delta.kind === "tool_input") {
          screen.busy("Writing");
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
    if (typeof p !== "object" || p === null) return;
    if (p.kind === "task-start") return progress(toolUseId, dim(`  ↳ sub-agent: ${p.description}`));
    if (p.kind === "task-tool") {
      // 要用户批准的调用在审批时显示
      if (p.decision === "ask") return;
      const step = `${p.decision === "deny" ? "✗" : "·"} ${p.name}(${summarize(cwd, p.name, p.input)})`;
      steps.set(toolUseId, [...(steps.get(toolUseId) ?? []), step]);
      return progress(toolUseId, dim(`    ${step}`));
    }
    // 第三方工具的进度格式 jade 不认识，不显示
    if (typeof (p as { text?: unknown }).text !== "string") return;
    for (const l of p.text.replace(/\n$/, "").split("\n")) progress(toolUseId, dim(`  │ ${clip(l, 200)}`), { output: true });
  }

  function renderEvent(e: LogEvent) {
    switch (e.type) {
      case "model.requested":
        activity("Waiting for the model");
        if (!replaying) startSpeed();
        return;
      case "model.responded": {
        const d = e.data as EventDataMap["model.responded"];
        void countUsage(e);
        showContext(d.usage);
        if (!replaying) finishSpeed(d.usage);
        for (const b of d.content) if (b.kind === "tool_use") toolNames.set(b.id, b.name);
        // 不支持流式的 provider、重新显示历史：一次送出最终文本，和流式输出一样排版
        if (!streamed) {
          const text = textOf(d.content).trim();
          if (text) screen.stream("text", text);
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
        if (d.decision === "deny") screen.log(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""), { id: d.toolUseId });
        else {
          activity(`Running ${name}`);
          if (name === "todo_write") {
            // 清单本身就是参数：直接显示，结果不再显示
            quiet.add(d.toolUseId);
            screen.log(cyan("● ") + bold("Todos"));
            screen.log(renderTodos((d.input as { todos?: Todo[] }).todos ?? []).replace(/^/gm, "  "));
          } else if (d.decidedBy !== "user" || replaying) {
            // 用户批准的调用在审批时已经显示过；重新显示历史时没有审批这一步
            // auto 模式下审查放行的带着理由
            screen.log(cyan("● ") + head + (d.reason ? dim(` — ${clip(d.reason, 160)}`) : ""), { id: d.toolUseId });
          }
        }
        return;
      }
      case "tool.completed": {
        const d = e.data as EventDataMap["tool.completed"];
        void countUsage(e);
        activity("Working");
        doneProgress(d.toolUseId);
        const sub = steps.get(d.toolUseId) ?? [];
        steps.delete(d.toolUseId);
        if (quiet.delete(d.toolUseId) && !d.isError) return;
        const text = textOf(d.content).trim();
        const lines = text.split("\n");
        // 结果接在调用的那一行后面；摘要省略了内容时，把完整结果（和子 Agent 调用过的工具）折叠起来，点击展开
        const shown = d.isError ? 4 : 1;
        const width = d.isError ? 200 : 160;
        const hidden = sub.length > 0 || lines.length > shown || lines.some((l) => l.length > width);
        const details = hidden
          ? [
              ...(sub.length ? [dim(`    sub-agent ran ${sub.length} tool call${sub.length > 1 ? "s" : ""}:`), ...sub.map((l) => dim(`      ${l}`))] : []),
              detailsOf(lines, d.isError ? red : (s) => s, MAX_DETAIL_LINES),
            ].join("\n")
          : undefined;
        if (d.isError) screen.amend(d.toolUseId, red(`⎿ ${lines.slice(0, shown).map((l) => clip(l, width)).join("\n    ")}`), { details });
        else screen.amend(d.toolUseId, dim(`⎿ ${clip(lines[0] ?? "", width)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`), { details });
        return;
      }
      case "tool.interrupted": {
        const d = e.data as EventDataMap["tool.interrupted"];
        doneProgress(d.toolUseId);
        screen.amend(d.toolUseId, yellow("⎿ interrupted before finishing; not retried"));
        return;
      }
      case "turn.ended": {
        const d = e.data as EventDataMap["turn.ended"];
        self.lastEnd = d.reason;
        for (const id of [...running]) doneProgress(id);
        self.lastError = d.error;
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
      case "jade/checks/checked": {
        const d = e.data as { summary: { name: string; problems: number; others?: number; failed?: string }[]; report: string };
        const bad = d.summary.filter((s) => s.problems > 0 || s.others || s.failed);
        const details = d.report ? detailsOf(d.report.split("\n").slice(1), (s) => s, MAX_DETAIL_LINES) : undefined;
        if (bad.length === 0) {
          screen.log(dim(`  ✓ checks passed: ${d.summary.map((s) => s.name).join(", ")}`), { details });
        } else {
          const what = bad.map((s) =>
            s.failed
              ? `${s.name} ${s.failed}`
              : `${s.name}: ${[s.problems > 0 ? `${s.problems} problem${s.problems > 1 ? "s" : ""} in changed files` : "", s.others ? `${s.others} new elsewhere` : ""]
                  .filter(Boolean)
                  .join(", ")}`,
          );
          screen.log(yellow(`  ⚠ checks: ${what.join("; ")}`), { details });
        }
        return;
      }
      case "jade/policy/reviewed":
        // 审查的结果显示在工具调用那一行，这里只计用量
        void countUsage(e);
        return;
      case "jade/compact/trimmed": {
        const d = e.data as { saved: number };
        screen.log(dim(`[cleared old tool output, ~${d.saved} tokens]`));
        return;
      }
      default:
        return renderPluginNotice(e);
    }
  }

  /** 插件用 ctx.emit("notice", { text, level? }) 写入的提示，显示成 [插件 id] 文本 */
  function renderPluginNotice(e: LogEvent) {
    if (e.origin.by !== "plugin" || !e.type.endsWith("/notice")) return;
    const d = e.data as { text?: unknown; level?: unknown } | null;
    if (typeof d?.text !== "string" || !d.text) return;
    const line = `[${e.origin.id}] ${clip(d.text, 2000)}`;
    screen.log(d.level === "warning" ? yellow(line) : dim(line));
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
          screen.log(d.approved ? green(`✓ ${head}`) : red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""), { id: d.toolUseId });
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
