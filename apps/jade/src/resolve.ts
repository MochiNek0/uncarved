// 由清单算出激活计划：哪些插件激活、按什么顺序、每个服务由谁提供（3.3、3.4）。
// 纯函数，不执行插件代码；运行期间计划不变（原则 4）。

import { LAYERS, type PluginSource } from "./api.ts";
import { satisfiesCaret } from "./manifest.ts";

/** 计划阶段的状态。激活之后宿主还会把状态改成 failed 或 quarantined */
export type PlanState = "active" | "disabled" | "duplicate" | "incompatible" | "replaced" | "conflict" | "skipped";

export interface PlanEntry {
  source: PluginSource;
  state: PlanState;
  reason?: string;
  /** 意料之中的跳过：没选中的前端，以及只因为它而缺依赖的插件。启动时不提示 */
  expected?: boolean;
}

export interface Plan {
  /** 发现顺序，包括没有激活的 */
  entries: PlanEntry[];
  /** 激活顺序：依赖在前 */
  order: PluginSource[];
  /** 服务名 → 提供者 id */
  providers: Map<string, string>;
  /** 选中的前端插件 id */
  frontend?: string;
  /** 不影响激活、但用户应该知道的事 */
  warnings: string[];
}

export interface ResolveOptions {
  apiVersion: string;
  /** 按 id 停用的插件 */
  disabled?: ReadonlySet<string>;
  /** 安全模式：只加载 bundled（5.4） */
  safe?: boolean;
  /** 命令行开关，用来选前端 */
  flags?: readonly string[];
  /** 核心自己提供的服务（jade@1）：插件可以在 requires 里写，别人的 provides 不能占用这个名字 */
  coreServices?: readonly string[];
}

const rank = (e: PlanEntry) => LAYERS.indexOf(e.source.layer);

export function resolve(sources: readonly PluginSource[], opts: ResolveOptions): Plan {
  const warnings: string[] = [];
  const entries: PlanEntry[] = [];
  const byId = new Map<string, PlanEntry>();
  const core = new Set(opts.coreServices ?? []);
  const out = (e: PlanEntry, state: PlanState, reason: string) => {
    e.state = state;
    e.reason = reason;
  };
  const live = () => entries.filter((e) => e.state === "active");

  // 1. 身份、停用、兼容性
  for (const source of sources) {
    const { id, api } = source.manifest;
    const e: PlanEntry = { source, state: "active" };
    entries.push(e);
    const first = byId.get(id);
    if (first) out(e, "duplicate", `id ${id} is already used by ${first.source.dir}`);
    else byId.set(id, e);
    if (e.state !== "active") continue;
    // 核心自己提供的服务不能被插件占用（host 会拒绝 provide，这里提前说明）
    const taken = (source.manifest.provides ?? []).filter((s) => core.has(s));
    if (opts.safe && source.layer !== "bundled") out(e, "disabled", "safe mode");
    else if (opts.disabled?.has(id)) out(e, "disabled", "disabled in plugins.json");
    else if (taken.length > 0) out(e, "conflict", `${taken.join(", ")} is provided by jade itself`);
    else if (!satisfiesCaret(api, opts.apiVersion)) out(e, "incompatible", `requires plugin API ${api}, running ${opts.apiVersion}`);
  }

  // 2. 显式代替：项目层不能代替用户层或 bundled（第 7 节）
  for (const e of live()) {
    for (const target of e.source.manifest.replaces ?? []) {
      const t = byId.get(target);
      if (!t || t === e) {
        warnings.push(`${e.source.manifest.id}: replaces unknown plugin ${target}`);
      } else if (e.source.layer === "project" && t.source.layer !== "project") {
        warnings.push(`${e.source.manifest.id}: a project plugin cannot replace ${t.source.layer} plugin ${target}; ignored`);
      } else if (t.state === "active") {
        out(t, "replaced", `replaced by ${e.source.manifest.id}`);
      }
    }
  }

  // 3. 选前端：有命令行开关匹配的选它，否则选 default；没选中的前端不激活
  const fronts = live().filter((e) => e.source.manifest.frontend);
  const flagged = fronts.filter((e) => opts.flags?.includes(e.source.manifest.frontend!.flag ?? "\0"));
  const chosen = new Set(flagged.length > 0 ? flagged : fronts.filter((e) => e.source.manifest.frontend!.default));
  for (const e of fronts) {
    if (chosen.has(e)) continue;
    out(e, "skipped", `frontend ${e.source.manifest.frontend!.name} is not selected`);
    e.expected = true;
  }

  // 4. 服务裁决。先按层级排除低层（到不动点），再处理同层冲突
  const providersOf = (service: string) => live().filter((e) => e.source.manifest.provides?.includes(service));
  const services = () => [...new Set(live().flatMap((e) => e.source.manifest.provides ?? []))];
  for (let changed = true; changed; ) {
    changed = false;
    for (const service of services()) {
      const ps = providersOf(service);
      if (ps.length < 2) continue;
      const nonProject = ps.filter((e) => e.source.layer !== "project");
      // 有用户层或 bundled 提供者时，项目层的提供者出局
      const pool = nonProject.length > 0 ? nonProject : ps;
      for (const e of ps) {
        if (!pool.includes(e)) {
          out(e, "conflict", `a project plugin cannot override the ${nonProject[0]!.source.layer} provider of ${service} (${nonProject[0]!.source.manifest.id})`);
          changed = true;
        }
      }
      const top = Math.max(...pool.map(rank));
      for (const e of pool) {
        if (rank(e) < top) {
          const winner = pool.find((p) => rank(p) === top)!;
          out(e, "replaced", `${service} is provided by ${winner.source.manifest.id} (${winner.source.layer})`);
          changed = true;
        }
      }
    }
  }
  for (const service of services()) {
    const ps = providersOf(service);
    if (ps.length < 2) continue;
    const ids = ps.map((e) => e.source.manifest.id).join(", ");
    for (const e of ps) out(e, "conflict", `${service} is provided by several ${e.source.layer} plugins (${ids}); disable all but one`);
  }

  // 5. 依赖与顺序。缺依赖的跳过；成环的跳过；直到不动点
  for (;;) {
    const providers = new Map<string, PlanEntry>();
    for (const e of live()) for (const s of e.source.manifest.provides ?? []) providers.set(s, e);
    let changed = false;
    for (const e of live()) {
      for (const need of e.source.manifest.requires ?? []) {
        if (providers.has(need) || core.has(need)) continue;
        const why = entries.find((x) => x.source.manifest.provides?.includes(need));
        out(e, "skipped", why ? `requires ${need}: its provider ${why.source.manifest.id} is ${why.state}` : `requires ${need}, which no plugin provides`);
        if (why?.expected) e.expected = true;
        changed = true;
        break;
      }
    }
    if (changed) continue;

    const order = topo(live(), providers);
    if (order.cycle.length > 0) {
      const ids = order.cycle.map((e) => e.source.manifest.id).join(", ");
      for (const e of order.cycle) out(e, "skipped", `dependency cycle: ${ids}`);
      continue;
    }
    const map = new Map([...providers].map(([s, e]) => [s, e.source.manifest.id]));
    // 核心自己提供的服务也列出来，`jade plugins list` 才看得全
    for (const s of core) map.set(s, "jade");
    const frontend = live().find((e) => e.source.manifest.frontend)?.source.manifest.id;
    return { entries, order: order.sorted.map((e) => e.source), providers: map, warnings, ...(frontend ? { frontend } : {}) };
  }
}

