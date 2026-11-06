// 插件的配置（第 8 节）：清单里的默认值 < 用户 config.json < 项目 .jade/config.json，按插件、按键合并。
// 两个文件的形状相同：{ "<插件 id>": { "<键>": 值 } }。不执行插件代码。

import { readFile } from "node:fs/promises";
import type { PluginSource } from "./api.ts";

export type ConfigFile = Record<string, Record<string, unknown>>;

/** 文件不存在时为空；格式不对时为空并给出原因 */
export async function readConfigFile(file: string): Promise<{ config: ConfigFile; error?: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    return { config: {}, error: `${file}: ${e instanceof Error ? e.message : String(e)}; ignored` };
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(raw)) return { config: {}, error: `${file}: expected an object of plugin ids; ignored` };
  const config: ConfigFile = {};
  const bad: string[] = [];
  for (const [id, section] of Object.entries(raw)) {
    if (isObject(section)) config[id] = section;
    else bad.push(id);
  }
  return bad.length > 0 ? { config, error: `${file}: the sections for ${bad.join(", ")} are not objects; ignored` } : { config };
}

/**
 * 一个插件的配置。项目层的文件只能设置项目层插件的键，和清单里标了 project 的键：
 * 克隆的仓库不能改你的审批模式、模型配置（第 7 节）。被忽略的键在 ignored 里
 */
export function pluginConfig(source: PluginSource, user: ConfigFile, project: ConfigFile): { config: Record<string, unknown>; ignored: string[] } {
  const { id, config: keys = {} } = source.manifest;
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keys)) if (v.default !== undefined) config[k] = structuredClone(v.default);
  Object.assign(config, user[id]);
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(project[id] ?? {})) {
    if (source.layer === "project" || keys[k]?.project) config[k] = v;
    else ignored.push(k);
  }
  return { config: Object.freeze(config), ignored };
}
