// 搜索服务的 API key：shell 里的环境变量 + $JADE_HOME/.env（shell 里已经设置的优先），和 jade/models 读同一个文件。
// 从旧 jade 的 config.ts 复制：插件之间不共享代码，jade/models 也有一份 parseEnv。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type Env = Record<string, string | undefined>;

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

/** 配置文件里的变量，env 里已有的优先；文件不存在时就是 env */
export async function envWithFile(file: string, env: Env = process.env): Promise<Env> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // 没有配置文件
  }
  return { ...parseEnv(text), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
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
  return /[\s#"']/.test(value) ? `${key}="${value.replaceAll("\n", "\\n")}"` : `${key}=${value}`;
}
