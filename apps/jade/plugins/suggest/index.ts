// jade/suggest：每一轮正常结束后，预测用户下一条想发的消息，灰色显示在输入框里，Tab 或 → 接受。默认关着（enabled）。
//
// 模型经 models@1：配置 model 是 /model 保存过的模型名，不设时用会话的模型。
// /suggest 在 TUI 里开关、选模型，马上生效，记在 $JADE_HOME/state/suggest.json，盖过 config.json 里的 enabled 和 model。
// 对话从 context.project（每次请求模型前的消息）和 model.after（这一轮最后的回复）取，轮次结束从 turn.ended 事件知道。
// 从旧 jade 的 examples/plugins/suggest 移植；提示词、对话的整理和截取、回复的清理参考 dsh-ghost-prompt。

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Delta, Message, ModelRequest } from "uncarved";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Commands } from "../commands/index.ts";
import type { Models } from "../models/index.ts";

export const SYSTEM = [
  "You predict the next message the USER will type to an AI coding assistant.",
  "You are given the recent conversation. Write the single message the user is most likely to send next, exactly as they would type it.",
  "Rules:",
  '- Write from the user\'s point of view, addressed to the assistant (e.g. "run the tests", "commit this", "yes, go ahead").',
  "- Match the language and tone the user has been writing in. If the user writes Chinese, answer in Chinese.",
  "- Keep it short: one sentence, at most about 20 words or 40 CJK characters.",
  "- Prefer the obvious next step: answering a question the assistant just asked, approving a proposed plan, verifying or continuing the work.",
  "- The user gives instructions; write an instruction or a short answer, not a question.",
  '- Never summarize or describe the work that was done (wrong: "the Title weights are fixed now"). That is the assistant\'s job, not the user\'s.',
  '- Never speak as the assistant: no offers or plans like "want me to...", "I will...", "需要我…吗", "我会…". When the assistant offered something, the user accepts or declines it (assistant: "I can commit this if you want" -> user: "commit it").',
  "- Never repeat a request the user already made, and never invent facts, file names or numbers not in the conversation.",
  "- If no next message is reasonably predictable, output exactly: NONE",
  'Output only the message text on one line. No quotes, no prefix like "User:", no explanation, no Markdown.',
].join("\n");

/** 送给预测模型的最近对话（字符），从最新的往前取 */
const MAX_CONTEXT_CHARS = 8000;
/** 每条消息最多这么多字，超出时留头尾 */
const PER_MESSAGE_CHARS = 2400;
/** 一次预测的时限 */
const TIMEOUT_MS = 30_000;

export type Entry = { role: "user" | "assistant"; text: string };

/** 太长的消息留头和尾，中间最不要紧 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

/** 一条消息里给预测模型看的文字：用户消息只取用户自己打的字（工具结果、插件附的说明不算），回复里的工具调用只留名字 */
function textOf(m: Message): string {
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.kind === "text" && b.text.trim() && (m.role === "assistant" || b.origin.by === "user")) parts.push(b.text.trim());
    else if (b.kind === "tool_use" && m.role === "assistant") parts.push(`[called tool: ${b.name}]`);
  }
  return parts.join("\n");
}

/** 整理成用户、助手交替的对话：没有文字的消息去掉，相邻同一方的合并（一轮里助手的几步并成一条） */
export function transcriptOf(messages: readonly Message[]): Entry[] {
  const out: Entry[] = [];
  for (const m of messages) {
    const text = textOf(m);
    if (!text) continue;
    const last = out.at(-1);
    if (last?.role === m.role) last.text += `\n${text}`;
    else out.push({ role: m.role, text });
  }
  return out;
}

const frameLine = (e: Entry) => `<${e.role}>\n${clip(e.text, PER_MESSAGE_CHARS)}\n</${e.role}>`;

