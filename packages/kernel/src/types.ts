// 内核的公共数据格式。对应宪法第三章、第六章。

import type { Layer } from "./hooks.ts";

export type Awaitable<T> = T | Promise<T>;

// ---------- 来源与信任（I-8） ----------

export type Origin =
  | { by: "user" }
  | { by: "model"; provider: string; model: string }
  | { by: "tool"; name: string }
  | { by: "plugin"; id: string; source?: ContentSource }
  | { by: "runtime" }
  /** 宿主程序（发行版的 CLI、服务端等）通过 Runtime.record / Runtime.emit 写入（4.8） */
  | { by: "host" };

/** 插件从配置层加载的内容（例如提示词文件）的出处（7.2） */
export interface ContentSource {
  layer: Layer;
  /** 相对于该配置层根目录的路径 */
  path: string;
  /** 内容的 sha256 */
  hash: string;
}

export type Trust = "trusted" | "untrusted";

// ---------- 内容块（3.3） ----------

interface BlockBase {
  origin: Origin;
  trust: Trust;
  /** 按 providerId 分组的私有数据，内核只透传 */
  ext?: Record<string, unknown>;
}

export type Block =
  | (BlockBase & { kind: "text"; text: string })
  | (BlockBase & { kind: "image"; source: unknown })
  | (BlockBase & { kind: "document"; source: unknown })
  | (BlockBase & { kind: "thinking"; text: string })
  | (BlockBase & { kind: "tool_use"; id: string; name: string; input: unknown })
  | (BlockBase & { kind: "tool_result"; toolUseId: string; content: Block[]; isError: boolean })
  /** 内核不认识的 provider 专有块，内容全部在 ext 里 */
  | (BlockBase & { kind: "opaque" });

export type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;

export interface Message {
  role: "user" | "assistant";
  content: Block[];
}

// ---------- 事件（3.1、3.2） ----------

export interface PluginManifestEntry {
  id: string;
  version: string;
}

export interface SessionRef {
  sessionId: string;
  eventId: string;
}

export interface ChildRef {
  sessionId: string;
  seq: number;
}

export type UserInput =
  | { kind: "message"; content: Block[] }
  | { kind: "approval"; toolUseId: string; approved: boolean; reason?: string }
  /**
   * 对插件清单变化的确认（4.6）。只记录结果，不执行任何工作：批准后调用 recover() 继续未完成的工作。
   * 拒绝后只能换回可接受的插件清单
   */
  | { kind: "plugins"; approved: boolean };

/** 恢复会话时插件变化的处理策略，严格程度 abort > ask > continue（4.6） */
export type ResumePolicy = "continue" | "ask" | "abort";

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "pause" | "other";

/** aborted：被 Runtime.abort() 中断（4.4） */
export type TurnEndReason = "end" | "max_tokens" | "refusal" | "stopped" | "aborted" | "error";

/** 各 provider 统一的口径 */
export interface Usage {
  /** 输入总量，包括命中缓存和写入缓存的部分 */
  inputTokens?: number;
  outputTokens?: number;
  /** inputTokens 中命中缓存的部分 */
  cacheReadTokens?: number;
  /** inputTokens 中写入缓存的部分 */
  cacheWriteTokens?: number;
}

export type Decision = "allow" | "deny" | "ask";

export interface EventDataMap {
  "session.started": { plugins: PluginManifestEntry[]; parent?: SessionRef };
  "plugins.changed": { plugins: PluginManifestEntry[]; resolution: ResumePolicy };
  "input.received": UserInput;
  "model.requested": { requestHash: string };
  "model.responded": { content: Block[]; stopReason: StopReason; usage?: Usage };
  "tool.decided": {
    toolUseId: string;
    decision: Decision;
    /** 经过 tool.before 改写后、实际要执行的参数 */
    input: unknown;
    reason?: string;
    decidedBy?: string;
  };
  "tool.interrupted": { toolUseId: string };
  "tool.completed": {
    toolUseId: string;
    content: Block[];
    isError: boolean;
    child?: ChildRef;
  };
  "derived.recorded": { key: string; value: unknown };
  "turn.ended": { reason: TurnEndReason; error?: string };
  /** 宿主进程离开会话，会话仍可恢复（4.2） */
  "session.detached": Record<string, never>;
  "session.ended": Record<string, never>;
}

export type CoreEventType = keyof EventDataMap;

