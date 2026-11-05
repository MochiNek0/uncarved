// 插件密钥（第 8 节）：按插件 id 分开存在 $JADE_HOME/state/secrets/<id>.json。
//
// 只有插件自己的 ctx.secrets 能读写这一份；核心不把密钥放进配置，也不放进给进程外插件的环境变量。
// 文件写 0600（POSIX 上有效；Windows 上 chmod 只管理只读位），写入先落临时文件再改名。

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StaleContext, type Secrets } from "./api.ts";

/** 一个密钥名最多这么长；值是字符串，最多 1 MB */
const KEY_MAX = 256;
const VALUE_MAX = 1024 * 1024;

/** 每个插件的密钥存储；同一个 id 始终拿到同一个实例，读到的缓存才一致 */
export class SecretsStore {
  readonly #root: string;
  readonly #plugins = new Map<string, Secrets>();

  constructor(home: string) {
    this.#root = path.join(home, "state", "secrets");
  }

  for(plugin: string): Secrets {
    if (!plugin) throw new Error("secrets: plugin id is empty");
    let secrets = this.#plugins.get(plugin);
    if (!secrets) {
      secrets = new PluginSecrets(this.#root, plugin);
      this.#plugins.set(plugin, secrets);
    }
    return secrets;
  }
}

/**
 * 一个作用域里的 ctx.secrets：作用域关闭后再用旧 ctx 读写，抛 StaleContext，
 * 和从旧 ctx 里拿到的服务一样（4.1）
 */
export function scopedSecrets(base: Secrets, closed: () => boolean, plugin: string): Secrets {
  return {
    async get(key) {
      if (closed()) throw new StaleContext(plugin);
      return base.get(key);
    },
    async set(key, value) {
      if (closed()) throw new StaleContext(plugin);
      return base.set(key, value);
    },
  };
}

class PluginSecrets implements Secrets {
  readonly #root: string;
  readonly #plugin: string;
  readonly #file: string;
  #data: Record<string, string> | undefined;
  /** 同一个插件的写入串行，避免两次 set 交错覆盖 */
  #writing: Promise<void> = Promise.resolve();

  constructor(root: string, plugin: string) {
    this.#root = root;
    this.#plugin = plugin;
    this.#file = path.join(root, `${encodeURIComponent(plugin)}.json`);
  }

  async get(key: string): Promise<string | undefined> {
    checkKey(key);
    return (await this.#load())[key];
  }

  async set(key: string, value: string | undefined): Promise<void> {
    checkKey(key);
    if (value !== undefined) {
      if (typeof value !== "string") throw new Error("secrets: value must be a string");
      if (value.length > VALUE_MAX) throw new Error(`secrets: value is longer than ${VALUE_MAX} characters`);
    }
    // 读、改、写排在上一次写入之后：两次 set 不会互相覆盖，失败时也能把内存里的值放回去
    const run = this.#writing.then(async () => {
      const data = await this.#load();
      const before = data[key];
      if (value === undefined) delete data[key];
      else data[key] = value;
      try {
        await this.#save();
      } catch (e) {
        if (before === undefined) delete data[key];
        else data[key] = before;
        throw e;
      }
    });
    this.#writing = run.catch(() => {});
    await run;
  }

  async #load(): Promise<Record<string, string>> {
    if (this.#data) return this.#data;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return (this.#data = Object.create(null) as Record<string, string>);
      throw new Error(`secrets for ${this.#plugin} at ${this.#file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`secrets for ${this.#plugin} at ${this.#file}: expected a JSON object`);
    }
    // 用无原型对象：密钥名写成 __proto__ 也不会碰到原型
    const data = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(raw)) if (typeof value === "string") data[key] = value;
    return (this.#data = data);
  }

  async #save(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700).catch(() => {});
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(this.#data ?? {}, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.#file);
      await chmod(this.#file, 0o600).catch(() => {});
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new Error("secrets: key must be a non-empty string");
  if (key.length > KEY_MAX) throw new Error(`secrets: key is longer than ${KEY_MAX} characters`);
  if (key.includes("\0")) throw new Error("secrets: key must not contain NUL");
}
