// 给模型的说明（[Note from jade]，prompts@1 的 note）：命令里做的事（例如用户删掉了一条记忆、撤销了模型改的文件）
// 要让模型知道，但命令拿不到会话日志，也不该替用户发一条消息。所以先记下来，下一次请求模型时在 context.project 里
// 附在最后一条消息后面，并用 ctx.record 写进日志（derived）：之后的投影、恢复的会话里它都在同一个位置。

import type { Block, LocalHookSpec, Message } from "uncarved";

export interface Note {
  /** 留下这条说明的插件 */
  plugin: string;
  text: string;
  /** 项目层插件留的说明不可信 */
  trusted: boolean;
}

/** derived 里：消息的下标 → 附在它后面的说明 */
type NotesState = Record<string, Note[]>;

export class Notes {
  /** 会话 → 还没交给模型的说明 */
  readonly #pending = new Map<string, Note[]>();

  add(sessionId: string, note: Note): void {
    this.#pending.set(sessionId, [...(this.#pending.get(sessionId) ?? []), note]);
  }

  /** 会话关闭：还没交给模型的说明不再留着 */
  drop(sessionId: string): void {
    this.#pending.delete(sessionId);
  }

  /** 会话里的 context.project hook；key 是 derived 里的键 */
  hook(sessionId: string, key: string): LocalHookSpec {
    return {
      kind: "transform",
      point: "context.project",
      order: -40,
      fn: async (messages, ctx) => {
        let state = (ctx.derived[key] as NotesState | undefined) ?? {};
        const fresh = this.#pending.get(sessionId);
        if (fresh?.length && messages.length > 0) {
          const at = String(messages.length - 1);
          state = { ...state, [at]: [...(state[at] ?? []), ...fresh] };
          await ctx.record(key, state);
          this.#pending.delete(sessionId);
        }
        return messages.map((m, i): Message => {
          const notes = state[i];
          if (!notes?.length || m.role !== "user") return m;
          const blocks: Block[] = notes.map((n) => ({ kind: "text", text: `[Note from jade] ${n.text}`, origin: { by: "plugin", id: n.plugin }, trust: n.trusted ? "trusted" : "untrusted" }));
          return { ...m, content: [...m.content, ...blocks] };
        });
      },
    };
  }
}
