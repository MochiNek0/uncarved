// jade/memory：跨会话的记忆（见 memory.ts）。memory 工具给模型增删，/memory 给用户查看和管理，
// 会话开始时经 prompts@1 把记忆放进系统提示词（会话中途的改动下一个会话才进提示词，这样提示缓存不失效；
// 用户在 /memory 里改了，下一次请求时附一条说明告诉模型）。

import { definePlugin } from "@uncarved/jade-api";
import type { Commands, Prompts, Renderers } from "@uncarved/jade-api/services";
import { Memory, MEMORY_SCOPES, memoryTool, projectRoot, type MemoryScope } from "./memory.ts";
import { clip, dim, error, ok as success } from "./style.ts";

const args = (input: unknown) => (input ?? {}) as { action?: string; scope?: string; text?: string };

export default definePlugin({
  process(ctx) {
    const memory = new Memory(ctx.home, projectRoot(ctx.cwd));

    ctx.service<Renderers>("renderers@1")?.tool({
      tool: "memory",
      summary: (input) => {
        const i = args(input);
        return `${i.action} ${i.scope}: ${clip(String(i.text ?? ""), 120)}`;
      },
      preview: (input) => {
        const i = args(input);
        return [i.action === "remove" ? error("- ") : success("+ "), String(i.text ?? "")];
      },
    });

    ctx.service<Commands>("commands@1")?.register({
      name: "memory",
      args: "[text]",
      description: "see and remove what jade remembers across sessions, or remember text",
      instant: true,
      async run(input, { ui, sessions, signal }) {
        const note = (text: string) => {
          const id = sessions.current?.id;
          // 用到的时候再取：可选服务在 process() 开头不一定已经有了
          if (id) ctx.service<Prompts>("prompts@1")?.note(id, text);
        };
        let text = input.trim();
        if (!text) {
          const entries = (await Promise.all(MEMORY_SCOPES.map(async (scope) => (await memory.list(scope)).map((t) => ({ scope, text: t }))))).flat();
          if (!ui.interactive) return entries.length ? entries.map((e) => `${e.scope}: ${e.text}`).join("\n") : "jade does not remember anything yet";
          const choice = await ui.select(
            {
              title: entries.length ? "Memory: choose an entry to remove it, or add one" : "jade does not remember anything yet",
              detail: dim(`user (all projects): ${memory.files.user}\nproject: ${memory.files.project}`),
              options: [{ label: "Add a memory…", value: "add" }, ...entries.map((e, i) => ({ label: e.text, value: String(i), hint: e.scope }))],
            },
            signal,
          );
          if (!choice) return;
          if (choice !== "add") {
            const entry = entries[Number(choice)]!;
            const ok = await ui.select(
              {
                title: `Remove this ${entry.scope} memory?`,
                detail: entry.text,
                options: [
                  { label: "No", value: "no" },
                  { label: "Yes, remove it", value: "yes" },
                ],
              },
              signal,
            );
            if (ok !== "yes") return;
            await memory.remove(entry.scope, entry.text);
            note(`The user removed this ${entry.scope} memory, so stop following it: ${entry.text}`);
            return success(`Removed from ${entry.scope} memory: ${entry.text}`);
          }
          text = (await ui.input({ title: "What should jade remember?", placeholder: "e.g. Reply in Chinese; run tests with bun test" }, signal)) ?? "";
          if (!text.trim()) return;
        }
        const scope = ui.interactive
          ? await ui.select<MemoryScope>(
              {
                title: "Remember it for",
                options: [
                  { label: "All projects", value: "user", hint: "user memory" },
                  { label: "This project only", value: "project", hint: "project memory" },
                ],
              },
              signal,
            )
          : "user";
        if (!scope) return;
        const added = await memory.add(scope, text);
        if (added) note(`The user saved a ${scope} memory; follow it from now on: ${text.replace(/\s+/g, " ").trim()}`);
        return added ? success(`Saved to ${scope} memory.`) : dim(`The ${scope} memory already has this.`);
      },
    });
  },

  async session(ctx) {
    const memory = new Memory(ctx.home, projectRoot(ctx.cwd));
    ctx.kernel.tool(memoryTool(memory));
    const text = await memory.prompt();
    // 段落随会话作用域撤销
    if (text) ctx.service<Prompts>("prompts@1")?.add({ text });
  },
});
