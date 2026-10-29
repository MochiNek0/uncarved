// 进程外 hook 的约束。对应宪法 5.5，设计见 docs/design/5.5-out-of-process-hooks.md。
//
// 传输层（启动进程、编解码）在内核之外；字段裁剪、合并、超时这些保证都在这里，
// 所以任何传输实现都无法绕过。

import type { GateDecision, HookContext, LocalHookSpec } from "./hooks.ts";

export type ExtensionPoint = LocalHookSpec["point"];

export interface RemoteHookSpec {
  kind: "transform" | "gate" | "observe";
  point: ExtensionPoint;
  remote: true;
  /** 发送给插件的顶层字段；另可列出 "derived"（派生数据快照） */
  reads: string[];
  /** 插件可以修改的顶层字段，只有 transform 可以非空 */
  writes: string[];
  /** 必填，有限正数，不能关闭（5.5 第 3 款） */
  timeoutMs: number;
  order?: number;
  /** 由传输层实现：把裁剪后的字段发给插件，返回插件的回复 */
  call(payload: Record<string, unknown>, ctx: HookContext): Promise<unknown>;
}

const POINTS: Record<ExtensionPoint, { kind: RemoteHookSpec["kind"]; reads: string[]; writes: string[] }> = {
  "context.project": { kind: "transform", reads: ["messages"], writes: ["messages"] },
  "context.build": { kind: "transform", reads: ["system", "messages", "tools", "ext"], writes: ["system", "messages", "tools", "ext"] },
  "model.before": { kind: "transform", reads: ["system", "messages", "tools", "ext"], writes: ["system", "messages", "tools", "ext"] },
  "tool.before": { kind: "transform", reads: ["toolUseId", "name", "input"], writes: ["input"] },
  "tool.after": { kind: "transform", reads: ["call", "content", "isError"], writes: ["content", "isError"] },
  "tool.gate": { kind: "gate", reads: ["toolUseId", "name", "input"], writes: [] },
  "turn.continue": { kind: "gate", reads: ["phase", "messages"], writes: [] },
  "model.after": { kind: "observe", reads: ["model", "content", "stopReason", "usage"], writes: [] },
  event: { kind: "observe", reads: ["id", "type", "seq", "at", "data", "origin"], writes: [] },
  "session.start": { kind: "observe", reads: ["sessionId", "phase", "plugins"], writes: [] },
  "session.end": { kind: "observe", reads: ["sessionId", "phase", "plugins"], writes: [] },
};

const DECISIONS: ReadonlySet<string> = new Set<GateDecision>(["deny", "ask", "allow", "abstain"]);

export class RemoteHookError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RemoteHookError";
  }
}

export function isRemote(spec: object): spec is RemoteHookSpec {
  return (spec as { remote?: unknown }).remote === true;
}

/** 注册前检查，返回问题描述；没有问题返回 undefined */
export function checkRemoteHook(spec: RemoteHookSpec): string | undefined {
  const point = POINTS[spec.point];
  if (!point) return `unknown extension point ${JSON.stringify(spec.point)}`;
  if (spec.kind !== point.kind) return `${spec.point} is a ${point.kind} point, not ${spec.kind}`;
  if ((spec as { optional?: unknown }).optional) return `${spec.point}: out-of-process hooks cannot be optional`;
  if (!(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)) return `${spec.point}: timeoutMs must be a positive finite number`;
  const badRead = spec.reads.find((f) => f !== "derived" && !point.reads.includes(f));
  if (badRead !== undefined) return `${spec.point}: field ${JSON.stringify(badRead)} is not readable`;
  const badWrite = spec.writes.find((f) => !point.writes.includes(f));
  if (badWrite !== undefined) return `${spec.point}: field ${JSON.stringify(badWrite)} is not writable`;
  return undefined;
}

/** 转成等价的进程内 hook：只发送声明的字段，只接受声明的修改 */
export function toLocalHook(spec: RemoteHookSpec): LocalHookSpec {
  // context.project 的值是数组，传输时包成 { messages }
  const wrap = (v: unknown) => (spec.point === "context.project" ? { messages: v } : (v as Record<string, unknown>));
  const pick = (v: unknown, ctx: HookContext) => {
    const whole = wrap(v);
    const out: Record<string, unknown> = {};
    for (const f of spec.reads) {
      const value = f === "derived" ? ctx.derived : whole[f];
      if (value !== undefined) out[f] = structuredClone(value);
    }
    return out;
  };
  const common = { order: spec.order, timeoutMs: spec.timeoutMs };

  switch (spec.kind) {
    case "transform":
      return {
        ...common,
        kind: "transform",
        point: spec.point,
        fn: async (value: unknown, ctx: HookContext) => {
          const reply = await spec.call(pick(value, ctx), ctx);
          if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new RemoteHookError("reply must be an object");
          const extra = Object.keys(reply).find((k) => !spec.writes.includes(k));
          if (extra !== undefined) throw new RemoteHookError(`reply modifies undeclared field ${JSON.stringify(extra)}`);
          const merged = { ...wrap(value), ...(reply as Record<string, unknown>) };
          return spec.point === "context.project" ? merged.messages : merged;
        },
      } as LocalHookSpec;
    case "gate":
      return {
        ...common,
        kind: "gate",
        point: spec.point,
        fn: async (payload: unknown, ctx: HookContext) => {
          const reply = (await spec.call(pick(payload, ctx), ctx)) as { decision?: unknown; reason?: unknown } | null;
          if (!reply || typeof reply.decision !== "string" || !DECISIONS.has(reply.decision)) {
            throw new RemoteHookError("reply must carry a gate decision");
          }
          return {
            decision: reply.decision as GateDecision,
            reason: typeof reply.reason === "string" ? reply.reason : undefined,
          };
        },
      } as LocalHookSpec;
    case "observe":
      return {
        ...common,
        kind: "observe",
        point: spec.point,
        fn: async (payload: unknown, ctx: HookContext) => {
          await spec.call(pick(payload, ctx), ctx);
        },
      } as LocalHookSpec;
  }
}
