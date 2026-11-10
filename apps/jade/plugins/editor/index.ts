// jade/editor：Ctrl+G 把输入框里的文字交给 $EDITOR 编辑，存盘退出后换回输入框。
//
// 终端编辑器（vim、nano）要独占终端：经 ui@1 的 suspend 让前端把终端让出来，编辑器退出后前端重新接管。
// 图形编辑器（"code --wait"）不需要终端，但走同一条路也没有坏处。前端不提供 suspend 或没有输入框时做不了，提示一句。

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePlugin, type Draft, type UI } from "@uncarved/jade-api";
import type { Key, Keys } from "@uncarved/jade-api/services";

const DEFAULT_KEY = "ctrl+g";

/** 用哪个编辑器：配置的 editor，否则 $VISUAL、$EDITOR，都没有时 vi（Windows 上是 notepad） */
export function editorCommand(configured: unknown, env: Record<string, string | undefined> = process.env): string {
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (process.platform === "win32" ? "notepad" : "vi");
}

/** 经 shell 启动编辑器（命令里可以带参数，例如 "code --wait"），等它退出；返回退出码 */
function run(command: string, file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${command} "${file}"`, { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

/** 正在显示的会话的输入框：会话级的 ctx 才有，按键是进程级注册的 */
let input: Draft | undefined;
/** 编辑器开着的时候再按一次不再开一个 */
let editing = false;
/** 按键没注册上的原因（被别的插件占了、配置写错了）：第一个会话打开时告诉用户一次 */
let noKey: string | undefined;

export default definePlugin({
  process(ctx) {
    const key = typeof ctx.config.key === "string" && ctx.config.key ? ctx.config.key : DEFAULT_KEY;
    const binding: Key = {
      key,
      description: "edit the input in $EDITOR",
      async run() {
        const ui = ctx.service<UI>("ui@1");
        const draft = input;
        if (!ui?.suspend || !draft) return ui?.notify("this front end cannot hand the terminal to an editor", "warning");
        if (editing) return;
        editing = true;
        const command = editorCommand(ctx.config.editor);
        const dir = await mkdtemp(path.join(os.tmpdir(), "jade-edit-"));
        // .md：编辑器按 Markdown 高亮，消息多半就是 Markdown
        const file = path.join(dir, "message.md");
        try {
          await writeFile(file, draft.text());
          const code = await ui.suspend(() => run(command, file));
          if (code !== 0) return ui.notify(`${command} exited with code ${code}; the input was left as it was`, "warning");
          // 编辑器存盘时加的最后一个换行不算
          draft.set((await readFile(file, "utf8")).replace(/\r?\n$/, ""));
        } catch (e) {
          ui.notify(`could not edit the input with ${command}: ${e instanceof Error ? e.message : String(e)}`, "error");
        } finally {
          editing = false;
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
    // 键被别的插件占了不算这个插件坏了：只是没有这个键，换一个就行
    noKey = undefined;
    try {
      ctx.require<Keys>("keys@1").register(binding);
    } catch (e) {
      noKey = `${e instanceof Error ? e.message : String(e)}; set {"jade/editor": {"key": "ctrl+<letter>"}} in config.json to use another key`;
    }
  },

  async session(ctx) {
    if (noKey) {
      ctx.service<UI>("ui@1")?.notify(`jade/editor: ${noKey}`, "warning");
      noKey = undefined;
    }
    const draft = ctx.input;
    if (!draft) return;
    input = draft;
    await ctx.effect(() => () => {
      if (input === draft) input = undefined;
    });
  },
});
