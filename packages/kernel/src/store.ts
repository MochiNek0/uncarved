// 日志存储接口。对应宪法 4.3。

import type { LogEvent } from "./types.ts";

export interface LogStore {
  /** resolve 即代表已持久化 */
  append(sessionId: string, events: LogEvent[]): Promise<void>;
  read(sessionId: string, fromSeq?: number): AsyncIterable<LogEvent>;
}

export class MemoryLogStore implements LogStore {
  #logs = new Map<string, LogEvent[]>();

  async append(sessionId: string, events: LogEvent[]): Promise<void> {
    const log = this.#logs.get(sessionId) ?? [];
    // 拷贝一份，防止调用方之后修改已写入的事件（I-3）
    log.push(...events.map((e) => structuredClone(e)));
    this.#logs.set(sessionId, log);
  }

  async *read(sessionId: string, fromSeq = 1): AsyncIterable<LogEvent> {
    for (const e of this.#logs.get(sessionId) ?? []) {
      if (e.seq >= fromSeq) yield structuredClone(e);
    }
  }
}

export async function readAll(store: LogStore, sessionId: string): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for await (const e of store.read(sessionId)) out.push(e);
  return out;
}