/** 从最新的往前放，放不下就停；最后一条总是放进去 */
export function frame(transcript: readonly Entry[], budget = MAX_CONTEXT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = frameLine(transcript[i]!);
    if (lines.length > 0 && used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  return ["Recent conversation, oldest first:", "", lines.join("\n\n"), "", "Predict the user's next message."].join("\n");
}

const LEADING_PREFIX = /^(?:user|用户)\s*[:：]\s*/i;
const LEADING_QUOTES = /^["'“”‘’`「『]+/;
const TRAILING_QUOTES = /["'“”‘’`」』]+$/;

/** 模型回复的第一行整理成建议：去掉 "User:" 前缀和包着的引号；NONE、空或问句的时候 undefined */
export function tidy(reply: string): string | undefined {
  let line = reply.trimStart().split(/\r?\n/)[0]!.trim().replace(LEADING_PREFIX, "");
  if (LEADING_QUOTES.test(line)) line = line.replace(LEADING_QUOTES, "").replace(TRAILING_QUOTES, "").trim();
  // 问句多半是模型把助手的"要不要我…？"当成了用户的话，猜中用户真要问什么的少，不显示
  if (!line || /^none\.?$/i.test(line) || /[?？]$/.test(line)) return undefined;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** 生效的设置：model 为 undefined 时用会话的模型 */
export interface Settings {
  enabled: boolean;
  model: string | undefined;
}

/** process() 里读好、/suggest 改的设置，session() 里每次预测时读 */
let settings: Settings = { enabled: false, model: undefined };
/** 设置改了时通知每个会话（关掉时去掉已经显示的建议） */
const changed = new Set<() => void>();

/** state/suggest.json 里 /suggest 记下的设置；没有、读不了或格式不对的键不算 */
async function readState(file: string): Promise<Partial<Settings>> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { enabled?: unknown; model?: unknown };
    return {
      ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
      // 空字符串表示用会话的模型
      ...(typeof data.model === "string" ? { model: data.model.trim() || undefined } : {}),
    };
  } catch {
    return {};
  }
}

async function writeState(file: string, s: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ enabled: s.enabled, model: s.model ?? "" }, null, 2)}\n`);
  await rename(tmp, file);
}

export default definePlugin({
  async process(ctx) {
    const file = path.join(ctx.home, "state", "suggest.json");
    const raw = ctx.config.model;
    if (raw !== undefined && typeof raw !== "string") ctx.service<UI>("ui@1")?.notify(`jade/suggest: model must be a model name, got ${JSON.stringify(raw)}; using the session's model`, "warning");
    settings = {
      enabled: ctx.config.enabled === true,
      model: typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
      ...(await readState(file)),
    };
    const models = ctx.require<Models>("models@1");
    const describe = () => `suggestions are ${settings.enabled ? "on" : "off"}, predicted by ${settings.model ? `the saved model ${settings.model}` : "the session's model"}`;
    const update = async (next: Partial<Settings>) => {
      settings = { ...settings, ...next };
      for (const fn of changed) fn();
      await writeState(file, settings);
      return `${describe()}.`;
    };

    ctx.service<Commands>("commands@1")?.register({
      name: "suggest",
      args: "[on|off|model [name]]",
      description: "predict your next message after each turn (one more model request per turn), and which model predicts",
      // 只改插件自己的设置
      instant: true,
      async run(args, c) {
        const [sub = "", ...rest] = args.trim().split(/\s+/);
        if (sub === "on" || sub === "off") return update({ enabled: sub === "on" });
        if (sub === "model") {
          const saved = (await models.saved?.()) ?? [];
          let name: string | undefined = rest.join(" ");
          if (!name) {
            const SESSION = "\0session";
            const picked = await c.ui.select(
              {
                title: "Which model predicts your next message?",
                options: [
                  { label: "The session's model", value: SESSION },
                  ...saved.map((m) => ({ label: m, value: m, ...(m === settings.model ? { hint: "current" } : {}) })),
                ],
              },
              c.signal,
            );
            if (picked === undefined) return;
            name = picked === SESSION ? undefined : picked;
          } else if (models.saved && !saved.includes(name)) {
            return `${name} is not a model saved by /model. ${saved.length ? `Saved: ${saved.join(", ")}.` : "Add one with /model first."}`;
          }
          return update({ model: name });
        }
        if (sub) return "usage: /suggest [on|off|model [name]]";
        return `${describe()}. /suggest on|off turns them on or off; /suggest model picks the model.`;
      },
    });
  },

  session(ctx) {
    const input = ctx.input;
    // 没有输入框的前端（-p）用不上
    if (!input) return;
    const models = ctx.require<Models>("models@1");

    /** 最近一次发给模型的消息，加上这一轮最后的回复 */
    let messages: Message[] = [];
    let reply: Message | undefined;
    /** 正在进行的预测：新的一次请求开始、会话结束时中止 */
    let pending: AbortController | undefined;
    ctx.signal.addEventListener("abort", () => pending?.abort());
    // /suggest off：停下正在进行的预测，去掉已经显示的建议
    const onChange = () => {
      if (settings.enabled) return;
      pending?.abort();
      input.hint(undefined);
    };
    changed.add(onChange);
    ctx.signal.addEventListener("abort", () => changed.delete(onChange));
    /** 上一次提示过的错误：同样的错误每轮都提示太吵，成功一次后清掉 */
    let warned: string | undefined;
    const warn = (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (message === warned) return;
      warned = message;
      ctx.service<UI>("ui@1")?.notify(`jade/suggest: prediction failed (${settings.model ? `model ${settings.model}` : "the session's model"}): ${message}`, "warning");
    };

    async function predict() {
      if (!settings.enabled) return;
      const { model } = settings;
      const transcript = transcriptOf([...messages, ...(reply ? [reply] : [])]);
      // 用户还没说过话，或者最后不是助手的回复：没有可回答的
      if (!transcript.some((e) => e.role === "user") || transcript.at(-1)?.role !== "assistant") return;
      pending?.abort();
      const mine = (pending = new AbortController());
      // 第一行完整了就停：建议只要一行，后面的都会丢掉
      const firstLine = new AbortController();
      let streamed = "";
      const onDelta = (d: Delta) => {
        if (d.kind === "reset") streamed = "";
        else if (d.kind === "text") streamed += d.text;
        if (/\S[^\n]*\n/.test(streamed)) firstLine.abort();
      };
      const origin = { by: "plugin" as const, id: ctx.plugin };
      const request: ModelRequest = {
        system: [{ text: SYSTEM, stability: "stable", origin, trust: "trusted" }],
        messages: [{ role: "user", content: [{ kind: "text", text: frame(transcript), origin, trust: "trusted" }] }],
        tools: [],
      };
      let text: string;
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      try {
        const res = await models.complete(request, {
          signal: AbortSignal.any([mine.signal, firstLine.signal, timeout]),
          onDelta,
          ...(model ? { model } : {}),
        });
        text = res.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("");
      } catch (e) {
        // 第一行完整后自己停下的，用已经收到的
        if (firstLine.signal.aborted && !mine.signal.aborted) text = streamed;
        else {
          // 超时、被中止不打扰用户；模型出错（配置不对之类）说一次，否则开着却什么都不显示，看不出为什么
          if (!mine.signal.aborted && !timeout.aborted && !ctx.signal.aborted) warn(e);
          return;
        }
      }
      warned = undefined;
      const hint = tidy(text);
      if (hint && !mine.signal.aborted) input!.hint(hint);
    }

    ctx.kernel.hook({
      // 每次请求模型前：记下这次发出的消息，不改它们。新的请求说明新的一轮（或下一步）开始了，之前的建议作废
      kind: "transform",
      point: "context.project",
      optional: true,
      fn: (msgs) => {
        messages = msgs;
        reply = undefined;
        pending?.abort();
        input.hint(undefined);
        return undefined;
      },
    });
    ctx.kernel.hook({
      kind: "observe",
      point: "model.after",
      fn: (res) => {
        reply = { role: "assistant", content: res.content };
      },
    });
    ctx.kernel.hook({
      // 这一轮正常结束（不是中断、出错或被截断）时预测。不 await：hook 有时限，预测在后台进行
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "turn.ended" && (e.data as { reason?: unknown }).reason === "end") void predict();
      },
    });
  },
});
