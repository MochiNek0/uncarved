// 最小示例：一个从 .md 文件加载系统提示词的插件 + 一个只读工具。
// 运行：bun examples/hello.ts "读一下 CONSTITUTION.md 的第二章，总结成三句话"

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@uncarved/provider-anthropic";
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";
import { MemoryLogStore, Runtime, type Layer, type Plugin, type SystemSegment } from "uncarved";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

// 提示词即数据：发行版自带 examples/prompts/*.md，项目可以在 .uncarved/prompts/*.md 追加。
// 每段都在 origin.source 中标明配置层、路径和哈希；项目层的片段来自代码仓库，标为 untrusted（7.2）
const PROMPTS_ID = "example/prompts";

async function promptSegments(root: string, rel: string, layer: Layer): Promise<SystemSegment[]> {
  const dir = path.join(root, rel);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (f) => {
      const text = await readFile(path.join(dir, f), "utf8");
      const hash = createHash("sha256").update(text).digest("hex");
      return {
        text,
        stability: "stable" as const,
        origin: { by: "plugin" as const, id: PROMPTS_ID, source: { layer, path: `${rel}/${f}`, hash } },
        trust: layer === "project" ? ("untrusted" as const) : ("trusted" as const),
      };
    }),
  );
}

const prompts: Plugin = {
  id: PROMPTS_ID,
  version: "0.1.0",
  kernel: "^1",
  hooks: [
    {
      kind: "transform",
      point: "context.build",
      fn: async (req) => {
        const distro = await promptSegments(here, "prompts", "distro");
        const project = await promptSegments(root, ".uncarved/prompts", "project");
        const today: SystemSegment = {
          text: `Today is ${new Date().toISOString().slice(0, 10)}.`,
          stability: "volatile",
          origin: { by: "plugin", id: PROMPTS_ID },
          trust: "trusted",
        };
        return { ...req, system: [...req.system, ...distro, ...project, today] };
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
