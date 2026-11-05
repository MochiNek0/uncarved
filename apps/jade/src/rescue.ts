// 救援 CLI：jade plugins list|enable|disable。只读写 plugins.json 和 faults.json，不执行任何插件代码（5.4）。

import { planPlugins, type HostOptions } from "./host.ts";
import { readFaults, readPluginsConfig, writeFaults, writePluginsConfig } from "./state.ts";

const USAGE = "usage: jade plugins [list | enable <id> | disable <id>]";

/** 执行一条 plugins 子命令，返回要打印的文字；用法错误时抛错 */
export async function pluginsCommand(args: readonly string[], opts: Pick<HostOptions, "roots" | "home" | "flags" | "safe">): Promise<string> {
  const [sub = "list", id, ...rest] = args;
  if (rest.length > 0) throw new Error(USAGE);
  if (sub === "list") {
    if (id !== undefined) throw new Error(USAGE);
    return list(opts);
  }
  if (id === undefined || (sub !== "enable" && sub !== "disable")) throw new Error(USAGE);

  const { plan } = await planPlugins(opts);
  const known = plan.entries.some((e) => e.source.manifest.id === id);
  const config = await readPluginsConfig(opts.home);
  if (sub === "disable") {
    if (!config.disabled.includes(id)) config.disabled.push(id);
    await writePluginsConfig(opts.home, config);
    return known ? `disabled ${id}` : `disabled ${id} (no installed plugin has this id)`;
  }
  config.disabled = config.disabled.filter((d) => d !== id);
  await writePluginsConfig(opts.home, config);
  // 同时清掉连续崩溃的记录，否则下次启动又被自动停用
  const faults = await readFaults(opts.home);
  faults.autoDisabled = faults.autoDisabled.filter((d) => d !== id);
  delete faults.streaks[id];
  await writeFaults(opts.home, faults);
  return known ? `enabled ${id}` : `enabled ${id} (no installed plugin has this id)`;
}

/** 按清单和状态文件推算出的状态：不激活插件，所以看不到激活阶段的失败（那些记在连续崩溃次数里） */
async function list(opts: Pick<HostOptions, "roots" | "home" | "flags" | "safe">): Promise<string> {
  const { plan, broken, faults } = await planPlugins(opts);
  const lines: string[] = [];
  for (const e of plan.entries) {
    const m = e.source.manifest;
    const streak = faults.streaks[m.id];
    const note = e.reason ?? (streak ? `faulted in the last ${streak.count} launch(es): ${streak.last}` : "");
    lines.push(`${m.id}@${m.version}  ${e.source.layer}  ${e.state}${note ? `  ${note}` : ""}`);
  }
  for (const b of broken) lines.push(`${b.dir}  ${b.layer}  broken  ${b.error}`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  if (plan.providers.size > 0) {
    lines.push("", "services:");
    for (const [service, id] of [...plan.providers].sort()) lines.push(`  ${service}  ${id}`);
  }
  if (faults.unattributed.length > 0) lines.push("", `${faults.unattributed.length} recent error(s) not attributable to any plugin, see state/faults.json`);
  return lines.length > 0 ? lines.join("\n") : "no plugins installed";
}
