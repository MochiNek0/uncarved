// 把运行时的通知和日志事件显示成对话：模型的流式输出、工具调用和结果、轮次结束的原因，
// 以及恢复会话时重新显示历史。顺带统计本会话的 token 用量、更新状态栏的上下文用量。
//
// 只负责显示和统计，不驱动运行时；前端（frontend.ts）用 lastEnd、turnFailed 决定接下来做什么。

import type { Block, EventDataMap, LogEvent, PendingCall, Runtime, TurnEndReason, Usage } from "uncarved";
import type { EventRenderer, ToolRenderer } from "@uncarved/jade-api/services";
import { clip, clipStyled, detailsOf, preview, summarize } from "./render.ts";
import { bold, cyan, dim, green, red, yellow, type Screen } from "./screen.ts";

export type Notice = Parameters<Parameters<Runtime["subscribe"]>[0]>[0];

export interface TranscriptOptions {
  screen: Screen;
  cwd: string;
  /** 子 Agent 的用量在它自己的日志里，从这里读；不给就不统计子 Agent 的用量 */
  readLog?(sessionId: string): Promise<LogEvent[]>;
  /** 模型的上下文窗口（状态栏显示用） */
  contextWindow(): number;
  /** 自动压缩的阈值（状态栏显示用） */
  compactAt?(): number;
  /** 每次回复的输出上限（回复被截断时的提示用）；没有时说是服务的默认值 */
  maxTokens?(): number | undefined;
  /** 上一轮失败后能否用 /retry 重新请求 */
  canRetry(): boolean;
  /** 插件为自己的工具注册的显示方式（随会话的插件实例变） */
  renderer?(tool: string): { plugin: string; renderer: ToolRenderer } | undefined;
  /** 插件为自己的事件注册的显示方式，按完整的事件类型 */
  eventRenderer?(type: string): { plugin: string; renderer: EventRenderer } | undefined;
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
  /** 工具调用括号里的一行摘要：插件的 renderer 优先 */
  summary(name: string, input: unknown): string;
  /** 摘要省略了的参数，调用行展开后显示在最前面（已经缩进）；没有时是 undefined */
  details(name: string, input: unknown): string | undefined;
  /** 审批时的预览：工具的 renderer 给的，没有时是参数的 JSON */
  preview(c: PendingCall): Promise<string>;
}

/** 工具结果折叠起来的完整内容最多这么多行 */
const MAX_DETAIL_LINES = 2000;

