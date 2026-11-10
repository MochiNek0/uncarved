// jade/undo：/undo 把模型上一轮改过的文件恢复原样（再执行一次撤销更早的一轮）。
//
// jade/fs 不再保存检查点，这里自己观察：tool.before 在 write_file / edit_file / multi_edit 执行前记下文件原来的内容，
// tool.after 在执行成功后记下新内容的哈希，存成快照（checkpoint.ts）。tool.before 在审批之前执行，
// 所以等用户批准期间别人对文件的改动会算进"原来的内容"。
// shell 命令改的文件：在 git 仓库里，每轮第一次 bash 之前给工作区拍一张快照（snapshot.ts），撤销时把之后变了的文件恢复回去。

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { definePlugin } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import { Checkpoints, lastTurnChanges, safe, sha256, turnToolNames, type Checkpoint } from "./checkpoint.ts";
import { Snapshots, type Change, type Snapshot } from "./snapshot.ts";
import { dim, green } from "./style.ts";

/** 会改文件、参数里有 path 的工具 */
export const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

/** 没有工作区快照（不在 git 仓库里、配置关掉了）时，shell 命令改了什么无从得知，撤销不了；这一轮跑过时提醒一句 */
const SHELL_NOTE = "This turn also ran shell commands; what they changed is not undone.";
/** 拍工作区快照的时限；过了这一轮就没有快照（不影响命令执行） */
const SNAPSHOT_TIMEOUT_MS = 60_000;
/** 对话框和结果里最多列出这么多个文件 */
const MAX_LISTED = 30;

