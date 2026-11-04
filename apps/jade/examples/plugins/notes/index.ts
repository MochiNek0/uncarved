// 示例：随手记笔记，记在工作目录的 NOTES.md 里，一行一条。
// 演示：工具和它在对话里的显示（renderers）、快捷键（keys）、读改输入框（ctx.input）、替用户发送（ctx.send）、
// 状态栏（ctx.status）、斜杠命令。input、send 只给用户层插件，所以请装在 $JADE_HOME/plugins/ 下。

import { existsSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { JadePluginFactory } from "@uncarved/jade";

const factory: JadePluginFactory = ({ cwd, definePlugin, input, send, status }) => {
  const file = path.join(cwd, "NOTES.md");
  /** 同步读：renderer 的 before 要在工具执行前同步拿到结果 */
  const notes = (): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")) : []);
  const add = async (text: string) => {
    await appendFile(file, `- ${text.replace(/\s+/g, " ").trim()}\n`);
    status(`${notes().length} notes`);
  };
  status(`${notes().length} notes`);

  return definePlugin({
    tools: [
      {
        name: "add_note",
        description: "Append a short note for the user to NOTES.md in the working directory.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "the note, one line" } },
          required: ["text"],
          additionalProperties: false,
        },
        // write：ask 模式下要用户批准，审批框里显示下面的 preview。exclusive：不和别的工具同时执行
        effect: "write",
        concurrency: "exclusive",
        // 执行两次会记两条
        idempotent: false,
        async execute(i) {
          const text = String((i as { text?: unknown } | null)?.text ?? "");
          if (!text.trim()) return { content: "text is empty", isError: true };
          await add(text);
          return { content: `Added to NOTES.md: ${text}` };
        },
      },
    ],
    renderers: [
      {
        tool: "add_note",
        // ● add_note(买牛奶)
        summary: (i) => String((i as { text?: unknown }).text ?? ""),
        // 摘要只有一行，长的笔记展开后看全文
        details: (i) => {
          const text = String((i as { text?: unknown }).text ?? "");
          return text.length > 60 ? text : undefined;
        },
        preview: (i) => `+ ${String((i as { text?: unknown }).text ?? "")}\n  (appended to ${file})`,
        // 执行前记下有几条，结果行显示前后的数量
        before: () => notes().length,
        result: ({ isError, before }) => (isError || typeof before !== "number" ? undefined : { line: `NOTES.md: ${before} → ${before + 1} notes` }),
      },
    ],
    keys: [
      {
        key: "ctrl+t",
        description: "save the input box as a note",
        async run() {
          // 终端界面之外没有 input
          const text = input?.text().trim();
          if (!text) return;
          await add(text);
          input!.set("");
        },
      },
      {
        key: "ctrl+g",
        description: "ask the agent to turn the notes into a todo list",
        run: () => send?.("Read NOTES.md and turn the notes into a todo list. Do not change the file."),
      },
    ],
    commands: [
      {
        name: "notes",
        description: "show the notes in NOTES.md",
        // 只读文件、不碰会话：模型工作时也能立即执行
        instant: true,
        run: () => {
          const all = notes();
          return all.length ? all.join("\n") : "No notes yet. Type one and press ctrl+t.";
        },
      },
    ],
  });
};

export default factory;
