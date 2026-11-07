// 内容为空的错误工具结果：内核不写说明文字（I-1），模型只看到 is_error，分不清是工具名写错、没执行还是被拒绝，
// 容易原样重试。这里在投影里按原因补一句说明（I-4：只改投影，不改日志）。
//
// 空结果有四种来源，块本身只能分出最后一种（origin 不是 runtime）：
// - 调用了不存在的工具：运行时直接拒绝（tool.decided，origin runtime，没有 reason）
// - 崩溃恢复时，执行到一半的非幂等工具记为 tool.interrupted
// - 这一轮先结束了（用户中断、出错、输出被截断），没有结果的调用由内核补成空的错误结果
// - 关卡拒绝但没给原因（例如关卡 hook 出错，按拒绝处理）
// 前两种只有日志事件分得出来，由 observe 记进 derived，投影时按它说明；恢复会话后同样成立，
// 投影也只取决于日志，每次算出的结果相同，不破坏提示缓存。

import type { Block, LogEvent, Message, Origin } from "uncarved";

export type Why = "unknown-tool" | "interrupted";
export type Reasons = Readonly<Record<string, Why>>;

/** 从事件判断空结果的原因；不是这两种返回 undefined */
export function whyEmpty(e: LogEvent): { toolUseId: string; why: Why } | undefined {
  if (e.type === "tool.decided" && e.origin.by === "runtime") {
    const d = e.data as { toolUseId: string; decision: string; reason?: string };
    if (d.decision === "deny" && !d.reason) return { toolUseId: d.toolUseId, why: "unknown-tool" };
  }
  if (e.type === "tool.interrupted") return { toolUseId: (e.data as { toolUseId: string }).toolUseId, why: "interrupted" };
  return undefined;
}

function explanation(why: Why | undefined, origin: Origin, name: string | undefined): string {
  if (why === "unknown-tool") {
    return `There is no tool named ${JSON.stringify(name ?? "")}; the call was not run. Use only the tools you were given.`;
  }
  if (why === "interrupted") {
    return "This call was interrupted while it was running (jade stopped before it finished), so it may have partly taken effect. Check its effects before running it again.";
  }
  if (origin.by === "runtime") {
    return "This call has no result: the turn ended before it finished (the user interrupted, an error occurred, or the response was cut off). It may not have run, or may have stopped partway; check its effects before relying on them or running it again.";
  }
  if (origin.by === "user") return "The user declined this call.";
  return "This call was blocked by a check in jade, which gave no reason. Do not retry it unchanged.";
}

/** 给内容为空的错误工具结果补上说明；没有要补的时候原样返回 */
export function explainEmptyResults(messages: Message[], reasons: Reasons, plugin: string): Message[] {
  let names: Map<string, string> | undefined;
  const nameOf = (id: string) => {
    names ??= new Map(messages.flatMap((m) => m.content.flatMap((b) => (b.kind === "tool_use" ? [[b.id, b.name] as const] : []))));
    return names.get(id);
  };
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "user" || !m.content.some((b) => b.kind === "tool_result" && b.isError && b.content.length === 0)) return m;
    changed = true;
    return {
      ...m,
      content: m.content.map((b): Block => {
        if (b.kind !== "tool_result" || !b.isError || b.content.length > 0) return b;
        const text = explanation(reasons[b.toolUseId], b.origin, nameOf(b.toolUseId));
        return { ...b, content: [{ kind: "text", text, origin: { by: "plugin", id: plugin }, trust: "trusted" }] };
      }),
    };
  });
  return changed ? out : messages;
}
