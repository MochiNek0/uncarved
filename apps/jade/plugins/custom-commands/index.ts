// jade/custom-commands：把 Markdown 文件变成斜杠命令。常用的提示词写一次，之后 /名字 [参数] 就能发出去。
//
// 文件放在 $JADE_HOME/commands/<名字>.md（用户层）或 <工作目录>/.jade/commands/<名字>.md（项目层，随仓库分发）。
// 文件内容就是要发给模型的消息；$ARGUMENTS 换成命令后面的文字，没有这个占位符时参数接在最后。
// 开头可以有一段 frontmatter，description 显示在命令菜单里：
//
//   ---
//   description: review the staged changes
//   ---
//   Review the staged changes ($ARGUMENTS) ...
//
// 命令在启动时登记（新加的文件重启后生效），内容每次执行时重新读（改了马上生效）。
// 同名时用户层的优先；名字被别的插件的命令占用时不登记，告诉用户一次。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";

const MAX_DESCRIPTION = 80;

/** 拆出 frontmatter 里的 description 和正文 */
export function parseCommand(text: string): { description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text.trim() };
  const description = /^description:\s*(.+?)\s*$/m.exec(m[1]!)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  return { ...(description ? { description } : {}), body: text.slice(m[0].length).trim() };
}

/** 把参数放进正文：有 $ARGUMENTS 就替换，没有就接在最后 */
export function fill(body: string, args: string): string {
  const given = args.trim();
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", given);
  return given ? `${body}\n\n${given}` : body;
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  } catch {
    return [];
  }
}

export default definePlugin({
  async process(ctx) {
    const commands = ctx.require<Commands>("commands@1");
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const [dir, layer] of [
      [path.join(ctx.home, "commands"), "user"],
      [path.join(ctx.cwd, ".jade", "commands"), "project"],
    ] as const) {
      for (const file of await markdownFiles(dir)) {
        const name = file.slice(0, -3);
        // 用户层的已经登记了同名的：项目层的不盖过它
        if (seen.has(name.toLowerCase())) continue;
        const full = path.join(dir, file);
        let description: string | undefined;
        try {
          description = parseCommand(await readFile(full, "utf8")).description;
        } catch {
          continue;
        }
        const about = (description ?? `send ${layer === "user" ? full : path.join(".jade", "commands", file)}`).replace(/\s+/g, " ");
        try {
          commands.register({
            name,
            args: "[arguments]",
            description: `${about.length > MAX_DESCRIPTION ? `${about.slice(0, MAX_DESCRIPTION)}…` : about} (${layer} command)`,
            async run(args) {
              const { body } = parseCommand(await readFile(full, "utf8"));
              if (!body) return `${full} is empty.`;
              return { prompt: fill(body, args) };
            },
          });
          seen.add(name.toLowerCase());
        } catch (e) {
          skipped.push(`/${name} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
    if (skipped.length > 0) ctx.service<UI>("ui@1")?.notify(`jade/custom-commands: not registered: ${skipped.join("; ")}`, "warning");
  },
});
