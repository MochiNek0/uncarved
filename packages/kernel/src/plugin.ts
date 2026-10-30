// 插件声明与兼容性检查。对应宪法 4.6、8.2。

import type { HookSpec, Layer } from "./hooks.ts";
import { checkRemoteHook, isRemote } from "./remote.ts";
import type { PluginManifestEntry, ResumePolicy, Tool } from "./types.ts";

/** 与 package.json 的 version 保持一致，插件用 semver 的 ^ 范围声明兼容的内核版本 */
export const KERNEL_VERSION = "0.1.0";

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
  /** 兼容的内核版本范围，只支持 ^ 范围，形如 "^0.1"、"^1"、"^1.2.0" */
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
  const ok = satisfiesCaret(p.kernel, KERNEL_VERSION);
  if (ok === undefined) throw new PluginIncompatible(p.id, `unsupported kernel range "${p.kernel}"`);
  if (!ok) throw new PluginIncompatible(p.id, `requires kernel ${p.kernel}, running ${KERNEL_VERSION}`);
  const missing = (p.needs ?? []).filter((n) => !CAPABILITIES.has(n));
  if (missing.length > 0) throw new PluginIncompatible(p.id, `missing capabilities ${missing.join(", ")}`);
  // 不认识的策略会被当成 continue，静默放行本该暂停的变化
  if (p.resume !== undefined && !Object.hasOwn(POLICY_RANK, p.resume)) {
    throw new PluginIncompatible(p.id, `unsupported resume policy ${JSON.stringify(p.resume)}`);
  }
  for (const h of p.hooks ?? []) {
    const problem = isRemote(h) ? checkRemoteHook(h) : checkTimeout(h.point, h.timeoutMs);
    if (problem) throw new PluginIncompatible(p.id, problem);
  }
  // 用到的扩展点必须在 needs 中声明（8.2）；写日志的能力在调用 record/emit 时检查
  const needs = new Set(p.needs ?? []);
  const undeclared = (p.hooks ?? []).map((h) => `${h.kind}:${h.point}`).filter((n) => !needs.has(n));
  if (undeclared.length > 0) {
    throw new PluginIncompatible(p.id, `hooks use undeclared capabilities ${[...new Set(undeclared)].join(", ")}`);
  }
}

/**
 * semver 的 ^ 范围：不低于范围本身，且第一个非零位（未写出的位不算）不变。
 * ^1 → >=1.0.0 <2.0.0，^0.1 → >=0.1.0 <0.2.0，^0.0.3 → 只有 0.0.3。范围格式不对时返回 undefined
 */
function satisfiesCaret(range: string, version: string): boolean | undefined {
  const m = /^\^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(range);
  if (!m) return undefined;
  const want = m.slice(1).filter((x) => x !== undefined).map(Number);
  const have = version.split(".").map(Number);
  const fixed = want.findIndex((x) => x !== 0);
  const last = fixed === -1 ? want.length - 1 : fixed;
  for (let i = 0; i <= last; i++) if (have[i] !== want[i]) return false;
  for (let i = last + 1; i < 3; i++) {
    const h = have[i] ?? 0;
    const w = want[i] ?? 0;
    if (h !== w) return h > w;
  }
  return true;
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
