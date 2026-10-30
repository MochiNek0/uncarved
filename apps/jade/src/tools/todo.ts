// todo_write 工具：模型维护本轮任务的清单。每次调用给出完整清单，替换之前的。
//
// 清单本身就是工具调用的参数，已经在日志里，不另外保存：宿主从 tool.decided 读取并显示，
// 压缩插件把被压缩部分里最后一份清单写进摘要。

import type { Message, Tool } from "uncarved";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export function renderTodos(todos: Todo[]): string {
  return todos.length ? todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n") : "(empty)";
}

export function todoTool(): Tool {
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
    // 不碰文件和进程
    effect: "read",
    concurrency: "exclusive",
    idempotent: true,
    async execute(input) {
      const { todos } = input as { todos: Todo[] };
      const active = todos.filter((t) => t.status === "in_progress").length;
      const note = active > 1 ? "\nNote: keep only one item in_progress at a time." : "";
      return { content: `Todo list updated:\n${renderTodos(todos)}${note}` };
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
