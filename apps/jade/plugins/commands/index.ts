// jade/commands：斜杠命令的注册表。只登记，不执行：前端解析输入、带着自己的上下文调用 run。
// 每个调用方一个实例，调用方关闭（停用、被隔离、换会话时的会话作用域）时它注册的命令自动撤销。

import { definePlugin } from "@uncarved/jade-api";
import type { CommandEntry, Commands } from "@uncarved/jade-api/services";

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
