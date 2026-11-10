// jade/commands：斜杠命令的注册表。只登记，不执行：前端解析输入、带着自己的上下文调用 run。
// 每个调用方一个实例，调用方关闭（停用、被隔离、换会话时的会话作用域）时它注册的命令自动撤销。

import { definePlugin, type SessionManager, type UI } from "@uncarved/jade-api";

export interface Command {
  /** 不带斜杠，字母、数字、- 和 _ */
  name: string;
  description?: string;
  /** 参数提示，例如 "<file>" */
  args?: string;
  /**
   * 不碰会话（只查看、只改插件自己的设置）的命令设为 true：模型工作时也立即执行，不排队。
   * 这种命令返回 { prompt } 无效
   */
  instant?: boolean;
  /** 字符串：显示给用户；{ prompt }：作为用户消息发给模型；不返回：什么也不做 */
  run(args: string, ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

export type CommandResult = string | { prompt: string } | void | undefined;

/** 前端执行命令时给的上下文 */
export interface CommandContext {
  /** 用户中断（esc）或退出时中止 */
  signal: AbortSignal;
  ui: UI;
  /** 当前会话、新建、恢复（/clear、/resume 用它） */
  sessions: SessionManager;
  /** 在对话里显示一段文字，可以带 ANSI 颜色 */
  print(text: string): void;
}

export interface CommandEntry {
  command: Command;
  /** 注册它的插件 */
  plugin: string;
}

export interface Commands {
  /** 注册一条命令，返回撤销函数。名字已被占用时抛错 */
  register(command: Command): () => void;
  /** 按名字找（不分大小写） */
  get(name: string): CommandEntry | undefined;
  /** 全部命令，按名字排序 */
  list(): { name: string; args?: string; description?: string; instant?: boolean; plugin: string }[];
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const registry = new Map<string, CommandEntry>();

export default definePlugin({
  process(ctx) {
    ctx.provide("commands@1", (caller): Commands => ({
      register(command) {
        if (typeof command?.name !== "string" || !NAME.test(command.name)) throw new Error(`invalid command name ${JSON.stringify(command?.name)}`);
        if (typeof command.run !== "function") throw new Error(`command /${command.name} has no run function`);
        const key = command.name.toLowerCase();
        const taken = registry.get(key);
        if (taken) throw new Error(`command /${command.name} is already registered by ${taken.plugin}`);
        const entry: CommandEntry = { command, plugin: caller.plugin };
        registry.set(key, entry);
        const revoke = () => {
          if (registry.get(key) === entry) registry.delete(key);
        };
        caller.onDispose(revoke);
        return revoke;
      },
      get: (name) => registry.get(name.toLowerCase()),
      list: () =>
        [...registry.values()]
          .map(({ command: c, plugin }) => ({ name: c.name, ...(c.args ? { args: c.args } : {}), ...(c.description ? { description: c.description } : {}), ...(c.instant ? { instant: true } : {}), plugin }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  },
});
