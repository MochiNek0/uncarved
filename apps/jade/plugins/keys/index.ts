// jade/keys：快捷键的注册表。前端在输入框有焦点时按下自己不用的键，查这里找到插件的处理函数。

import { definePlugin } from "@uncarved/jade-api";

/** "ctrl+<字母>"、"alt+<字母或数字>" 或 "shift+tab" */
export const KEY_SPEC = /^(ctrl\+[a-z]|alt\+[a-z0-9]|shift\+tab)$/;
/**
 * 前端自己用的键，插件不能用：编辑（ctrl+a/e/d/w/u/k，按词移动的 alt+f/b）、搜索历史（ctrl+r）、重画（ctrl+l）、展开（ctrl+o）、
 * 中断和退出（ctrl+c），以及终端里等同于退格、Tab、回车的 ctrl+h/i/j/m
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([..."acdehijklmoruw"].map((c) => `ctrl+${c}`).concat("alt+f", "alt+b"));

export interface Key {
  /** 见 KEY_SPEC，不分大小写 */
  key: string;
  /** /help 里显示 */
  description?: string;
  /** 按下时调用；出错时前端显示警告。上一次还没执行完时再按，会再调用一次 */
  run(ctx: { key: string; signal: AbortSignal }): void | Promise<void>;
}

export interface Keys {
  /** 注册一个键，返回撤销函数。键不合法、是保留键或已被占用时抛错 */
  register(key: Key): () => void;
  /** 前端按下一个自己不用的键时查找；找到了由前端执行 run，出错时显示警告 */
  get(key: string): { key: Key; plugin: string } | undefined;
  list(): { key: string; description?: string; plugin: string }[];
}

const registry = new Map<string, { key: Key; plugin: string }>();

export default definePlugin({
  process(ctx) {
    ctx.provide("keys@1", (caller): Keys => ({
      register(key) {
        const spec = String(key?.key ?? "").toLowerCase();
        if (!KEY_SPEC.test(spec)) throw new Error(`invalid key ${JSON.stringify(key?.key)}: use ctrl+<letter>, alt+<letter or digit> or shift+tab`);
        if (RESERVED_KEYS.has(spec)) throw new Error(`key ${spec} is reserved by the frontend`);
        const taken = registry.get(spec);
        if (taken) throw new Error(`key ${spec} is already registered by ${taken.plugin}`);
        const entry = { key, plugin: caller.plugin };
        registry.set(spec, entry);
        const revoke = () => {
          if (registry.get(spec) === entry) registry.delete(spec);
        };
        caller.onDispose(revoke);
        return revoke;
      },
      get: (spec) => registry.get(spec.toLowerCase()),
      list: () => [...registry.entries()].map(([k, { key, plugin }]) => ({ key: k, ...(key.description ? { description: key.description } : {}), plugin })).sort((a, b) => a.key.localeCompare(b.key)),
    }));
  },
});
