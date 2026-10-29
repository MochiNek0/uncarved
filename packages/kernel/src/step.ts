// 纯核心：step(state, event) => { state, effects }。对应宪法 4.1。
// 这里禁止任何 IO、时间、随机数，只依赖输入。

import type {
  Block,
  Effect,
  Event,
  EventDataMap,
  Message,
  PendingCall,
  Phase,
  State,
  StopReason,
  TurnEndReason,
} from "./types.ts";

export interface StepResult {
  state: State;
  effects: Effect[];
}

export class InvalidTransition extends Error {
  readonly eventType: string;
  readonly phase: Phase;
  constructor(eventType: string, phase: Phase, detail?: string) {
    super(`${eventType} not allowed in phase ${phase}${detail ? `: ${detail}` : ""}`);
    this.name = "InvalidTransition";
    this.eventType = eventType;
    this.phase = phase;
  }
}

export function initialState(sessionId: string): State {
  return { sessionId, lastSeq: 0, phase: "new", messages: [], batch: [], plugins: [], derived: {} };
}

export function step(s: State, e: Event): StepResult {
  if (e.seq !== s.lastSeq + 1) {
    throw new InvalidTransition(e.type, s.phase, `expected seq ${s.lastSeq + 1}, got ${e.seq}`);
  }
  const base: State = { ...s, lastSeq: e.seq };
  const expect = (...phases: Phase[]) => {
    if (!phases.includes(s.phase)) throw new InvalidTransition(e.type, s.phase);
  };

  switch (e.type) {
    case "session.started": {
      expect("new");
      const d = e.data as EventDataMap["session.started"];
      return ok({ ...base, phase: "idle", plugins: d.plugins, parent: d.parent });
    }

    case "plugins.changed": {
      const d = e.data as EventDataMap["plugins.changed"];
      return ok({ ...base, plugins: d.plugins });
    }

    case "input.received": {
      const d = e.data as EventDataMap["input.received"];
      if (d.kind === "message") {
        expect("idle");
        const messages: Message[] = [...s.messages, { role: "user", content: d.content }];
        return ok({ ...base, phase: "model", messages }, [{ type: "CallModel" }]);
      }
      expect("awaiting");
      const target = s.batch.find((c) => c.toolUseId === d.toolUseId && c.decision === "ask");
      if (!target) throw new InvalidTransition(e.type, s.phase, `no pending approval for ${d.toolUseId}`);
      const batch = s.batch.map((c) =>
        c === target
          ? { ...c, decision: d.approved ? ("allow" as const) : ("deny" as const), reason: d.reason, decidedBy: "user" }
          : c,
      );
      return settleDecisions({ ...base, batch });
    }

    case "model.requested":
      // continuing：turn.continue 放行后直接发起下一次请求，这条事件本身就是"继续"的记录
      expect("model", "continuing");
      return ok({ ...base, phase: "model" });

    case "model.responded": {
      expect("model");
      const d = e.data as EventDataMap["model.responded"];
      const next: State = { ...base, messages: [...s.messages, { role: "assistant", content: d.content }] };
      const calls: PendingCall[] = d.content.flatMap((b) =>
        b.kind === "tool_use" ? [{ toolUseId: b.id, name: b.name, input: b.input }] : [],
      );

      if (d.stopReason === "pause") return ok(next, [{ type: "CallModel" }]);

      if (d.stopReason === "tool_use" && calls.length > 0) {
        return ok({ ...next, phase: "deciding", batch: calls }, [
          { type: "DecideTools", toolUseIds: calls.map((c) => c.toolUseId) },
        ]);
      }

      // 被截断或拒绝的回复里可能带着不完整的 tool_use：一律不执行，补上错误结果，保证历史合法
      const reason = endReason(d.stopReason);
      return ok({ ...closeBatch({ ...next, batch: calls }), phase: "ending", ending: reason }, [
        { type: "EndTurn", reason },
      ]);
    }

    case "tool.decided": {
      expect("deciding");
      const d = e.data as EventDataMap["tool.decided"];
      const batch = updateCall(s, e.type, d.toolUseId, (c) => {
        if (c.decision) throw new InvalidTransition(e.type, s.phase, `${d.toolUseId} already decided`);
        return { ...c, decision: d.decision, input: d.input, reason: d.reason, decidedBy: d.decidedBy };
      });
      return settleDecisions({ ...base, batch });
    }

    case "tool.completed": {
      expect("tools");
      const d = e.data as EventDataMap["tool.completed"];
      const batch = updateCall(s, e.type, d.toolUseId, (c) => {
        if (c.decision !== "allow" || c.result) {
          throw new InvalidTransition(e.type, s.phase, `${d.toolUseId} is not running`);
        }
        return { ...c, result: { content: d.content, isError: d.isError, origin: e.origin } };
      });
      return settleResults({ ...base, batch });
    }

    case "tool.interrupted": {
      expect("tools");
      const d = e.data as EventDataMap["tool.interrupted"];
      const batch = updateCall(s, e.type, d.toolUseId, (c) => ({
        ...c,
        result: { content: [], isError: true, origin: e.origin },
      }));
      return settleResults({ ...base, batch });
    }

    case "derived.recorded": {
      const d = e.data as EventDataMap["derived.recorded"];
      return ok({ ...base, derived: { ...s.derived, [d.key]: d.value } });
    }

    case "turn.ended": {
      if (s.phase === "new" || s.phase === "idle" || s.phase === "ended") {
        throw new InvalidTransition(e.type, s.phase);
      }
      const closed = closeBatch(base);
      return ok({ ...closed, phase: "idle", ending: undefined });
    }

    case "session.ended":
      return ok({ ...base, phase: "ended" });

    default:
      // 插件自定义事件（<plugin-id>/<type>）不影响内核状态
      if (e.type.includes("/")) return ok(base);
      throw new InvalidTransition(e.type, s.phase, "unknown event type");
  }
}

