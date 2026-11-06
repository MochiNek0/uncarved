// 保存过的模型：$JADE_HOME/models.json。同一个服务（类型、地址、密钥都相同）只存一份，下面是在它上面用过的模型，
// 每个模型带自己的设置（输出上限、思考力度、上下文窗口）。.env 里始终是当前用的那一个，这里记着用过的全部，
// /model 可以切回去。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/** 每个模型自己的设置：切换模型时一起换掉 */
export const MODEL_SETTINGS = ["JADE_MAX_TOKENS", "JADE_EFFORT", "JADE_CONTEXT_WINDOW", "JADE_RPM", "JADE_VISION"];

export interface SavedModel {
  name: string;
  /** 这个模型自己的设置变量 */
  settings: Record<string, string>;
}

export interface SavedService {
  /** 服务的变量：JADE_PROVIDER、地址、密钥等 */
  env: Record<string, string>;
  /** 最近用过的在前 */
  models: SavedModel[];
}

const strings = (v: unknown): Record<string, string> =>
  typeof v === "object" && v !== null ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>) : {};

/** 读不了或格式不对时返回空数组 */
export async function readSavedServices(file: string): Promise<SavedService[]> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { services?: unknown };
    if (!Array.isArray(data.services)) return [];
    return data.services.flatMap((raw: unknown) => {
      const s = raw as { env?: unknown; models?: unknown } | null;
      if (!s || !Array.isArray(s.models)) return [];
      const models = s.models.flatMap((m: unknown) => {
        const name = (m as { name?: unknown } | null)?.name;
        return typeof name === "string" && name ? [{ name, settings: strings((m as { settings?: unknown }).settings) }] : [];
      });
      return models.length ? [{ env: strings(s.env), models }] : [];
    });
  } catch {
    return [];
  }
}

export async function writeSavedServices(file: string, services: SavedService[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // 里面有 API 密钥
  await writeFile(file, JSON.stringify({ services }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * 改写配置文件里的变量：已有的行原地替换，没有的追加在末尾，值为 undefined 的删除；注释和其他行保持不变。
 * 同时更新 env，让改动在本次运行中生效
 */
export async function updateEnvFile(file: string, updates: Env, env: Env): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // 还没有配置文件
  }
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const out: string[] = [];
  const written = new Set<string>();
  for (const raw of lines) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)?.[1];
    if (!key || !(key in updates)) {
      out.push(raw);
      continue;
    }
    // 同一个键出现多次时只保留第一处
    const value = updates[key];
    if (value !== undefined && !written.has(key)) out.push(format(key, value));
    written.add(key);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !written.has(key)) out.push(format(key, value));
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, out.join("\n") + "\n");
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function format(key: string, value: string): string {
  if (!/[\s#"']/.test(value)) return `${key}=${value}`;
  // 单引号里的内容原样读回（引号、反斜杠都不转义）；只有换行要用双引号里的 \n
  return value.includes("\n") ? `${key}="${value.replaceAll("\n", "\\n")}"` : `${key}='${value}'`;
}