/** 比较两个路径是不是同一个文件用的写法：git 给的和工具参数里的大小写、斜杠、短文件名可能不同 */
function same(p: string): string {
  const full = path.join(realPath(path.dirname(p)), path.basename(p));
  return process.platform === "win32" ? full.toLowerCase() : full;
}

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
      description: "restore the files the agent changed in its last turn; in a git repository that includes what its shell commands changed (run again to go further back)",
      async run(_args, { sessions, ui, signal }) {
        const s = sessions.current;
        if (!s) return "No session is open.";
        const snapshots = new Snapshots(path.join(ctx.home, "checkpoints", safe(s.id)), ctx.cwd);
        const undone = await checkpoints.undone(s.id);
        const snaps = await snapshots.list();
        const entries = [...(await checkpoints.list(s.id)), ...snaps].sort((x, y) => y.at - x.at);
        /** 这一轮文件工具的快照（最新的在前）、命令之前的工作区快照、工作区在那之后变了的文件 */
        let cps: Checkpoint[];
        let snap: Snapshot | undefined;
        let tree: Change[];
        for (;;) {
          const hits = lastTurnChanges<Checkpoint | Snapshot>(s.state.messages, entries, undone);
          cps = hits.filter((h): h is Checkpoint => "path" in h);
          snap = hits.find((h): h is Snapshot => "tree" in h);
          tree = snap ? await snapshots.changed(snap.tree) : [];
          if (!snap || cps.length > 0 || tree.length > 0) break;
          // 命令什么都没改（或者已经改回去了）的一轮：没有可撤销的，看更早的一轮
          undone.add(snap.toolUseId);
          await checkpoints.markUndone(s.id, [snap.toolUseId]);
        }
        // 这个会话里拍到过快照，说明命令的改动撤销得了，不用提醒
        if (cps.length === 0 && !snap) return dim(snaps.length === 0 && turnToolNames(s.state.messages).has("bash") ? `Nothing to undo. ${SHELL_NOTE}` : "Nothing to undo.");
        // 没拍到快照（不在 git 仓库里、配置关掉了）的那一轮跑过命令时提醒一句
        const shellToo = !snap && turnToolNames(s.state.messages, cps[0]!.toolUseId).has("bash");
        // 工作区快照覆盖到的文件按快照恢复（那是命令动它之前的内容）：拍快照之后文件工具对它的修改不再单独恢复
        const inTree = new Set(tree.map((c) => same(c.path)));
        const fileCps = cps.filter((cp) => !(snap && cp.at > snap.at && inTree.has(same(cp.path))));
        /** 文件 → 这一轮最早的快照（恢复成它的 before）；cps 是最新的在前 */
        const files = new Map<string, Checkpoint>();
        for (const cp of fileCps) files.set(cp.path, cp);
        /** 要恢复的全部文件：路径 → 恢复之后还在不在。先按工作区快照，再按文件快照（它更早，说了算） */
        const plan = new Map<string, { path: string; gone: boolean }>();
        for (const c of tree) plan.set(same(c.path), { path: c.path, gone: c.added });
        for (const cp of files.values()) plan.set(same(cp.path), { path: cp.path, gone: cp.before === null });
        // 恢复前就算好显示的名字：恢复时会删掉 agent 新建的文件。文件可能已经不在了（agent 删掉的）：解析它所在的目录
        const shown = new Map([...plan.values()].map((f) => [f.path, display(cwd, path.join(realPath(path.dirname(f.path)), path.basename(f.path)))]));
        const show = (p: string) => shown.get(p) ?? display(cwd, p);
        // 只有最新一次写入之后的内容能和文件现在的样子比较
        const latest = new Map<string, Checkpoint>();
        for (const cp of fileCps) if (!latest.has(cp.path)) latest.set(cp.path, cp);
        const changed: string[] = [];
        // 工作区快照之后变了的文件多半是命令改的，下面的问题里一起说明，不算"别人改过"
        for (const cp of latest.values()) if (!inTree.has(same(cp.path)) && !(await checkpoints.unchangedSince(cp))) changed.push(show(cp.path));
        const rows = [...plan.values()].map((f) => `  ${f.gone ? "delete " : "restore"} ${show(f.path)}`);
        const list = rows.length > MAX_LISTED ? [...rows.slice(0, MAX_LISTED), `  … ${rows.length - MAX_LISTED} more`].join("\n") : rows.join("\n");
        if (plan.size > 1 || changed.length > 0 || tree.length > 0) {
          const ok = await ui.select(
            {
              title:
                changed.length > 0
                  ? `${changed.join(", ")} changed since the agent wrote ${changed.length > 1 ? "them" : "it"}. Undo anyway and discard those changes too?`
                  : tree.length > 0
                    ? `Undo the agent's last turn (${plan.size} file${plan.size > 1 ? "s" : ""})? It ran shell commands: these files go back to how they were before the first command, and edits you made to them since then are lost too.`
                    : `Undo the agent's last turn of changes (${plan.size} files)?`,
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
        if (snap) await snapshots.restore(snap.tree, tree);
        // 最新的先恢复：同一个文件最后恢复成这一轮最早的 before
        for (const cp of fileCps) await checkpoints.restore(cp);
        await checkpoints.markUndone(s.id, [...cps.map((c) => c.toolUseId), ...(snap ? [snap.toolUseId] : [])]);
        const what = [...plan.values()].slice(0, MAX_LISTED).map((f) => (f.gone ? `deleted ${show(f.path)} (you had created it)` : `restored ${show(f.path)} to its content before your changes`));
        if (plan.size > MAX_LISTED) what.push(`and ${plan.size - MAX_LISTED} more files`);
        ctx.service<Prompts>("prompts@1")?.note(s.id, `The user undid your changes from your last turn: ${what.join("; ")}. Read these files again before changing them.`);
        const title = snap ? `Undid the last turn (${plan.size} file${plan.size > 1 ? "s" : ""}):` : `Undid ${cps.length} change${cps.length > 1 ? "s" : ""} from the last turn:`;
        return green(title) + "\n" + dim(list) + (shellToo ? `\n${dim(SHELL_NOTE)}` : "");
      },
    });
  },

  session(ctx) {
    const checkpoints = new Checkpoints(path.join(ctx.home, "checkpoints"));
    const sessionId = ctx.session.id;
    /** toolUseId → 执行前的内容，执行成功后存成快照 */
    const before = new Map<string, { tool: string; path: string; before: string | null }>();
    const snapshots = new Snapshots(path.join(ctx.home, "checkpoints", safe(sessionId)), ctx.cwd);
    /** 这一轮已经拍过工作区快照 */
    let snapped = false;

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      // 排在 jade/approval 把路径换成绝对路径之后；出错时只是没有快照，不影响工具执行
      order: 50,
      optional: true,
      // 第一次给大仓库拍快照要把每个文件算一遍哈希
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      fn: async (call) => {
        // 每轮第一次跑命令之前给工作区拍一张快照：命令改了什么，/undo 时和它一比就知道
        if (call.name === "bash" && ctx.config.shell !== false && !snapped) {
          snapped = true;
          const tree = await snapshots.take();
          if (tree) await snapshots.save({ toolUseId: call.toolUseId, tree, at: performance.timeOrigin + performance.now() });
          return;
        }
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
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type !== "turn.ended") return;
        before.clear();
        snapped = false;
      },
    });
  },
});
