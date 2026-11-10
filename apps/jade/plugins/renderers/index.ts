// jade/renderers：工具调用和插件事件在对话里怎么显示的注册表。前端查这里；没有登记的用前端的默认显示。
// 显示的文字可以带 ANSI 颜色，前端负责过滤掉颜色之外的控制序列。

import { definePlugin } from "@uncarved/jade-api";
import type { EventRenderer, Renderers, ToolRenderer } from "@uncarved/jade-api/services";

const tools = new Map<string, { renderer: ToolRenderer; plugin: string }>();
const events = new Map<string, { renderer: EventRenderer; plugin: string }>();

function add<T>(map: Map<string, { renderer: T; plugin: string }>, key: string, renderer: T, plugin: string, what: string, onDispose: (d: () => void) => void): () => void {
  const taken = map.get(key);
  if (taken) throw new Error(`${what} ${key} already has a renderer from ${taken.plugin}`);
  const entry = { renderer, plugin };
  map.set(key, entry);
  const revoke = () => {
    if (map.get(key) === entry) map.delete(key);
  };
  onDispose(revoke);
  return revoke;
}

export default definePlugin({
  process(ctx) {
    ctx.provide("renderers@1", (caller): Renderers => ({
      tool(renderer) {
        if (typeof renderer?.tool !== "string" || !renderer.tool) throw new Error("a tool renderer needs the tool name");
        return add(tools, renderer.tool, renderer, caller.plugin, "tool", caller.onDispose);
      },
      event(renderer) {
        if (typeof renderer?.event !== "string" || !renderer.event || typeof renderer.render !== "function") throw new Error("an event renderer needs the event type and render");
        return add(events, `${caller.plugin}/${renderer.event}`, renderer, caller.plugin, "event", caller.onDispose);
      },
      forTool: (tool) => tools.get(tool),
      forEvent: (type) => events.get(type),
    }));
  },
});
