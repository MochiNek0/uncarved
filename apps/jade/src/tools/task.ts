// task 工具：启动一个只读的子 Agent。子 Agent 是一个普通会话，用日志引用和父会话关联（3.4、第六章）。
// 子 Agent 调用的工具通过 ctx.progress 推给宿主显示；需要用户批准的调用（例如 web_fetch）交给宿主的 approve。

import { Runtime, type EventDataMap, type LogStore, type Plugin, type Provider, type Tool } from "uncarved";

/** ctx.progress 推送的内容 */
export type TaskProgress =
  | { kind: "task-start"; sessionId: string; description: string }
  | { kind: "task-tool"; name: string; input: unknown; decision: string };

/** 子 Agent 的调用要用户批准时，宿主给出的回答 */
export interface SubagentApproval {
  approved: boolean;
  reason?: string;
}

export type ApproveSubagent = (call: { toolUseId: string; name: string; input: unknown }, signal: AbortSignal) => Promise<SubagentApproval>;

export interface TaskOptions {
  store: LogStore;
  provider: Provider;
  /** 每个子会话一套新的插件实例 */
  plugins: () => Plugin[];
  /** 不给时一律拒绝 */
  approve?: ApproveSubagent;
}

const NOBODY: SubagentApproval = { approved: false, reason: "Nobody can approve this action for a sub-agent. Report what you need instead." };

export function taskTool(opts: TaskOptions): Tool {
  return {
    name: "task",
    description:
      "Delegate a self-contained research task to a sub-agent with read-only tools (read_file, list_dir, glob, grep, and web_fetch / web_search when available). " +
      "Use it for broad searches across many files, or web research across several pages, so that only the conclusion comes back. " +
      "The sub-agent sees nothing of this conversation: the prompt must contain everything it needs. " +
      "Several task calls in one response run in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-6 word label" },
        prompt: { type: "string", description: "Complete instructions, including what to report back" },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    // 子 Agent 只读，重跑只是多花 token
    idempotent: true,
    async execute(input, ctx) {
      const { description, prompt } = input as { description: string; prompt: string };
      const child = await Runtime.create({
        store: opts.store,
        provider: opts.provider,
        plugins: opts.plugins(),
        parent: ctx.parent,
      });
      const sessionId = child.state.sessionId;
      const progress = (p: TaskProgress) => ctx.progress(p);
      progress({ kind: "task-start", sessionId, description });
      const names = new Map<string, string>();
      child.subscribe((n) => {
        if (n.type !== "event") return;
        if (n.event.type === "model.responded") {
          for (const b of (n.event.data as EventDataMap["model.responded"]).content) if (b.kind === "tool_use") names.set(b.id, b.name);
        } else if (n.event.type === "tool.decided") {
          const d = n.event.data as EventDataMap["tool.decided"];
          progress({ kind: "task-tool", name: names.get(d.toolUseId) ?? "?", input: d.input, decision: d.decision });
        }
      });
      const forward = () => child.abort(ctx.signal.reason);
      ctx.signal.addEventListener("abort", forward, { once: true });
      let failure: unknown;
      try {
        await child.send({
          kind: "message",
          content: [{ kind: "text", text: prompt, origin: { by: "runtime" }, trust: "trusted" }],
        });
        while (child.state.phase === "awaiting") {
          for (const c of child.state.batch.filter((x) => x.decision === "ask")) {
            const answer = opts.approve ? await opts.approve(c, ctx.signal) : NOBODY;
            await child.send({ kind: "approval", toolUseId: c.toolUseId, approved: answer.approved, reason: answer.reason });
          }
        }
      } catch (err) {
        failure = err;
      } finally {
        ctx.signal.removeEventListener("abort", forward);
        // 中断时也结束子会话，不留下没有结尾的日志
        await child.close().catch(() => {});
      }
      if (ctx.signal.aborted) throw failure ?? ctx.signal.reason;

      const ref = { sessionId, seq: child.state.lastSeq };
      const last = child.state.messages.findLast((m) => m.role === "assistant");
      const text = (last?.content ?? []).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n").trim();
      if (failure) {
        const msg = failure instanceof Error ? failure.message : String(failure);
        return { content: `Sub-agent failed: ${msg}${text ? `\nLast output:\n${text}` : ""}`, isError: true, child: ref };
      }
      return { content: text || "(sub-agent returned no text)", isError: !text, child: ref };
    },
  };
}
