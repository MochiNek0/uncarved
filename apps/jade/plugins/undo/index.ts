// jade/undo：/undo 把模型上一轮改过的文件恢复原样（再执行一次撤销更早的一轮）。
//
// jade/fs 不再保存检查点，这里自己观察：tool.before 在写文件的工具（meta.writes，例如 write_file）执行前记下文件原来的内容，
// tool.after 在执行成功后记下新内容的哈希，存成快照（checkpoint.ts）。tool.before 在审批之前执行，
// 所以等用户批准期间别人对文件的改动会算进"原来的内容"。
// shell 命令改的文件：在 git 仓库里，每轮第一次执行命令（meta.shell，例如 bash）之前给工作区拍一张快照（snapshot.ts），一轮结束时再拍一张，
// 撤销时把这两张之间变了的文件恢复回去。子 Agent 的命令算在根会话的这一轮里：整棵会话树一轮只在第一次跑命令之前拍一张。
// undo@1：用户自己执行的命令（/sh）前后各拍一张，单独算一步撤销。
// 认工具靠它注册时给的 meta，不认工具名：换掉提供文件工具的插件照样能撤销。

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Commands, Prompts, Undo } from "@uncarved/jade-api/services";
import { Checkpoints, lastTurnChanges, safe, sha256, turnToolNames, type Checkpoint } from "./checkpoint.ts";
import { snapshotsAt, type Change, type Snapshot, type Snapshots } from "./snapshot.ts";
import { dim, ok } from "./style.ts";

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

/** 打开着的会话：会话 id → 它的 tool.decided 事件 id → toolUseId（子会话的 parent 只给事件 id） */
const decidedBy = new Map<string, Map<string, string>>();
/** 打开着的会话：会话 id → 它的改动记在哪个根会话、算作根会话里哪次调用的 */
const links = new Map<string, () => { root: string; via?: string }>();
/** 根会话 id → 这一轮的工作区快照：整棵会话树（包括并行的子 Agent）第一次跑命令之前拍的那张。根会话这一轮结束时清掉 */
const turnSnaps = new Map<string, Promise<{ snapshots: Snapshots; toolUseId: string } | undefined>>();
/** 根会话 id → 正在给这一轮的快照补拍结束时的 tree：/undo、下一张快照先等它 */
const closing = new Map<string, Promise<void>>();

const now = () => performance.timeOrigin + performance.now();
/** 会话的工作区快照（子 Agent 的记在根会话里） */
const snapshotsOf = (home: string, sessionId: string, cwd: string) => snapshotsAt(path.join(home, "checkpoints", safe(sessionId)), cwd);

