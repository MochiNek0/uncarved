// $JADE_HOME 下的两份状态：plugins.json（用户停用的插件）和 state/faults.json（连续崩溃的记录，5.4）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrustRecord, TrustStore } from "uncarved";

/** 连续几次启动出故障后自动停用 */
export const FAULT_LIMIT = 3;

export interface PluginsConfig {
  disabled: string[];
}

export interface Faults {
  /** 插件 id → 连续出故障的启动次数和最近一次的原因 */
  streaks: Record<string, { count: number; last: string }>;
  /** 因连续崩溃被自动停用的插件 */
  autoDisabled: string[];
  /** 归不到任何插件的错误，最近的若干条（5.3） */
  unattributed: { at: string; error: string }[];
}

const UNATTRIBUTED_KEEP = 20;

export const pluginsPath = (home: string) => path.join(home, "plugins.json");
export const faultsPath = (home: string) => path.join(home, "state", "faults.json");

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 先写临时文件再改名，写到一半退出不会留下坏文件 */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function readPluginsConfig(home: string): Promise<PluginsConfig> {
  const raw = (await readJson(pluginsPath(home))) as Record<string, unknown> | undefined;
  return { disabled: strings(raw?.disabled) };
}

export async function writePluginsConfig(home: string, config: PluginsConfig): Promise<void> {
  await writeJson(pluginsPath(home), config);
}

export async function readFaults(home: string): Promise<Faults> {
  const raw = (await readJson(faultsPath(home))) as Partial<Faults> | undefined;
  return {
    streaks: raw?.streaks && typeof raw.streaks === "object" ? raw.streaks : {},
    autoDisabled: strings(raw?.autoDisabled),
    unattributed: Array.isArray(raw?.unattributed) ? raw.unattributed.slice(-UNATTRIBUTED_KEEP) : [],
  };
}

export async function writeFaults(home: string, faults: Faults): Promise<void> {
  faults.unattributed = faults.unattributed.slice(-UNATTRIBUTED_KEEP);
  await writeJson(faultsPath(home), faults);
}

/** 记一次故障；本次启动里同一个插件只记一次。达到上限时自动停用，返回 true */
export function countFault(faults: Faults, id: string, reason: string): boolean {
  const s = faults.streaks[id] ?? { count: 0, last: "" };
  s.count += 1;
  s.last = reason;
  faults.streaks[id] = s;
  if (s.count >= FAULT_LIMIT && !faults.autoDisabled.includes(id)) {
    faults.autoDisabled.push(id);
    return true;
  }
  return false;
}

/** 项目层插件的确认记录（第 7 节），存在 $JADE_HOME/state/trust.json，按插件目录内容的哈希 */
export class FileTrustStore implements TrustStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  async has(hash: string): Promise<boolean> {
    return (await this.#read()).some((r) => r.hash === hash);
  }

  async add(record: TrustRecord): Promise<void> {
    const records = (await this.#read()).filter((r) => r.hash !== record.hash);
    records.push(record);
    await writeJson(this.#file, { records });
  }

  async #read(): Promise<TrustRecord[]> {
    const raw = (await readJson(this.#file)) as { records?: unknown } | undefined;
    return Array.isArray(raw?.records) ? raw.records.filter((r): r is TrustRecord => typeof r?.hash === "string") : [];
  }
}
