// 示例共用：限定在某个目录内的文件工具，以及按环境变量选择 provider。

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { anthropicProvider } from "@uncarved/provider-anthropic";
import { openaiCompatProvider } from "@uncarved/provider-openai-compat";
import { openaiResponsesProvider } from "@uncarved/provider-openai-responses";
import type { Plugin, Provider } from "uncarved";

/** list_dir / read_file / write_file，路径都相对于 root，不能越出 root */
export function fsTools(root: string, opts: { id?: string; hidden?: string[] } = {}): Plugin {
  const hidden = new Set(opts.hidden ?? []);
  const inside = (p: unknown): string => {
    if (typeof p !== "string") throw new Error("path must be a string");
    const full = path.resolve(root, p);
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes the workspace");
    return full;
  };
  return {
    id: opts.id ?? "example/fs",
    version: "0.1.0",
    kernel: "^1",
    tools: [
      {
        name: "list_dir",
        description: "List entries of a directory relative to the workspace root. Directories end with '/'.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        effect: "read",
        concurrency: "safe",
        idempotent: true,
        async execute(input) {
          const entries = await readdir(inside((input as { path?: unknown }).path), { withFileTypes: true });
          return { content: entries.filter((e) => !hidden.has(e.name)).map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n") };
        },
      },
      {
        name: "read_file",
        description: "Read a UTF-8 text file relative to the workspace root.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        effect: "read",
        concurrency: "safe",
        idempotent: true,
        async execute(input) {
          return { content: await readFile(inside((input as { path?: unknown }).path), "utf8") };
        },
      },
      {
        name: "write_file",
        description:
          "Create or overwrite a UTF-8 text file relative to the workspace root with the full new content. Missing parent directories are created.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
        effect: "write",
        concurrency: "exclusive",
        idempotent: false,
        async execute(input) {
          const { path: p, content } = input as { path?: unknown; content?: unknown };
          if (typeof content !== "string") return { content: "content must be a string", isError: true };
          const full = inside(p);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, content);
          return { content: `wrote ${Buffer.byteLength(content)} bytes to ${p}` };
        },
      },
    ],
  };
}

/**
 * 按环境变量（可写在 .env 里）选择 provider，代码里不写死任何服务商：
 * - OPENAI_API_KEY：OpenAI Responses API，可选 OPENAI_BASE_URL、OPENAI_MODEL
 * - OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_MODEL：任意兼容 /chat/completions 的服务
 * - 都没有：Claude（ANTHROPIC_API_KEY）
 */
export function providerFromEnv(): Provider {
  const env = process.env;
  if (env.OPENAI_API_KEY) {
    return openaiResponsesProvider({
      baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-5",
    });
  }
  if (env.OPENAI_COMPAT_BASE_URL) {
    if (!env.OPENAI_COMPAT_MODEL) throw new Error("OPENAI_COMPAT_MODEL is required when OPENAI_COMPAT_BASE_URL is set");
    return openaiCompatProvider({
      baseURL: env.OPENAI_COMPAT_BASE_URL,
      apiKey: env.OPENAI_COMPAT_API_KEY,
      model: env.OPENAI_COMPAT_MODEL,
    });
  }
  return anthropicProvider({ effort: "medium" });
}
