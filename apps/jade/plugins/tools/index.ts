// jade/tools：给嵌套 Agent（子 Agent 之类）用的工具的注册表。
//
// 主会话里的工具对象是各插件私有的，另起一个 Agent 的插件拿不到。提供工具的插件在这里另登记一套实例，
// 要用的插件（jade/task，或任何第三方插件）自己来取、自己筛选、自己把关：登记的一方不用知道谁在用。

import type { Tool } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";
import type { Tools } from "@uncarved/jade-api/services";

/** 登记的工具，按登记顺序 */
const registry: { tool: Tool; plugin: string; when?: () => boolean }[] = [];

/** 同名的取最后登记的那个，when 返回 false 或出错的不给 */
function available(): Tool[] {
  const latest = new Map<string, (typeof registry)[number]>();
  for (const r of registry) {
    latest.delete(r.tool.name);
    latest.set(r.tool.name, r);
  }
  return [...latest.values()].flatMap((r) => {
    try {
      return !r.when || r.when() ? [r.tool] : [];
    } catch {
      return [];
    }
  });
}

export default definePlugin({
  process(ctx) {
    ctx.provide("tools@1", (caller): Tools => ({
      register(tool, opts) {
        if (typeof tool?.name !== "string" || typeof tool.execute !== "function") throw new Error("tools.register: a tool needs a name and execute");
        // 同一个插件重复登记是正常的：换会话时新会话先登记，旧会话随后撤销它的那份；取最后登记的
        const taken = registry.find((r) => r.tool.name === tool.name && r.plugin !== caller.plugin);
        if (taken) throw new Error(`tools.register: ${tool.name} is already registered by ${taken.plugin}`);
        if (opts?.when !== undefined && typeof opts.when !== "function") throw new Error("tools.register: when must be a function");
        const entry = { tool, plugin: caller.plugin, ...(opts?.when ? { when: opts.when } : {}) };
        registry.push(entry);
        const revoke = () => {
          const i = registry.indexOf(entry);
          if (i !== -1) registry.splice(i, 1);
        };
        caller.onDispose(revoke);
        return revoke;
      },
      list: available,
    }));
  },
});
