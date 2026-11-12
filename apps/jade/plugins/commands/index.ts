// jade/commands：斜杠命令的注册表。只登记，不执行：前端解析输入、带着自己的上下文调用 run。
// 每个调用方一个实例，调用方关闭（停用、被隔离、换会话时的会话作用域）时它注册的命令自动撤销。

import { definePlugin } from "@uncarved/jade-api";
import type { CommandEntry, Commands } from "@uncarved/jade-api/services";

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const registry = new Map<string, CommandEntry>();
/** 简写字符 → 命令名（小写） */
const prefixes = new Map<string, string>();

export default definePlugin({
  process(ctx) {
    ctx.provide("commands@1", (caller): Commands => ({
      register(command) {
        if (typeof command?.name !== "string" || !NAME.test(command.name)) throw new Error(`invalid command name ${JSON.stringify(command?.name)}`);
        if (typeof command.run !== "function") throw new Error(`command /${command.name} has no run function`);
        const key = command.name.toLowerCase();
        // 重名时先注册的留下，后来的这一条跳过并报告：抛错会让调用方整个激活失败，连它别的功能一起没了
        const taken = registry.get(key);
        if (taken) {
          ctx.report(`/${command.name} from ${caller.plugin} was skipped: ${taken.plugin} already registered it`);
          return () => {};
        }
        if (command.prefix !== undefined && (typeof command.prefix !== "string" || [...command.prefix].length !== 1 || /[\p{L}\p{N}\s/]/u.test(command.prefix))) {
          throw new Error(`command /${command.name}: prefix must be one character that is not a letter, digit, space or "/"`);
        }
        let entry: CommandEntry = { command, plugin: caller.plugin };
        let prefix = command.prefix;
        const owner = prefix === undefined ? undefined : prefixes.get(prefix);
        if (prefix !== undefined && owner !== undefined) {
          // 简写被占了：命令照常注册，只是没有简写
          ctx.report(`the ${prefix} shortcut for /${command.name} from ${caller.plugin} was skipped: /${owner} already uses it`);
          const { prefix: _, prefixHint: __, ...rest } = command;
          entry = { command: rest as typeof command, plugin: caller.plugin };
          prefix = undefined;
        }
        registry.set(key, entry);
        if (prefix !== undefined) prefixes.set(prefix, key);
        const revoke = () => {
          if (registry.get(key) === entry) registry.delete(key);
          if (prefix !== undefined && prefixes.get(prefix) === key) prefixes.delete(prefix);
        };
        caller.onDispose(revoke);
        return revoke;
      },
      get: (name) => registry.get(name.toLowerCase()),
      byPrefix: (prefix) => {
        const name = prefixes.get(prefix);
        return name === undefined ? undefined : registry.get(name);
      },
      list: () =>
        [...registry.values()]
          .map(({ command: c, plugin }) => ({ name: c.name, ...(c.args ? { args: c.args } : {}), ...(c.description ? { description: c.description } : {}), ...(c.instant ? { instant: true } : {}), ...(c.prefix ? { prefix: c.prefix } : {}), ...(c.prefixHint ? { prefixHint: c.prefixHint } : {}), plugin }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  },
});
