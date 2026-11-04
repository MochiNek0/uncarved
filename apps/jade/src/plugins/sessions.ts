// 会话命令：jade/sessions 的 /clear、/resume、/retry，jade/undo 的 /undo。
// 它们只用第三方插件也拿得到的接口（插件上下文的 checkpoints，命令上下文的 session、ui、note），
// 停用或代替这两个内置插件时命令一起消失。

import type { JadePlugin, JadePluginContext, PluginCommand, SessionControl } from "./loader.ts";
import { ago, matchSession } from "../sessions.ts";
import { lastTurnChanges, UNDO_KEY, type Checkpoint, type UndoState } from "../tools/checkpoint.ts";
import { display } from "../tools/fs.ts";
import { dim, green } from "../ui/screen.ts";

/** 命令要的 session 不在（instant 命令或宿主没给）时的错误 */
function need(session: SessionControl | undefined, name: string): SessionControl {
  if (!session) throw new Error(`/${name} needs session control, which this host does not provide here`);
  return session;
}

export function sessionsPlugin(): JadePlugin {
  const clear: PluginCommand = {
    name: "clear",
    description: "start a new session (the current one stays resumable)",
    async run(_args, { session }) {
      await need(session, "clear").clear();
    },
  };
  const resume: PluginCommand = {
    name: "resume",
    args: "[id]",
    description: "pick a recent session in this directory and switch to it",
    async run(args, { session, sessionId, ui }) {
      const s = need(session, "resume");
      const all = await s.list();
      const arg = args.trim();
      let id: string | undefined;
      if (arg) id = matchSession(all, arg);
      else {
        const others = all.filter((x) => x.id !== sessionId).slice(0, 50);
        if (others.length === 0) return dim("No other sessions in this directory.");
        id = await ui.select(
          "Resume which session?",
          others.map((x) => ({ label: x.title || "(untitled)", value: x.id, hint: `${ago(x.at)} · ${x.id}` })),
        );
      }
      if (!id) return;
      if (id === sessionId) return dim("That is the current session.");
      await s.resume(id);
    },
  };
  const retry: PluginCommand = {
    name: "retry",
    description: "request the model again after a failed request, without sending another message",
    async run(_args, { session }) {
      if (!(await need(session, "retry").retry())) return dim("Nothing to retry: the last message already has a reply.");
    },
  };
  return { id: "jade/sessions", version: "0.1.0", kernel: "^0.1", commands: [clear, resume, retry] };
}

/**
 * /undo：撤销最近一轮里还没撤销的全部文件修改；同一个文件改过几次的，恢复到这一轮改它之前的样子。
 * 快照来自 ctx.checkpoints：jade/fs 的工具和第三方插件的工具记下的都算
 */
export function undoPlugin({ checkpoints, cwd }: Pick<JadePluginContext, "checkpoints" | "cwd">): JadePlugin {
  const undo: PluginCommand = {
    name: "undo",
    description: "restore every file the agent changed in its last turn (run again to go further back)",
    async run(_args, { session, sessionId, derived, ui, note }) {
      const s = need(session, "undo");
      const undone = new Set((derived[UNDO_KEY] as UndoState | undefined)?.undone ?? []);
      const cps = lastTurnChanges(s.messages(), await checkpoints.list(sessionId), undone);
      if (cps.length === 0) return dim("Nothing to undo.");
      /** 文件 → 这一轮最早的快照（恢复成它的 before）；cps 是最新的在前 */
      const files = new Map<string, Checkpoint>();
      for (const cp of cps) files.set(cp.path, cp);
      // 只有最新一次写入之后的内容能和文件现在的样子比较
      const latest = new Map<string, Checkpoint>();
      for (const cp of cps) if (!latest.has(cp.path)) latest.set(cp.path, cp);
      const changed: string[] = [];
      for (const cp of latest.values()) if (!(await checkpoints.unchangedSince(cp))) changed.push(display(cwd, cp.path));
      const list = [...files.values()].map((cp) => `  ${cp.before === null ? "delete " : "restore"} ${display(cwd, cp.path)}`).join("\n");
      if (files.size > 1 || changed.length > 0) {
        const ok = await ui.select(
          changed.length > 0
            ? `${changed.join(", ")} changed since the agent wrote ${changed.length > 1 ? "them" : "it"}. Undo anyway and discard those changes too?`
            : `Undo the agent's last turn of changes (${files.size} files)?`,
          [
            { label: "No", value: false },
            { label: changed.length > 0 ? "Yes, undo anyway" : "Yes, undo", value: true },
          ],
          { body: list },
        );
        if (!ok) return;
      }
      for (const cp of cps) await checkpoints.restore(cp);
      await s.record(UNDO_KEY, { undone: [...undone, ...cps.map((c) => c.toolUseId)] } satisfies UndoState);
      const what = [...files.values()].map((cp) =>
        cp.before === null ? `deleted ${display(cwd, cp.path)} (you had created it)` : `restored ${display(cwd, cp.path)} to its content before your changes`,
      );
      note(`The user undid your changes from your last turn: ${what.join("; ")}. Read these files again before changing them.`);
      return green(`Undid ${cps.length} change${cps.length > 1 ? "s" : ""} from the last turn:`) + "\n" + dim(list);
    },
  };
  return { id: "jade/undo", version: "0.1.0", kernel: "^0.1", commands: [undo] };
}
