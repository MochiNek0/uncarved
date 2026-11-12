// jade/todo：todo_write 工具，模型维护本轮任务的清单。每次调用给出完整清单，替换之前的。
//
// 清单本身就是工具调用的参数，已经在日志里，不另外保存：前端从调用的参数显示，
// 压缩插件可以从历史里找最后一份清单（latestTodos）写进摘要。从旧 jade 的 tools/todo.ts 移植。

import type { Message, Tool } from "uncarved";
import { definePlugin, type Span, type Text } from "@uncarved/jade-api";
import type { Renderers, ToolRenderer } from "@uncarved/jade-api/services";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export function renderTodos(todos: Todo[]): string {
  return todos.length ? todos.map((t) => `${MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n") : "(empty)";
}

/** 完成了几项、一共几项、正在做的那一项 */
function progressOf(todos: Todo[]): { done: number; total: number; now?: string } {
  const now = todos.find((t) => t?.status === "in_progress")?.content;
  return { done: todos.filter((t) => t?.status === "completed").length, total: todos.length, ...(typeof now === "string" ? { now } : {}) };
}

/** "3/7 · now: 写测试"：对话里的一行 */
function progressLine(todos: Todo[]): string {
  const p = progressOf(todos);
  return `${p.done}/${p.total}${p.now !== undefined ? ` · now: ${p.now.replace(/\s+/g, " ")}` : ""}`;
}

/** onChange：清单换了（工具执行成功）时调用，给出新的清单 */
export function todoTool(onChange?: (todos: Todo[]) => void): Tool {
  return {
    name: "todo_write",
    description:
      "Maintain a task list for multi-step work. Each call replaces the whole list. " +
      "Use it when a task has three or more steps: write the plan, mark one item in_progress while working on it, " +
      "and mark items completed as soon as they are done. Skip it for simple tasks.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    // 不碰文件和进程；可以和同一批的读并发（用到清单的地方按模型给出的顺序取最后一次调用，与执行顺序无关）
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      const todos = (input as { todos?: unknown }).todos;
      if (!Array.isArray(todos)) return { content: "todos must be an array", isError: true };
      const active = (todos as Todo[]).filter((t) => t?.status === "in_progress").length;
      const note = active > 1 ? "\nNote: keep only one item in_progress at a time." : "";
      onChange?.(todos as Todo[]);
      return { content: `Todo list updated:\n${renderTodos(todos as Todo[])}${note}` };
    },
  };
}

/** messages 里最后一次 todo_write 的清单 */
export function latestTodos(messages: Message[]): Todo[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const use = messages[i]!.content.findLast((b) => b.kind === "tool_use" && b.name === "todo_write");
    if (use?.kind === "tool_use") return (use.input as { todos?: Todo[] }).todos;
  }
  return undefined;
}

// 带语义样式的文字（jade-api 的 Text）：怎么画由前端决定
const bold = (text: string): Span => ({ text, style: "bold" });
const args = (input: unknown) => (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
const list = (input: unknown) => (Array.isArray(args(input).todos) ? (args(input).todos as Todo[]) : []);

// 完整的清单常驻在输入框上方（ctx.panel），对话里每次更新只占一行，展开（ctrl+o、点击）看当时的完整清单。
// 前端没有那个位置时，对话里的一行照样能展开
export const todoRenderer: ToolRenderer = {
  tool: "todo_write",
  summary: (input) => progressLine(list(input)),
  call: (input) => [bold("Todos"), " ", progressLine(list(input))],
  details: (input) => renderTodos(list(input)),
  // 清单就是参数，结果不再显示（出错时照常显示）
  result: ({ isError }) => (isError ? undefined : null),
};

/** 输入框上方的一块：还有没做完的项时显示，全部做完或清空时去掉 */
export function todoPanel(todos: Todo[]): Text | undefined {
  if (todos.every((t) => t?.status === "completed")) return undefined;
  const p = progressOf(todos);
  return [bold("Todos"), ` ${p.done}/${p.total}\n${renderTodos(todos).replace(/^/gm, "  ")}`];
}

export default definePlugin({
  process(ctx) {
    ctx.service<Renderers>("renderers@1")?.tool(todoRenderer);
  },
  session(ctx) {
    ctx.kernel.tool(todoTool((todos) => ctx.panel?.(todoPanel(todos))));
    // 恢复的、/rewind 复制出的会话：历史里最后一份清单接着显示
    if (ctx.panel) {
      ctx.session.afterTurn(() => {
        const todos = latestTodos(ctx.session.state().messages);
        if (Array.isArray(todos)) ctx.panel?.(todoPanel(todos));
      });
    }
  },
});
