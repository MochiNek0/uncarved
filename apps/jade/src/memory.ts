// 记忆：跨会话记住的用户习惯和项目知识。
//
// 两个范围：user（所有项目通用，$JADE_HOME/MEMORY.md）和 project（这个仓库，$JADE_HOME/projects/<key>/MEMORY.md）。
// 都放在配置目录而不是仓库里：不会被提交，也不会被别人的仓库带进来。
// 文件是 Markdown 列表，一行一条，用户可以直接编辑。会话开始时由 prompts 插件读进系统提示词，
// 模型用 memory 工具增删，用户用 /memory 查看和管理。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "uncarved";

export const MEMORY_SCOPES = ["user", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 每个范围最多保留的条数；系统提示词里放不下太多 */
const MAX_ENTRIES = 100;
const MAX_ENTRY_CHARS = 500;

export class Memory {
  readonly files: Record<MemoryScope, string>;

  /** root：项目的根目录（git 仓库根，否则是工作目录），决定项目记忆存在哪里 */
  constructor(home: string, root: string) {
    this.files = { user: path.join(home, "MEMORY.md"), project: path.join(home, "projects", projectKey(root), "MEMORY.md") };
  }

  async list(scope: MemoryScope): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.files[scope], "utf8");
    } catch {
      return [];
    }
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  /** 加一条；已经有同样的一条时不重复。返回是否加入 */
  async add(scope: MemoryScope, text: string): Promise<boolean> {
    const entry = text.replace(/\s+/g, " ").trim();
    if (!entry) throw new Error("the memory is empty");
    if (entry.length > MAX_ENTRY_CHARS) throw new Error(`a memory is at most ${MAX_ENTRY_CHARS} characters; make it shorter`);
    const all = await this.list(scope);
    if (all.includes(entry)) return false;
    if (all.length >= MAX_ENTRIES) throw new Error(`the ${scope} memory already has ${MAX_ENTRIES} entries; remove outdated ones first`);
    await this.#write(scope, [...all, entry]);
    return true;
  }

  /** 删掉内容完全相同的一条，或者唯一包含 text 的那一条。返回删掉的那条 */
  async remove(scope: MemoryScope, text: string): Promise<string | undefined> {
    const all = await this.list(scope);
    const needle = text.replace(/\s+/g, " ").trim();
    let i = all.indexOf(needle);
    if (i < 0) {
      const hits = all.flatMap((e, j) => (e.includes(needle) ? [j] : []));
      if (hits.length > 1) throw new Error(`${hits.length} ${scope} memories contain "${needle}"; give the exact text of the one to remove`);
      i = hits[0] ?? -1;
    }
    if (i < 0) return undefined;
    const [removed] = all.splice(i, 1);
    await this.#write(scope, all);
    return removed;
  }

  /** 系统提示词里的一段；没有记忆时返回 undefined */
  async prompt(): Promise<string | undefined> {
    const sections: string[] = [];
    for (const scope of MEMORY_SCOPES) {
      const all = await this.list(scope);
      if (all.length) sections.push(`## ${scope === "user" ? "About the user (all projects)" : "About this project"}\n${all.map((e) => `- ${e}`).join("\n")}`);
    }
    if (!sections.length) return undefined;
    return (
      "# Memory\n" +
      "What you saved with the memory tool in earlier sessions. Follow it unless the user says otherwise now; " +
      "if an entry turns out to be wrong or outdated, fix it with the memory tool.\n\n" +
      sections.join("\n\n")
    );
  }

  async #write(scope: MemoryScope, entries: string[]) {
    const file = this.files[scope];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entries.map((e) => `- ${e}`).join("\n") + (entries.length ? "\n" : ""));
  }
}

/** 项目记忆的目录名：可读的路径加上短哈希，避免不同路径化简后撞名 */
export function projectKey(root: string): string {
  const full = path.resolve(root);
  const readable = full.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-60);
  return `${readable}-${createHash("sha256").update(full.toLowerCase()).digest("hex").slice(0, 8)}`;
}

export function memoryTool(memory: Memory): Tool {
  return {
    name: "memory",
    description:
      "Save or remove a memory that is loaded into the system prompt of every future session. " +
      "Save when the user states a lasting preference or corrects how you work (scope user, e.g. language, style, tools they like), " +
      "or when you learn a non-obvious fact about this project that future sessions need (scope project, e.g. how to run the tests, where a subsystem lives, a pitfall). " +
      "Do not save what the code or the instruction files already say, secrets, or details that only matter for the current task. " +
      "One short, self-contained sentence per memory. To change one, remove it and add the new version.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"] },
        scope: { type: "string", enum: [...MEMORY_SCOPES] },
        text: { type: "string", description: "The memory to add, or the exact text (or a unique part) of the one to remove" },
      },
      required: ["action", "scope", "text"],
      additionalProperties: false,
    },
    // 写在配置目录里，影响之后的每个会话
    effect: "write",
    concurrency: "exclusive",
    idempotent: true,
    async execute(input) {
      const { action, scope, text } = input as { action: "add" | "remove"; scope: MemoryScope; text: string };
      try {
        if (action === "add") {
          return { content: (await memory.add(scope, text)) ? `Saved to ${scope} memory.` : `The ${scope} memory already has this.` };
        }
        const removed = await memory.remove(scope, text);
        return removed ? { content: `Removed from ${scope} memory: ${removed}` } : { content: `No ${scope} memory matches "${text}".`, isError: true };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