/** 根会话这一轮结束：拍过快照的话补上结束时的 tree。返回补拍完成 */
function closeTurn(root: string): Promise<void> | undefined {
  const p = turnSnaps.get(root);
  if (!p) return undefined;
  turnSnaps.delete(root);
  const done = p
    .then((r) => r?.snapshots.close(r.toolUseId))
    .catch(() => {
      // 补拍不了：撤销时退回到和工作区现在的样子比
    });
  closing.set(root, done);
  return done;
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
    ctx.provide("undo@1", {
      async track(session, label, fn) {
        if (ctx.config.shell === false) return fn();
        const snapshots = snapshotsOf(ctx.home, session, ctx.cwd);
        await closing.get(session);
        let id: string | undefined;
        try {
          const tree = await snapshots.take();
          if (tree) {
            id = `user-${randomUUID()}`;
            await snapshots.save({ toolUseId: id, tree, label, at: now() });
          }
        } catch {
          // 拍不了快照：照样执行，只是撤销不了
        }
        try {
          return await fn();
        } finally {
          if (id) await snapshots.close(id).catch(() => {});
        }
      },
    } satisfies Undo);
    /** 文件的显示名：恢复前算好（恢复时会删掉新建的文件）。文件可能已经不在了：解析它所在的目录 */
    const shownName = (p: string) => display(cwd, path.join(realPath(path.dirname(p)), path.basename(p)));
    /** 撤销用户自己执行的命令（undo@1.track 记下的一步） */
    const undoRun = async (sessionId: string, snapshots: Snapshots, run: Snapshot, { changes, conflicts }: { changes: Change[]; conflicts: Set<string> }, ui: UI, signal: AbortSignal) => {
      const shown = new Map(changes.map((c) => [c.path, shownName(c.path)]));
      const rows = changes.map((c) => `  ${c.added ? "delete " : "restore"} ${shown.get(c.path)}`);
      const list = rows.length > MAX_LISTED ? [...rows.slice(0, MAX_LISTED), `  … ${rows.length - MAX_LISTED} more`].join("\n") : rows.join("\n");
      const changed = changes.filter((c) => conflicts.has(c.path)).map((c) => shown.get(c.path)!);
      const files = `${changes.length} file${changes.length > 1 ? "s" : ""}`;
      const answer = await ui.select(
        {
          title:
            changed.length > 0
              ? `${changed.join(", ")} changed since your command ${run.label} ran. Undo it anyway and discard those changes too?`
              : `Undo your command ${run.label} (${files})?`,
          detail: list,
          options: [
            { label: "No", value: "no" },
            { label: changed.length > 0 ? "Yes, undo anyway" : "Yes, undo", value: "yes" },
          ],
        },
        signal,
      );
      if (answer !== "yes") return;
      await snapshots.restore(run.tree, changes);
      await checkpoints.markUndone(sessionId, [run.toolUseId]);
      const what = changes.slice(0, MAX_LISTED).map((c) => (c.added ? `deleted ${shown.get(c.path)} (the command had created it)` : `restored ${shown.get(c.path)}`));
      if (changes.length > MAX_LISTED) what.push(`and ${changes.length - MAX_LISTED} more files`);
      ctx.service<Prompts>("prompts@1")?.note(sessionId, `The user undid what their own shell command ${run.label} changed: ${what.join("; ")}. Read these files again before changing them.`);
      return [ok(`Undid your command ${run.label} (${files}):`), "\n", dim(list)];
    };
    ctx.service<Commands>("commands@1")?.register({
      name: "undo",
      description: "restore the files the agent changed in its last turn; in a git repository that includes what its shell commands changed (run again to go further back)",
      async run(_args, { sessions, ui, signal }) {
        const s = sessions.current;
        if (!s) return "No session is open.";
        await closing.get(s.id);
        const snapshots = snapshotsOf(ctx.home, s.id, ctx.cwd);
        const undone = await checkpoints.undone(s.id);
        const snaps = await snapshots.list();
        /** 用户自己执行的命令，最新的在前：不属于哪一轮，按时间和 Agent 的轮次排先后 */
        const runs = snaps.filter((x) => x.label !== undefined);
        const entries = [...(await checkpoints.list(s.id)), ...snaps.filter((x) => x.label === undefined)].sort((x, y) => y.at - x.at);
        /** 这一轮文件工具的快照（最新的在前）、命令之前的工作区快照、撤销它要动的文件、其中之后又被改过的 */
        let cps: Checkpoint[] = [];
        let snap: Snapshot | undefined;
        let tree: Change[] = [];
        let conflicts = new Set<string>();
        for (;;) {
          const hits = lastTurnChanges<Checkpoint | Snapshot>(s.state.messages, entries, undone);
          // 用户的命令比这一轮的改动新（例如这一轮之后跑的 !npm i）：先撤销它。它引出的那一轮比它晚，先撤那一轮
          const run = runs.find((r) => !undone.has(r.toolUseId));
          if (run && (hits.length === 0 || run.at > Math.min(...hits.map((h) => h.at)))) {
            const found = await snapshots.changes(run);
            if (found.changes.length > 0) return undoRun(s.id, snapshots, run, found, ui, signal);
            // 命令什么都没改（或者已经改回去了）：看更早的
            undone.add(run.toolUseId);
            await checkpoints.markUndone(s.id, [run.toolUseId]);
            continue;
          }
          cps = hits.filter((h): h is Checkpoint => "path" in h);
          snap = hits.find((h): h is Snapshot => "tree" in h);
          ({ changes: tree, conflicts } = snap ? await snapshots.changes(snap) : { changes: [], conflicts: new Set<string>() });
          if (!snap || cps.length > 0 || tree.length > 0) break;
          // 命令什么都没改（或者已经改回去了）的一轮：没有可撤销的，看更早的一轮
          undone.add(snap.toolUseId);
          await checkpoints.markUndone(s.id, [snap.toolUseId]);
        }
        // 这个会话里拍到过快照，说明命令的改动撤销得了，不用提醒
        const ranShell = (names: Set<string>) => [...names].some((n) => s.tool(n)?.meta?.shell !== undefined);
        if (cps.length === 0 && !snap) return dim(snaps.length === 0 && ranShell(turnToolNames(s.state.messages)) ? `Nothing to undo. ${SHELL_NOTE}` : "Nothing to undo.");
        // 没拍到快照（不在 git 仓库里、配置关掉了）的那一轮跑过命令时提醒一句
        const shellToo = !snap && ranShell(turnToolNames(s.state.messages, cps[0]!.toolUseId));
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
        // 工作区快照覆盖到的文件按快照判断：这一轮结束之后又变了的才算"别人改过"
        for (const cp of latest.values()) if (!inTree.has(same(cp.path)) && !(await checkpoints.unchangedSince(cp))) changed.push(show(cp.path));
        for (const c of tree) if (conflicts.has(c.path)) changed.push(show(c.path));
        const rows = [...plan.values()].map((f) => `  ${f.gone ? "delete " : "restore"} ${show(f.path)}`);
        const list = rows.length > MAX_LISTED ? [...rows.slice(0, MAX_LISTED), `  … ${rows.length - MAX_LISTED} more`].join("\n") : rows.join("\n");
        if (plan.size > 1 || changed.length > 0 || tree.length > 0) {
          const ok = await ui.select(
            {
              title:
                changed.length > 0
                  ? `${changed.join(", ")} changed since the agent wrote ${changed.length > 1 ? "them" : "it"}. Undo anyway and discard those changes too?`
                  : tree.length > 0
                    ? `Undo the agent's last turn (${plan.size} file${plan.size > 1 ? "s" : ""})? It ran shell commands: these files go back to how they were before the first command${snap?.after ? "." : ", and edits you made to them since then are lost too."}`
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
        return [ok(title), "\n", dim(list), ...(shellToo ? ["\n", dim(SHELL_NOTE)] : [])];
      },
    });
  },

  session(ctx) {
    const checkpoints = new Checkpoints(path.join(ctx.home, "checkpoints"));
    const sessionId = ctx.session.id;
    const decided = new Map<string, string>();
    decidedBy.set(sessionId, decided);
    /**
     * 子会话（子 Agent）的改动记在根会话里，算作根会话里打开它的那次调用的：父会话 /undo 时和那一轮的改动一起撤销。
     * 父会话的 tool.decided 在工具执行之前就记下了，所以子会话开好时查得到
     */
    const link = (): { root: string; via?: string } => {
      const p = ctx.session.parent;
      if (!p) return { root: sessionId };
      const up = links.get(p.sessionId)?.();
      if (up?.via) return up;
      const via = decidedBy.get(p.sessionId)?.get(p.eventId);
      return { root: up?.root ?? p.sessionId, ...(via ? { via } : {}) };
    };
    links.set(sessionId, link);
    void ctx.effect(() => () => {
      if (decidedBy.get(sessionId) === decided) decidedBy.delete(sessionId);
      if (links.get(sessionId) === link) links.delete(sessionId);
      if (!ctx.session.parent) closeTurn(sessionId);
    });
    /** toolUseId → 执行前的内容，执行成功后存成快照 */
    const before = new Map<string, { tool: string; path: string; before: string | null }>();
    /**
     * 这一轮第一次跑命令之前给工作区拍快照：整棵会话树（根会话和它这一轮开的子 Agent）共用一张，记在根会话里。
     * 并行的子 Agent 同时要跑命令时等同一张拍完
     */
    const beforeCommand = (toolUseId: string) => {
      const { root, via } = link();
      let p = turnSnaps.get(root);
      if (!p) {
        const snapshots = snapshotsOf(ctx.home, root, ctx.cwd);
        p = (async () => {
          await closing.get(root);
          const tree = await snapshots.take();
          if (!tree) return undefined;
          await snapshots.save({ toolUseId, tree, at: now(), ...(via ? { via } : {}) });
          return { snapshots, toolUseId };
        })().catch(() => undefined);
        turnSnaps.set(root, p);
      }
      return p;
    };

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      // 排在 jade/approval 把路径换成绝对路径之后；出错时只是没有快照，不影响工具执行
      order: 50,
      optional: true,
      // 第一次给大仓库拍快照要把每个文件算一遍哈希
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      fn: async (call) => {
        const meta = ctx.session.tool(call.name)?.meta;
        // 每轮第一次跑命令之前给工作区拍一张快照：命令改了什么，/undo 时和它一比就知道
        if (meta?.shell !== undefined && ctx.config.shell !== false) {
          await beforeCommand(call.toolUseId);
          return;
        }
        if (meta?.writes === undefined) return;
        const p = (call.input as Record<string, unknown> | null)?.[meta.writes];
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
        const { root, via } = link();
        await checkpoints.save(root, { toolUseId: out.call.toolUseId, ...snap, afterHash: sha256(after ?? ""), ...(via ? { via } : {}) });
      },
    });
    // 被拒绝、被中断的调用不经过 tool.after：一轮结束时还留着的都不会再用到，不然整个文件的内容一直占着内存
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: (e) => {
        if (e.type === "tool.decided") decided.set(e.id, (e.data as { toolUseId: string }).toolUseId);
        if (e.type !== "turn.ended") return;
        before.clear();
        // 只有这一轮里开的子会话查它（子会话在打开它的那次调用里结束）
        decided.clear();
        // 子会话结束不算：它的命令属于根会话这一轮。
        // 返回补拍：内核等 observe 完成才交还这一轮（5.1），之后用户再动的文件不会被拍进这一轮
        if (!ctx.session.parent) return closeTurn(sessionId);
      },
    });
  },
});
