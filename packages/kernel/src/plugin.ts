// 插件声明与兼容性检查。对应宪法 8.2。

import type { HookSpec, Layer } from "./hooks.ts";
import type { Tool } from "./types.ts";

export const KERNEL_MAJOR = 1;

export interface Plugin {
  id: string;
  version: string;
  /** 兼容的内核主版本，形如 "^1" */
  kernel: string;
  layer?: Layer;
  tools?: Tool[];
  hooks?: HookSpec[];
}

export class PluginIncompatible extends Error {
  readonly plugin: string;
  constructor(plugin: string, detail: string) {
    super(`plugin ${plugin}: ${detail}`);
    this.name = "PluginIncompatible";
    this.plugin = plugin;
  }
}

export function checkCompat(p: Plugin): void {
  const m = /^\^(\d+)$/.exec(p.kernel);
  if (!m) throw new PluginIncompatible(p.id, `unsupported kernel range "${p.kernel}"`);
  if (Number(m[1]) !== KERNEL_MAJOR) {
    throw new PluginIncompatible(p.id, `requires kernel ${p.kernel}, running ${KERNEL_MAJOR}`);
  }
}