/** 插件事件里的用量：只取数字字段 */
function usageOf(u: unknown): Usage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const out: Usage = {};
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const v = (u as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function transcript(opts: TranscriptOptions): Transcript {
  const { screen, cwd } = opts;

  const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u?: Usage) => {
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u?.[k] ?? 0;
    if (u) screen.status({ spent: { input: usage.inputTokens, output: usage.outputTokens } });
  };
  /**
   * 一个事件带来的用量：模型回复；插件事件 data 里的 usage（压缩时的总结调用、auto 模式的审查这类插件自己发的请求）；
   * 子 Agent 的用量在它自己的日志里（读不到时不算，不让一个读失败变成没人处理的 rejection）
   */
  async function countUsage(e: LogEvent) {
    if (e.type === "model.responded") addUsage((e as LogEvent<"model.responded">).data.usage);
    else if (e.origin.by === "plugin") addUsage(usageOf((e.data as { usage?: unknown } | null)?.usage));
    else if (e.type === "tool.completed") {
      const child = (e as LogEvent<"tool.completed">).data.child;
      if (child && opts.readLog) for (const c of await opts.readLog(child.sessionId).catch(() => [])) await countUsage(c);
    }
  }

  /**
   * 报过缓存命中数的 provider/模型。有的服务只在命中时才带这个字段，报过一次之后没带就是没命中；
   * 换了服务或模型要重新看，否则从报缓存的服务换到不报的，会一直显示 0%
   */
  let reportsCache: string | undefined;
  /** 上下文用量：最近一次回复的输入加输出，就是下一次请求的大致起点；以及这次输入的缓存命中率 */
  function showContext(e: LogEvent<"model.responded">) {
    const u = e.data.usage;
    if (u?.inputTokens === undefined) return;
    const by = e.origin.by === "model" ? `${e.origin.provider}/${e.origin.model}` : "";
    if (u.cacheReadTokens !== undefined) reportsCache = by;
    screen.status({
      context: { used: u.inputTokens + (u.outputTokens ?? 0), limit: opts.contextWindow(), compactAt: opts.compactAt?.() },
      cache: reportsCache === by && u.inputTokens > 0 ? (u.cacheReadTokens ?? 0) / u.inputTokens : undefined,
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
    toolChars = 0;
  };
  /** 这次回复里工具参数已经生成的字数：写大文件时一写几分钟，显示出来才看得出不是卡住了 */
  let toolChars = 0;
  const toolLabel = () => (toolChars < 1000 ? "Writing" : `Writing (${Math.floor(toolChars / 1000)}k chars)`);
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
  let streamed = false;
  /** 正在运行、显示着进度的工具 */
  const running = new Set<string>();
  /** 调用行省略了的参数（例如很长的命令），结果出来后放在折叠内容的最前面 */
  const calls = new Map<string, string>();
  /** renderer 的 before 在执行前记下的东西，结果出来时交给它的 result */
  const befores = new Map<string, unknown>();
  const progress =(id: string, line: string, o?: { output?: boolean }) => {
    running.add(id);
    screen.progress(id, line, o);
  };
  const doneProgress = (id: string) => {
    if (running.delete(id)) screen.progress(id, undefined);
  };
  /** 有 result renderer 的调用的参数，结果出来时交给它 */
  const inputs = new Map<string, unknown>();
  /** 等人工审批的调用的参数，回答（input.received）来了按它显示 */
  const asks = new Map<string, unknown>();

  /** 出过错的 renderer（插件 + 工具），只提示一次 */
  const failed = new Set<string>();
  /** 调用插件的 renderer；没有、出错时返回 undefined（用默认的显示） */
  async function custom<T>(name: string, use: (r: ToolRenderer) => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    const found = opts.renderer?.(name);
    if (!found) return undefined;
    try {
      return await use(found.renderer);
    } catch (err) {
      renderFailed(found.plugin, name, err);
      return undefined;
    }
  }
  /** 同步的版本：摘要和结果在事件通知里同步显示 */
  function customSync<T>(name: string, use: (r: ToolRenderer) => T | undefined): T | undefined {
    const found = opts.renderer?.(name);
    if (!found) return undefined;
    try {
      return use(found.renderer);
    } catch (err) {
      renderFailed(found.plugin, name, err);
      return undefined;
    }
  }
  function renderFailed(plugin: string, name: string, err: unknown) {
    if (failed.has(`${plugin}:${name}`)) return;
    failed.add(`${plugin}:${name}`);
    screen.log(yellow(`[warning] plugin ${plugin}: showing ${name} failed, using the default display: ${errorText(err)}`));
  }
  const summary = (name: string, input: unknown): string => {
    const s = customSync(name, (r) => r.summary?.(input));
    return typeof s === "string" ? clip(s.split("\n")[0]!, 120) : summarize(cwd, input);
  };
  const details = (name: string, input: unknown): string | undefined => {
    const d = customSync(name, (r) => r.details?.(input));
    return typeof d === "string" && d ? d.replace(/^/gm, "    ") : undefined;
  };

  const self: Transcript = {
    usage,
    lastEnd: undefined,
    lastError: undefined,
    turnFailed: false,
    onNotice,
    replay,
    summary,
    details,
    async preview(c) {
      const p = await custom(c.name, (r) => r.preview?.(c.input));
      return typeof p === "string" ? p : preview(c.input);
    },
    echo: (text) => screen.log(text.startsWith("/") ? cyan(`› ${text}`) : `\n${bold(`› ${text.replace(/\n/g, "\n  ")}`)}`),
    reset() {
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] = 0;
      reportsCache = undefined;
      toolNames.clear();
      for (const id of running) screen.progress(id, undefined);
      running.clear();
      calls.clear();
      befores.clear();
      inputs.clear();
      asks.clear();
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
          // 只在千位变了时更新，不让每个增量都重画
          const before = toolLabel();
          toolChars += n.delta.text.length;
          const label = toolLabel();
          if (label !== before || toolChars === n.delta.text.length) screen.busy(label);
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
        return renderProgress(n.toolUseId, n.update);
      case "event":
        return renderEvent(n.event);
    }
  }

  /** 工具的进度：有 renderer 的 progress 时由它换成一行；否则 { text } 形式的按输出逐行显示（例如 bash），其他的不显示 */
  function renderProgress(toolUseId: string, update: unknown) {
    const name = toolNames.get(toolUseId) ?? "?";
    if (opts.renderer?.(name)?.renderer.progress) {
      const line = customSync(name, (r) => r.progress?.(update, { toolUseId, summary }));
      if (typeof line === "string" && line) progress(toolUseId, clipStyled(line.split("\n")[0]!, 200));
      return;
    }
    const text = (update as { text?: unknown } | null)?.text;
    if (typeof text !== "string") return;
    for (const l of text.replace(/\n$/, "").split("\n")) progress(toolUseId, dim(`  │ ${clip(l, 200)}`), { output: true });
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
        showContext(e as LogEvent<"model.responded">);
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
        const full = details(name, d.input);
        if (full) calls.set(d.toolUseId, full);
        if (opts.renderer?.(name)?.renderer.result) inputs.set(d.toolUseId, d.input);
        if (d.decision === "ask") {
          asks.set(d.toolUseId, d.input);
          return;
        }
        // 执行前交给 renderer 的 before（例如按文件当时的内容算 diff）；重新显示历史时文件已经变了，不调用
        if (d.decision === "allow" && !replaying) {
          const before = customSync(name, (r) => r.before?.(d.input));
          if (before !== undefined) befores.set(d.toolUseId, before);
        }
        const head = `${bold(name)}(${summary(name, d.input)})`;
        if (d.decision === "deny") screen.log(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""), { id: d.toolUseId, details: full });
        else {
          activity(`Running ${name}`);
          // 用户批准的调用在审批时已经显示过；重新显示历史时没有审批这一步
          if (d.decidedBy !== "user" || replaying) {
            const own = customSync(name, (r) => r.call?.(d.input));
            if (typeof own === "string" && own) {
              // renderer 给的内容：第一行是调用行（结果接在它后面），其余的行不折叠
              const [first, ...rest] = own.split("\n");
              screen.log(cyan("● ") + first, { id: d.toolUseId, details: full });
              if (rest.length) screen.log(rest.join("\n"));
            } else {
              // auto 模式下审查放行的带着理由
              screen.log(cyan("● ") + head + (d.reason ? dim(` — ${clip(d.reason, 160)}`) : ""), { id: d.toolUseId, details: full });
            }
          }
        }
        return;
      }
      case "input.received": {
        // 对等待审批的调用的回答：和关卡直接决定的一样显示
        const d = e.data as EventDataMap["input.received"];
        if (d.kind !== "approval") return;
        const input = asks.get(d.toolUseId);
        asks.delete(d.toolUseId);
        const decided: EventDataMap["tool.decided"] = { toolUseId: d.toolUseId, decision: d.approved ? "allow" : "deny", input, ...(d.approved ? {} : { reason: d.reason }) };
        return renderEvent({ ...e, type: "tool.decided", data: decided });
      }
      case "tool.completed": {
        const d = e.data as EventDataMap["tool.completed"];
        void countUsage(e);
        activity("Working");
        doneProgress(d.toolUseId);
        const call = calls.get(d.toolUseId);
        calls.delete(d.toolUseId);
        const before = befores.get(d.toolUseId);
        befores.delete(d.toolUseId);
        const input = inputs.get(d.toolUseId);
        inputs.delete(d.toolUseId);
        const text = textOf(d.content).trim();
        const name = toolNames.get(d.toolUseId) ?? "?";
        const mine = customSync(name, (r) => r.result?.({ toolUseId: d.toolUseId, input, text, isError: d.isError === true, before }));
        // null：renderer 不要显示结果
        if (mine === null) return;
        if (mine && typeof mine.line === "string") {
          const own = typeof mine.details === "string" && mine.details ? [mine.details.replace(/^/gm, "    ")] : [];
          const folded = [...(call ? [call] : []), ...own].join("\n") || undefined;
          screen.amend(d.toolUseId, (d.isError ? red : dim)("⎿ ") + clipStyled(mine.line.split("\n")[0]!, 200), { details: folded });
          return;
        }
        const lines = text.split("\n");
        // 结果接在调用的那一行后面；摘要省略了内容时，把完整结果（和子 Agent 调用过的工具）折叠起来，点击展开
        const shown = d.isError ? 4 : 1;
        const width = d.isError ? 200 : 160;
        const hidden = lines.length > shown || lines.some((l) => l.length > width);
        const details =
          hidden || call
            ? [...(call ? [call] : []), ...(hidden ? [detailsOf(lines, d.isError ? red : (s) => s, MAX_DETAIL_LINES)] : [])].join("\n")
            : undefined;
        if (d.isError) screen.amend(d.toolUseId, red(`⎿ ${lines.slice(0, shown).map((l) => clip(l, width)).join("\n    ")}`), { details });
        else screen.amend(d.toolUseId, dim(`⎿ ${clip(lines[0] ?? "", width)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`), { details });
        return;
      }
      case "tool.interrupted": {
        const d = e.data as EventDataMap["tool.interrupted"];
        doneProgress(d.toolUseId);
        calls.delete(d.toolUseId);
        befores.delete(d.toolUseId);
        inputs.delete(d.toolUseId);
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
          // 不读 process.env：写在 $JADE_HOME/.env 里的只有 models 插件知道
          const max = opts.maxTokens?.();
          const limit = max ? `${max} tokens` : "the provider's default";
          screen.log(yellow(`[reply cut off at the output limit (${limit}); raise it with /model if this keeps happening]`));
        } else if (d.reason !== "end") screen.log(yellow(`[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`));
        if (self.turnFailed && !replaying && opts.canRetry()) screen.log(dim("[send /retry to request again without adding a message]"));
        return;
      }
      default:
        return renderPluginEvent(e);
    }
  }

  /**
   * 插件的事件：用量照常统计；插件为它注册了渲染器时由渲染器显示，
   * 否则只有 ctx.emit("notice", { text, level? }) 写入的提示显示成 [插件 id] 文本
   */
  function renderPluginEvent(e: LogEvent) {
    if (e.origin.by !== "plugin") return;
    void countUsage(e);
    const found = opts.eventRenderer?.(e.type);
    if (!found) return renderPluginNotice(e);
    let shown: ReturnType<EventRenderer["render"]>;
    try {
      shown = found.renderer.render(e.data);
    } catch (err) {
      return renderFailed(found.plugin, e.type, err);
    }
    if (!shown || typeof shown.line !== "string") return;
    const details = typeof shown.details === "string" && shown.details ? shown.details.replace(/^/gm, "    ") : undefined;
    screen.log(shown.line, { details });
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
        if (e.type === "model.responded") showContext(e as LogEvent<"model.responded">);
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
          const head = `${bold(name)}(${summary(name, asked.get(d.toolUseId))})`;
          screen.log(d.approved ? green(`✓ ${head}`) : red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""), {
            id: d.toolUseId,
            details: details(name, asked.get(d.toolUseId)),
          });
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
