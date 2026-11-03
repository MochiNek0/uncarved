// jade 自带的插件。内核之外的功能都以插件的形式提供，和第三方插件用同一套接口：
// 每个都可以在 $JADE_HOME/plugins.json 里停用（jade plugin disable <id>），
// 或者由第三方插件用 replaces 代替。jade/policy 负责审批，不能停用或代替，第三方插件只能用 gate hook 让它更严格。

export interface BuiltinInfo {
  id: string;
  /** 提供什么（jade plugin list、/plugins 显示） */
  about: string;
  /** 不能停用或代替 */
  required?: boolean;
}

export const BUILTINS: readonly BuiltinInfo[] = [
  { id: "jade/policy", about: "permission modes and approvals", required: true },
  { id: "jade/prompts", about: "system prompt, environment, AGENTS.md / CLAUDE.md instructions" },
  { id: "jade/fs", about: "read_file, write_file, edit_file, multi_edit, list_dir, glob, grep" },
  { id: "jade/shell", about: "bash, bash_output, kill_shell" },
  { id: "jade/web", about: "web_fetch, web_search" },
  { id: "jade/todo", about: "todo_write" },
  { id: "jade/ask", about: "ask_user (the agent asks you clarifying questions)" },
  { id: "jade/memory", about: "memory tool, memories in the system prompt, /memory" },
  { id: "jade/task", about: "task tool (read-only sub-agents)" },
  { id: "jade/skills", about: "skill tool, skill list in the system prompt, /skills" },
  { id: "jade/mcp", about: "tools of the MCP servers, /mcp" },
  { id: "jade/checks", about: "project checks after edits, /checks" },
  { id: "jade/compact", about: "compacts the history near the context limit, /compact" },
  { id: "jade/budget", about: "limits the steps of a turn" },
  { id: "jade/repeats", about: "rejects calls repeated in one response and re-opening an unchanged file, warns about repeated failures and read-backs" },
];

export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((b) => b.id));
export const REQUIRED_IDS: ReadonlySet<string> = new Set(BUILTINS.filter((b) => b.required).map((b) => b.id));
