// 示例：每一轮结束后，用你自己选的模型（例如免费的小模型）预测你下一条想发的消息，灰色显示在输入框里，
// 按 Tab 或 → 接受，接着可以改，回车发送。
// 演示：ctx.complete 用插件自己的服务和模型、ctx.listModels、ctx.input.hint、交互式斜杠命令、
// 在 context.project / model.after / event 上取对话和轮次结束的时机。
// 服务的地址、密钥和模型用 /suggest 设置，存在 $JADE_HOME/suggest.json。ctx.input 只给用户层插件，所以请装在 $JADE_HOME/plugins/ 下。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandUI, JadePluginFactory, ModelService, ServiceModel } from "@uncarved/jade";

interface Config extends Partial<ServiceModel> {
  /** /suggest off 关掉；默认开着 */
  off?: boolean;
}

type Text = { kind: string; text?: string };
type Msg = { role: "user" | "assistant"; content: Text[] };

const SYSTEM =
  "You predict the next message the user will send to a coding assistant, from the end of their conversation. " +
  "Reply with only that message, written as the user would type it, in the user's language, at most one short sentence. " +
  "If the assistant asked the user a question, answer it the way the user most likely would. " +
  "If you cannot tell what the user would do next, reply with nothing.";

/** 只看最后几条消息，每条最多这么多字：小模型、快、省 token */
const LAST_MESSAGES = 6;
const MAX_CHARS = 1500;

const KINDS: { kind: ModelService["kind"]; label: string; hint: string }[] = [
  { kind: "openai-compat", label: "OpenAI-compatible service", hint: "any /chat/completions endpoint" },
  { kind: "openai", label: "OpenAI", hint: "Responses API" },
  { kind: "anthropic", label: "Anthropic", hint: "Claude" },
];

const textOf = (m: Msg) =>
  m.content
    .flatMap((b) => (b.kind === "text" && b.text ? [b.text] : []))
    .join("\n")
    .trim();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 模型的回复整理成一行建议；没有可用的内容时 undefined */
