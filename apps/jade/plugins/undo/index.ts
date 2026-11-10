// jade/undo：/undo 把模型上一轮改过的文件恢复原样（再执行一次撤销更早的一轮）。
//
// jade/fs 不再保存检查点，这里自己观察：tool.before 在 write_file / edit_file / multi_edit 执行前记下文件原来的内容，
// tool.after 在执行成功后记下新内容的哈希，存成快照（checkpoint.ts）。tool.before 在审批之前执行，
// 所以等用户批准期间别人对文件的改动会算进"原来的内容"。

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { definePlugin } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import { Checkpoints, lastTurnChanges, sha256, turnToolNames, type Checkpoint } from "./checkpoint.ts";
import { dim, green } from "./style.ts";

/** 会改文件、参数里有 path 的工具 */
export const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

/** shell 命令改了什么无从得知，撤销不了；这一轮跑过时提醒一句 */
const SHELL_NOTE = "This turn also ran shell commands; what they changed is not undone.";

/** 显示用：工作目录内的路径用相对形式，统一为正斜杠 */
function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** 文件现在的内容；不存在时 null */
async function contentOf(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export default definePlugin({
  process(ctx) {
    const checkpoints = new Checkpoints(path.join(ctx.home, "checkpoints"));
    const cwd = realPath(ctx.cwd);
    ctx.service<Commands>("commands@1")?.register({
      name: "undo",
      description: "restore the files the agent wrote or edited in its last turn, not changes made by shell commands (run again to go further back)",
      async run(_args, { sessions, ui, signal }) {
        const s = sessions.current;
        if (!s) return "No session is open.";
        const undone = await checkpoints.undone(s.id);
        const cps = lastTurnChanges(s.state.messages, await checkpoints.list(s.id), undone);
        if (cps.length === 0) return dim(turnToolNames(s.state.messages).has("bash") ? `Nothing to undo. ${SHELL_NOTE}` : "Nothing to undo.");
        const shellToo = turnToolNames(s.state.messages, cps[0]!.toolUseId).has("bash");
        /** 文件 → 这一轮最早的快照（恢复成它的 before）；cps 是最新的在前 */
        const files = new Map<string, Checkpoint>();
        for (const cp of cps) files.set(cp.path, cp);
        // 恢复前就算好显示的名字：恢复时会删掉 agent 新建的文件。文件可能已经不在了（agent 删掉的）：解析它所在的目录
        const shown = new Map([...files.keys()].map((p) => [p, display(cwd, path.join(realPath(path.dirname(p)), path.basename(p)))]));
        const show = (p: string) => shown.get(p) ?? display(cwd, p);
        // 只有最新一次写入之后的内容能和文件现在的样子比较
        const latest = new Map<string, Checkpoint>();
        for (const cp of cps) if (!latest.has(cp.path)) latest.set(cp.path, cp);
        const changed: string[] = [];
        for (const cp of latest.values()) if (!(await checkpoints.unchangedSince(cp))) changed.push(show(cp.path));
        const list = [...files.values()].map((cp) => `  ${cp.before === null ? "delete " : "restore"} ${show(cp.path)}`).join("\n");
        if (files.size > 1 || changed.length > 0) {
          const ok = await ui.select(
            {
              title:
                changed.length > 0
                  ? `${changed.join(", ")} changed since the agent wrote ${changed.length > 1 ? "them" : "it"}. Undo anyway and discard those changes too?`
                  : `Undo the agent's last turn of changes (${files.size} files)?`,
              detail: list,
              options: [
                { label: "No", value: "no" },
                { label: changed.length > 0 ? "Yes, undo anyway" : "Yes, undo", value: "yes" },
              ],
            },
            signal,
          );
          if (ok !== "yes") return;
        }
        // 最新的先恢复：同一个文件最后恢复成这一轮最早的 before
        for (const cp of cps) await checkpoints.restore(cp);
        await checkpoints.markUndone(s.id, cps.map((c) => c.toolUseId));
        const what = [...files.values()].map((cp) =>
          cp.before === null ? `deleted ${show(cp.path)} (you had created it)` : `restored ${show(cp.path)} to its content before your changes`,
        );
        ctx.service<Prompts>("prompts@1")?.note(s.id, `The user undid your changes from your last turn: ${what.join("; ")}. Read these files again before changing them.`);
        return green(`Undid ${cps.length} change${cps.length > 1 ? "s" : ""} from the last turn:`) + "\n" + dim(list) + (shellToo ? `\n${dim(SHELL_NOTE)}` : "");
      },
    });
  },

  session(ctx) {
    const checkpoints = new Checkpoints(path.join(ctx.home, "checkpoints"));
    const sessionId = ctx.session.id;
    /** toolUseId → 执行前的内容，执行成功后存成快照 */
    const before = new Map<string, { tool: string; path: string; before: string | null }>();

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      // 排在 jade/approval 把路径换成绝对路径之后；出错时只是没有快照，不影响工具执行
      order: 50,
      optional: true,
      fn: async (call) => {
        if (!WRITE_TOOLS.has(call.name)) return;
        const p = (call.input as { path?: unknown } | null)?.path;
        if (typeof p !== "string") return;
        const full = path.resolve(ctx.cwd, p);
        before.set(call.toolUseId, { tool: call.name, path: full, before: await contentOf(full) });
      },
    });
    ctx.kernel.hook({
      kind: "transform",
      point: "tool.after",
      optional: true,
      fn: async (out) => {
        const snap = before.get(out.call.toolUseId);
        if (!snap) return;
        before.delete(out.call.toolUseId);
        if (out.isError) return;
        const after = await contentOf(snap.path);
        // 内容没变（例如同样的内容重复写入）不算修改
        if (after === snap.before) return;
        await checkpoints.save(sessionId, { toolUseId: out.call.toolUseId, ...snap, afterHash: sha256(after ?? "") });
      },
    });
    // 被拒绝、被中断的调用不经过 tool.after：一轮结束时还留着的都不会再用到，不然整个文件的内容一直占着内存
    ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => void (e.type === "turn.ended" && before.clear()) });
  },
});
