// 最小示例：一个从 .md 文件加载系统提示词的插件 + 一个只读工具。
// 运行：bun examples/hello.ts "读一下 CONSTITUTION.md 的第二章，总结成三句话"

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@uncarved/provider-anthropic";
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";
import { MemoryLogStore, Runtime, type Plugin, type SystemSegment } from "uncarved";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

// 提示词即数据：examples/prompts/*.md 按文件名顺序拼成 stable 段，日期作为 volatile 段放在最后
const prompts: Plugin = {
  id: "example/prompts",
  version: "0.1.0",
  kernel: "^1",
  hooks: [
    {
      kind: "transform",
      point: "context.build",
      fn: async (req) => {
        const dir = path.join(here, "prompts");
        const origin = { by: "plugin" as const, id: "example/prompts" };
        const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
        const stable: SystemSegment[] = await Promise.all(
          files.map(async (f) => ({ text: await readFile(path.join(dir, f), "utf8"), stability: "stable" as const, origin })),
        );
        const today = { text: `Today is ${new Date().toISOString().slice(0, 10)}.`, stability: "volatile" as const, origin };
        return { ...req, system: [...req.system, ...stable, today] };
      },
    },
  ],
};

const readFileTool: Plugin = {
  id: "example/read-file",
  version: "0.1.0",
  kernel: "^1",
  tools: [
    {
      name: "read_file",
      description: "Read a UTF-8 text file. The path is relative to the current working directory.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
      effect: "read",
      concurrency: "safe",
      idempotent: true,
      async execute(input) {
        const p = (input as { path?: unknown }).path;
        if (typeof p !== "string") return { content: "path must be a string", isError: true };
        const full = path.resolve(root, p);
        if (path.relative(root, full).startsWith("..")) return { content: "path escapes the working directory", isError: true };
        return { content: await readFile(full, "utf8") };
      },
    },
  ],
};

// 设置了 AGNES_API_KEY 就用 Agnes 的免费模型，否则用 Claude
const provider = process.env.AGNES_API_KEY
  ? openaiCompatProvider({
      baseURL: "https://apihub.agnes-ai.com/v1",
      apiKey: process.env.AGNES_API_KEY,
      model: process.env.AGNES_MODEL ?? "agnes-3.0-flash",
    })
  : anthropicProvider();

const rt = await Runtime.create({
  store: new MemoryLogStore(),
  provider,
  plugins: [prompts, readFileTool],
});

rt.subscribe((n) => {
  if (n.type === "delta" && n.delta.kind === "text") process.stdout.write(n.delta.text);
  if (n.type === "event" && n.event.type === "tool.decided") process.stdout.write("\n[tool]\n");
  if (n.type === "warning") console.warn(`\n[warning] ${n.code}`);
});

const question = process.argv[2] ?? "Read CONSTITUTION.md and summarize chapter 2 in three sentences.";
await rt.send({ kind: "message", content: [{ kind: "text", text: question, origin: { by: "user" }, trust: "trusted" }] });
process.stdout.write("\n");
