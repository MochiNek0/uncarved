// 插件声明与兼容性检查。对应宪法 4.6、8.2。

import type { HookSpec, Layer } from "./hooks.ts";
import { checkRemoteHook, isRemote } from "./remote.ts";
import type { PluginManifestEntry, ResumePolicy, Tool } from "./types.ts";

export const KERNEL_MAJOR = 1;

/** 内核提供的能力：每个扩展点一项（`<种类>:<扩展点>`），外加插件写入日志的能力 */
export const CAPABILITIES: ReadonlySet<string> = new Set([
  "observe:session.start",
  "observe:session.end",
  "transform:context.build",
  "transform:context.project",
  "transform:model.before",
  "observe:model.after",
  "gate:tool.gate",
  "transform:tool.before",
  "transform:tool.after",
  "gate:turn.continue",
  "observe:event",
  "log:record",
  "log:emit",
]);

export interface Plugin {
  id: string;
  version: string;
  /** 兼容的内核主版本，形如 "^1" */
  kernel: string;
  /** 需要的内核能力，见 CAPABILITIES */
  needs?: string[];
  /** 恢复会话时本插件发生变化的处理策略，覆盖默认处理（4.6） */
  resume?: ResumePolicy;
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
  const missing = (p.needs ?? []).filter((n) => !CAPABILITIES.has(n));
  if (missing.length > 0) throw new PluginIncompatible(p.id, `missing capabilities ${missing.join(", ")}`);
  for (const h of p.hooks ?? []) {
    const problem = isRemote(h) ? checkRemoteHook(h) : checkTimeout(h.point, h.timeoutMs);
    if (problem) throw new PluginIncompatible(p.id, problem);
  }
}

/** 所有 hook 都必须有超时，不能关闭（5.1）：Infinity、NaN、非正数一律拒绝 */
function checkTimeout(point: string, timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined || (Number.isFinite(timeoutMs) && timeoutMs > 0)) return undefined;
  return `${point}: timeoutMs must be a positive finite number`;
}

const POLICY_RANK: Record<ResumePolicy, number> = { continue: 0, ask: 1, abort: 2 };

/**
 * 比较已接受的清单与当前插件，得出恢复策略，取最严格的一个（4.6 第 2 款）。
 * 补丁/小版本 continue，主版本 ask，新增 ask，删除 ask；插件声明的 resume 只覆盖它自己的变化。
 * 被删除的插件已不在场，无法声明策略，因此删除永远不会自动继续。
 */
export function resumePolicy(accepted: PluginManifestEntry[], current: Plugin[]): ResumePolicy {
  let worst: ResumePolicy = "continue";
  const raise = (p: ResumePolicy) => {
    if (POLICY_RANK[p] > POLICY_RANK[worst]) worst = p;
  };
  for (const p of current) {
    const prev = accepted.find((a) => a.id === p.id);
    if (prev?.version === p.version) continue;
    const byVersion: ResumePolicy = prev && major(prev.version) === major(p.version) ? "continue" : "ask";
    raise(p.resume ?? byVersion);
  }
  if (accepted.some((a) => !current.some((p) => p.id === a.id))) raise("ask");
  return worst;
}

/** 无法解析的版本号视为主版本变化（NaN 与任何值都不相等） */
function major(version: string): number {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : NaN;
}