/** 只凭日志重建状态（I-5） */
export function rebuild(sessionId: string, events: Iterable<Event>): State {
  let state = initialState(sessionId);
  for (const e of events) state = step(state, e).state;
  return state;
}

// ---------- 内部辅助 ----------

function ok(state: State, effects: Effect[] = []): StepResult {
  return { state, effects };
}

function endReason(stop: StopReason): TurnEndReason {
  return stop === "max_tokens" || stop === "refusal" ? stop : "end";
}

function updateCall(
  s: State,
  eventType: string,
  toolUseId: string,
  fn: (c: PendingCall) => PendingCall,
): PendingCall[] {
  if (!s.batch.some((c) => c.toolUseId === toolUseId)) {
    throw new InvalidTransition(eventType, s.phase, `unknown toolUseId ${toolUseId}`);
  }
  return s.batch.map((c) => (c.toolUseId === toolUseId ? fn(c) : c));
}

function settleDecisions(s: State): StepResult {
  if (s.batch.some((c) => !c.decision)) return ok({ ...s, phase: "deciding" });

  const asks = s.batch.filter((c) => c.decision === "ask");
  if (asks.length > 0) {
    return ok({ ...s, phase: "awaiting" }, [{ type: "AwaitInput", toolUseIds: asks.map((c) => c.toolUseId) }]);
  }

  const batch = s.batch.map((c): PendingCall => {
    if (c.decision !== "deny" || c.result) return c;
    const origin = c.decidedBy === "user" ? { by: "user" as const } : { by: "plugin" as const, id: c.decidedBy ?? "" };
    const content: Block[] = c.reason ? [{ kind: "text", text: c.reason, origin, trust: "trusted" }] : [];
    return { ...c, result: { content, isError: true, origin } };
  });

  const toRun = batch.filter((c) => !c.result);
  if (toRun.length > 0) {
    return ok({ ...s, batch, phase: "tools" }, [{ type: "RunTools", toolUseIds: toRun.map((c) => c.toolUseId) }]);
  }
  return settleResults({ ...s, batch });
}

function settleResults(s: State): StepResult {
  if (s.batch.some((c) => !c.result)) return ok(s);
  return ok({ ...closeBatch(s), phase: "continuing" }, [{ type: "DecideContinue" }]);
}

/** 为每个工具调用补齐结果（缺失的记为错误），作为一条 user 消息追加，并清空 batch */
function closeBatch(s: State): State {
  if (s.batch.length === 0) return s;
  const content: Block[] = s.batch.map((c) => {
    const r = c.result ?? { content: [], isError: true, origin: { by: "runtime" as const } };
    return {
      kind: "tool_result",
      toolUseId: c.toolUseId,
      content: r.content,
      isError: r.isError,
      origin: r.origin,
      trust: r.origin.by === "tool" ? "untrusted" : "trusted",
    };
  });
  return { ...s, batch: [], messages: [...s.messages, { role: "user", content }] };
}
