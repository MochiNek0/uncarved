// 模型配置：$JADE_HOME/.env（默认 ~/.jade/.env），和旧 jade 相同。shell 里已经设置的变量优先。
//
// 不读当前目录的 .env：那是被操作项目自己的配置，里面的 OPENAI_API_KEY 等会改掉模型选择。

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

/** 配置文件里的变量，env 里已有的优先；文件不存在时就是 env */
export async function envWithFile(file: string, env: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    // 没有配置文件
  }
  return { ...parseEnv(text), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
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
