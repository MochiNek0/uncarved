// jade/renderers：工具调用和插件事件在对话里怎么显示的注册表。前端查这里；没有登记的用前端的默认显示。
// 显示的文字可以带 ANSI 颜色，前端负责过滤掉颜色之外的控制序列。

import { definePlugin } from "../../src/api.ts";

export interface ToolRenderer {
  tool: string;
  /** 调用行 "● 工具名(…)" 括号里的摘要，只显示第一行；默认是 path 参数或参数的 JSON */
  summary?(input: unknown): string | undefined;
  /** 摘要省略了的参数（例如很长的命令），展开调用行后显示在最前面，可以多行 */
  details?(input: unknown): string | undefined;
  /** 执行时显示的内容，代替默认的 "工具名(摘要)"：第一行跟在 "● " 后面，其余的行原样显示在下面，不折叠 */
  call?(input: unknown): string | undefined;
  /**
   * 运行中的进度：工具用 ToolContext.progress 推送的一项换成一行，显示在对话的最后，工具结束时去掉；返回 undefined 不显示。
   * 没有这个函数时，{ text } 形式的进度按输出逐行显示，其他的不显示
   */
  progress?(update: unknown, call: { toolUseId: string; summary(tool: string, input: unknown): string }): string | undefined;
  /** 请用户批准时显示的预览，可以多行；默认是参数的 JSON */
  preview?(input: unknown): string | undefined | Promise<string | undefined>;
  /** 工具执行之前同步调用（例如记下修改前的文件，好在结果里显示 diff），返回值交给 result 的 before */
  before?(input: unknown): unknown;
  /**
   * 结果：line 接在调用行的 "⎿ " 后面（一行），details 是展开后的内容（可以多行）；
   * 返回 null 时不显示结果；默认显示结果文字的第一行，多出的行折叠起来
   */
  result?(r: { toolUseId: string; input: unknown; text: string; isError: boolean; before?: unknown }): { line: string; details?: string } | null | undefined;
}

/** 插件自己的事件（hook 的 ctx.emit 写入的）怎么显示。只能为自己的事件注册：event 不带 "<插件 id>/" 前缀 */
export interface EventRenderer {
  event: string;
  /** line 显示成一行，details 是展开后的内容；返回 undefined 时不显示 */
  render(data: unknown): { line: string; details?: string } | undefined;
}

export interface Renderers {
  /** 为一个工具登记显示方式，返回撤销函数。同一个工具已有登记时抛错 */
  tool(renderer: ToolRenderer): () => void;
  /** 为自己的一种事件登记显示方式，返回撤销函数 */
  event(renderer: EventRenderer): () => void;
  /** 前端查找 */
  forTool(tool: string): { renderer: ToolRenderer; plugin: string } | undefined;
  /** 前端按完整的事件类型（"<插件 id>/<event>"）查找 */
  forEvent(type: string): { renderer: EventRenderer; plugin: string } | undefined;
}

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