function tidy(reply: string): string | undefined {
  const line = reply.trim().split("\n")[0]!.trim().replace(/^["'“「]+|["'”」]+$/g, "").trim();
  return line && line.length <= 300 ? line : undefined;
}

const factory: JadePluginFactory = ({ home, definePlugin, complete, listModels, input, signal }) => {
  const file = path.join(home, "suggest.json");
  const load = async (): Promise<Config> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Config;
    } catch {
      return {};
    }
  };
  // 里面有密钥：只有自己能读（Windows 上不起作用）
  const save = (c: Config) => writeFile(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  const ready = (c: Config): c is Config & ServiceModel => !c.off && Boolean(c.kind && c.model);

  /** 最近一次发给模型的消息，加上这一轮最后的回复 */
  let messages: Msg[] = [];
  let reply: Msg | undefined;
  /** 正在进行的预测：新的一轮开始、会话结束时中止 */
  let pending: AbortController | undefined;
  signal.addEventListener("abort", () => pending?.abort());

  async function predict() {
    const config = await load();
    if (!ready(config) || !input) return;
    const recent = [...messages, ...(reply ? [reply] : [])]
      .map((m) => ({ role: m.role, text: textOf(m) }))
      .filter((m) => m.text)
      .slice(-LAST_MESSAGES);
    if (!recent.length) return;
    const prompt = recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${clip(m.text, MAX_CHARS)}`).join("\n\n");
    pending?.abort();
    const mine = (pending = new AbortController());
    try {
      const { kind, baseURL, apiKey, model } = config;
      const { text } = await complete({ system: SYSTEM, prompt, model: { kind, baseURL, apiKey, model } }, mine.signal);
      const hint = tidy(text);
      if (hint && !mine.signal.aborted) input.hint(hint);
    } catch {
      // 只是建议：服务出错、被中止都不打扰用户，/suggest 里可以测试连接
    }
  }

  /** /suggest 的设置流程：选格式、填地址和密钥、选模型 */
  async function configure(ui: CommandUI) {
    const old = await load();
    const kind = await ui.select(
      "Which format does the suggestion model's service use?",
      KINDS.map((k) => ({ label: k.label, value: k.kind, hint: k.kind === old.kind ? `${k.hint} · current` : k.hint })),
    );
    if (!kind) return "Cancelled.";
    const same = kind === old.kind;
    const baseURL = (
      await ui.input(kind === "openai-compat" ? "Base URL (required)" : "Base URL (leave empty for the official one)", {
        initial: same ? old.baseURL : undefined,
        placeholder: kind === "openai-compat" ? "https://…/v1" : undefined,
      })
    )?.trim();
    if (baseURL === undefined) return "Cancelled.";
    if (kind === "openai-compat" && !baseURL) return "An OpenAI-compatible service needs a base URL.";
    const typed = await ui.input(same && old.apiKey ? "API key (leave empty to keep the saved one)" : "API key (leave empty if the service needs none)", { mask: true });
    if (typed === undefined) return "Cancelled.";
    const apiKey = typed.trim() || (same ? old.apiKey : undefined);
    const service: ModelService = { kind, ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}) };
    const models = await listModels(service);
    const OTHER = "\0other";
    let model = models.length
      ? await ui.select("Which model should predict your next message?", [
          ...models.map((m) => ({ label: m, value: m, hint: same && m === old.model ? "current" : undefined })),
          { label: "Enter a name…", value: OTHER },
        ])
      : OTHER;
    if (model === undefined) return "Cancelled.";
    if (model === OTHER) model = (await ui.input("Model name", { initial: same ? old.model : undefined }))?.trim();
    if (!model) return "Cancelled.";
    await save({ ...service, model });
    // 试一次，配置不对时现在就知道
    try {
      await complete({ prompt: "Reply with OK.", model: { ...service, model } }, AbortSignal.timeout(30_000));
      return `Suggestions now use ${model} (${kind}${baseURL ? `, ${baseURL}` : ""}). Saved to ${file}.`;
    } catch (err) {
      return `Saved to ${file}, but a test request to ${model} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return definePlugin({
    hooks: [
      {
        // 每次请求模型前都会执行：记下这次发出的消息，不改它们（返回 undefined）。
        // 新的一次请求说明新的一轮（或下一步）开始了，之前的预测作废
        kind: "transform",
        point: "context.project",
        optional: true,
        fn: (msgs) => {
          messages = msgs as Msg[];
          reply = undefined;
          pending?.abort();
          return undefined;
        },
      },
      {
        kind: "observe",
        point: "model.after",
        fn: (res) => {
          reply = { role: "assistant", content: res.content as Text[] };
        },
      },
      {
        // 这一轮正常结束（不是中断、出错或被截断）时预测。不 await：hook 有时限，预测在后台进行
        kind: "observe",
        point: "event",
        fn: (e) => {
          if (e.type === "turn.ended" && (e.data as { reason?: string }).reason === "end") void predict();
        },
      },
    ],
    commands: [
      {
        name: "suggest",
        description: "set the model that predicts your next message, or turn suggestions on/off",
        args: "[on|off]",
        // 只改插件自己的设置，不碰会话：模型工作时也能立即执行
        instant: true,
        async run(args, { ui }) {
          const config = await load();
          const arg = args.trim().toLowerCase();
          if (arg === "off" || arg === "on") {
            await save({ ...config, off: arg === "off" });
            return arg === "off" ? "Suggestions are off." : ready({ ...config, off: false }) ? "Suggestions are on." : "Suggestions are on, but no model is set yet: run /suggest.";
          }
          if (arg) return "Usage: /suggest [on|off]";
          if (!input) return "Suggestions only show in jade's terminal UI.";
          if (!ui.interactive) return "Run /suggest in jade's terminal UI to set the model.";
          return configure(ui);
        },
      },
    ],
  });
};

export default factory;