export interface LogEvent<T extends string = string> {
  v: 1;
  id: string;
  seq: number;
  at: string;
  type: T;
  data: T extends CoreEventType ? EventDataMap[T] : unknown;
  origin: Origin;
}

// ---------- 状态与效果（4.1） ----------

export type Phase =
  | "new"
  | "idle"
  | "model"
  | "deciding"
  | "awaiting"
  | "tools"
  | "continuing"
  | "ending"
  | "ended";

export interface ToolResultRecord {
  content: Block[];
  isError: boolean;
  origin: Origin;
}

export interface PendingCall {
  toolUseId: string;
  name: string;
  input: unknown;
  decision?: Decision;
  reason?: string;
  decidedBy?: string;
  /** 做出最终决定的事件，子会话以它作为 parent 引用（3.4） */
  decidedAt?: string;
  /** 已决定执行，但之后插件清单变了：决定不再可靠，恢复时不自动重跑（4.6 第 3 款） */
  stale?: boolean;
  result?: ToolResultRecord;
}

export interface State {
  sessionId: string;
  lastSeq: number;
  phase: Phase;
  messages: Message[];
  /** 本轮模型提出的工具调用 */
  batch: PendingCall[];
  /** 最近一次被接受的插件清单 */
  plugins: PluginManifestEntry[];
  /** 尚未被接受的插件清单变化；存在时会话暂停（4.6） */
  held?: { plugins: PluginManifestEntry[]; resolution: "ask" | "abort" };
  parent?: SessionRef;
  ending?: TurnEndReason;
  derived: Record<string, unknown>;
}

export type Effect =
  | { type: "CallModel" }
  | { type: "DecideTools"; toolUseIds: string[] }
  | { type: "RunTools"; toolUseIds: string[] }
  | { type: "AwaitInput"; toolUseIds: string[] }
  | { type: "DecideContinue" }
  | { type: "EndTurn"; reason: TurnEndReason };

// ---------- 模型请求与 Provider ----------

export interface SystemSegment {
  text: string;
  stability: "stable" | "volatile";
  origin: Origin;
  /** 项目层加载的片段应当为 untrusted（7.2） */
  trust: Trust;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: SystemSegment[];
  messages: Message[];
  tools: ToolSpec[];
  /** 按 providerId 分组，ext[providerId] 由该 provider 解释，内核只透传（4.7） */
  ext?: Record<string, unknown>;
}

export interface ModelResponse {
  /** 实际产生回复的 provider。包装 Provider 必须把被包装者的值传上来；缺省为 Provider.id（4.7） */
  provider?: string;
  /** 实际产生回复的模型 */
  model: string;
  content: Block[];
  stopReason: StopReason;
  usage?: Usage;
}

/**
 * 流式增量，只推送给订阅者，不记入日志（3.2）。
 * reset：此前推送的本次模型调用的增量全部作废，例如包装 Provider 重试或切换之前（4.7）
 */
export type Delta = { kind: "text" | "thinking"; text: string } | { kind: "reset" };

/**
 * 把模型请求翻译成某个模型接口的调用，实现不属于内核（4.7）。
 * 可以包装另一个 Provider 来做路由、重试、限流：包装者必须转发 signal、原样传递 ext；
 * 调用失败时应当抛出 ProviderError
 */
export interface Provider {
  id: string;
  complete(
    request: ModelRequest,
    options: { signal: AbortSignal; onDelta?: (delta: Delta) => void },
  ): Promise<ModelResponse>;
}

// ---------- 工具（第六章） ----------

export interface ToolContext {
  sessionId: string;
  toolUseId: string;
  signal: AbortSignal;
  /** 启动子会话时作为 parent 记录（3.4） */
  parent: SessionRef;
  /** 推送执行进度给订阅者，不记入日志，格式由工具和宿主约定（第六章） */
  progress(update: unknown): void;
}

export interface ToolResult {
  content: Block[] | string;
  isError?: boolean;
  /** 工具启动了子会话时，子会话的 ID 和最终 seq（3.4） */
  child?: ChildRef;
}

/** 工具的声明部分，交给关卡判断（4.4） */
export interface ToolInfo extends ToolSpec {
  effect: "read" | "write" | "external";
  concurrency: "safe" | "exclusive";
  idempotent: boolean;
}

export interface Tool extends ToolInfo {
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** tool.gate 的输入：最终参数，加上被调用工具的声明 */
export interface GatedToolCall extends ToolCall {
  tool: ToolInfo;
}

export interface ToolOutcome {
  call: ToolCall;
  content: Block[];
  isError: boolean;
}
