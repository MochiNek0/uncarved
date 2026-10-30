// 用户配置：$JADE_HOME/.env（默认 ~/.jade/.env）。
//
// jade 在任意目录启动，不能读当前目录的 .env（那是被操作项目自己的配置，里面的 OPENAI_API_KEY 等会改掉模型选择），
// 所以入口用 bun --no-env-file 启动，由这里读取用户配置。shell 里已经设置的变量优先，不被覆盖。

import { readFile } from "node:fs/promises";

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

/** 至少配置了一种模型 */
export function hasProvider(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY || env.OPENAI_COMPAT_BASE_URL || env.ANTHROPIC_API_KEY);
}
