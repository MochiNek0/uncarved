// 用户配置：$JADE_HOME/.env（默认 ~/.jade/.env）。
//
// jade 在任意目录启动，不能读当前目录的 .env（那是被操作项目自己的配置，里面的 OPENAI_API_KEY 等会改掉模型选择），
// 所以入口用 bun --no-env-file 启动，由这里读取用户配置。shell 里已经设置的变量优先，不被覆盖。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 解析 KEY=VALUE 格式：忽略空行和 # 注释，允许 export 前缀，去掉成对的引号（双引号里的 \n 换成换行） */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replaceAll("\\n", "\n");
    } else {
      // 未加引号的值里，空白之后的 # 是注释
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]!] = value;
  }
  return out;
}

/** 把配置文件里的变量填进 env 中还没有的键；文件不存在时什么也不做。返回是否读到了文件 */
export async function loadEnvFile(file: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) if (env[k] === undefined) env[k] = v;
  return true;
}

/**
 * token 数：整数，或者带 K（千）、M（百万）的写法，例如 32000、512K、1M、1.5M，不区分大小写，可以用 _ 分隔数字。
 * 不是正整数时抛出，错误信息里带变量名 name
 */
export function parseTokens(name: string, text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(text.replaceAll("_", ""));
  const unit = m?.[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  const n = m ? (unit === 1 ? Number(m[1]) : Math.round(Number(m[1]) * unit)) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a number of tokens such as 32000, 512K or 1M, got ${JSON.stringify(text)}`);
  return n;
}

/** 至少配置了一种模型 */
export function hasProvider(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.JADE_PROVIDER || env.OPENAI_API_KEY || env.OPENAI_COMPAT_BASE_URL || env.ANTHROPIC_API_KEY);
}

/**
 * 改写配置文件里的变量：已有的行原地替换，没有的追加在末尾，值为 undefined 的删除；注释和其他行保持不变。
 * 同时更新 env，让改动在本次运行中生效
 */
export async function updateEnvFile(
  file: string,
  updates: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
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

/**
 * 保存过的服务和模型：$JADE_HOME/models.json。同一个服务（类型、地址、密钥都相同）只存一份，下面是在它上面用过的模型，
 * 每个模型带自己的设置（输出上限、思考力度、上下文窗口）。.env 里始终是当前用的那一个；这里记着用过的全部，/model 可以切回去
 */
export interface SavedService {
  /** 服务的变量：JADE_PROVIDER、地址、密钥等 */
  env: Record<string, string>;
  /** 最近用过的在前 */
  models: SavedModel[];
}

export interface SavedModel {
  name: string;
  /** 这个模型自己的设置变量 */
  settings: Record<string, string>;
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

/** 含空白、# 或引号的值加双引号，parseEnv 能原样读回 */
function format(key: string, value: string): string {
  return /[\s#"']/.test(value) ? `${key}="${value.replaceAll("\n", "\\n")}"` : `${key}=${value}`;
}
