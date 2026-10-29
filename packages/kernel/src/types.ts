// 内核的公共数据格式。对应宪法第三章、第六章。

export type Awaitable<T> = T | Promise<T>;

// ---------- 来源与信任（I-8） ----------

export type Origin =
  | { by: "user" }
  | { by: "model"; provider: string; model: string }
  | { by: "tool"; name: string }
  | { by: "plugin"; id: string }
  | { by: "runtime" };

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

export type UserInput =
  | { kind: "message"; content: Block[] }
  | { kind: "approval"; toolUseId: string; approved: boolean; reason?: string };

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "pause" | "other";

export type TurnEndReason = "end" | "max_tokens" | "refusal" | "stopped" | "error";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type Decision = "allow" | "deny" | "ask";

export interface EventDataMap {
  "session.started": { plugins: PluginManifestEntry[]; parent?: SessionRef };
  "plugins.changed": { plugins: PluginManifestEntry[] };
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
    child?: { sessionId: string; seq: number };
  };
  "derived.recorded": { key: string; value: unknown };
  "turn.ended": { reason: TurnEndReason; error?: string };
  "session.ended": Record<string, never>;
}

export type CoreEventType = keyof EventDataMap;

export interface Event<T extends string = string> {
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
  result?: ToolResultRecord;
}

export interface State {
  sessionId: string;
  lastSeq: number;
  phase: Phase;
  messages: Message[];
  /** 本轮模型提出的工具调用 */
  batch: PendingCall[];
  plugins: PluginManifestEntry[];
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
  /** 给 provider 的私有参数，内核只透传 */
  ext?: Record<string, unknown>;
}

export interface ModelResponse {
  /** 实际产生回复的模型 */
  model: string;
  content: Block[];
  stopReason: StopReason;
  usage?: Usage;
}

export interface Delta {
  kind: "text" | "thinking";
  text: string;
}

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
}

export interface ToolResult {
  content: Block[] | string;
  isError?: boolean;
}

export interface Tool extends ToolSpec {
  effect: "read" | "write" | "external";
  concurrency: "safe" | "exclusive";
  idempotent: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  call: ToolCall;
  content: Block[];
  isError: boolean;
}
