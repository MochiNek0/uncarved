// 核心这一侧的插件 API：类型和 definePlugin 在 @uncarved/jade-api（插件只 import 那个包，3.5），这里原样转出，
// 再加上只有核心用得到值的东西：API 版本、层级顺序、错误类。

import type { PluginLayer } from "@uncarved/jade-api";
export * from "@uncarved/jade-api";

/** 插件 API 的版本，插件在 plugin.json 的 api 字段里用 ^ 范围声明。和 @uncarved/jade-api 的版本一致 */
export const API_VERSION = "1.1.0";

/** 来源层级，后面的层级更高（3.3） */
export const LAYERS: readonly PluginLayer[] = ["bundled", "user", "project"];

// ---------- 错误 ----------

/** 插件代码抛出的错误，标明归属 */
export class PluginError extends Error {
  readonly plugin: string;
  constructor(plugin: string, where: string, cause: unknown) {
    super(`plugin ${plugin} (${where}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PluginError";
    this.plugin = plugin;
  }
}

/** 作用域已关闭之后还在用它的 ctx 或从它拿到的东西（4.1） */
export class StaleContext extends Error {
  readonly plugin: string;
  constructor(plugin: string) {
    super(`plugin ${plugin}: this context belongs to a closed scope; do not keep ctx or services across a session switch`);
    this.name = "StaleContext";
    this.plugin = plugin;
  }
}

/** 服务的提供者已被隔离或已关闭（3.3） */
export class ServiceUnavailable extends Error {
  readonly service: string;
  constructor(service: string, provider: string) {
    super(`service ${service}: provider ${provider} is no longer active`);
    this.name = "ServiceUnavailable";
    this.service = service;
  }
}