/**
 * Kahn 算法，同等条件下保持发现顺序。
 * optional 的依赖是软的：排不下去时，挡住它的只剩 optional 依赖的插件先激活（按发现顺序取第一个），
 * 它在 process() 里取那些服务时得到 undefined，session() 和之后的调用里能拿到。只有 requires 组成的环才算成环
 */
function topo(nodes: PlanEntry[], providers: Map<string, PlanEntry>): { sorted: PlanEntry[]; cycle: PlanEntry[] } {
  const edges = (e: PlanEntry, list: readonly string[] | undefined) => {
    const ds = new Set<PlanEntry>();
    for (const s of list ?? []) {
      const p = providers.get(s);
      if (p && p !== e) ds.add(p);
    }
    return ds;
  };
  const hard = new Map(nodes.map((e) => [e, edges(e, e.source.manifest.requires)]));
  const soft = new Map(nodes.map((e) => [e, edges(e, e.source.manifest.optional)]));
  const sorted: PlanEntry[] = [];
  const left = new Set(nodes);
  const waiting = (e: PlanEntry, map: Map<PlanEntry, Set<PlanEntry>>) => [...map.get(e)!].some((d) => left.has(d));
  const take = (e: PlanEntry) => {
    sorted.push(e);
    left.delete(e);
  };
  while (left.size > 0) {
    let progress = false;
    for (const e of nodes) {
      if (!left.has(e) || waiting(e, hard) || waiting(e, soft)) continue;
      take(e);
      progress = true;
    }
    if (progress) continue;
    const relaxed = nodes.find((e) => left.has(e) && !waiting(e, hard));
    if (!relaxed) break;
    take(relaxed);
  }
  // 剩下的插件里，只有自己在 requires 环上或依赖环上插件的才算；这里一并跳过
  return { sorted, cycle: [...left] };
}
