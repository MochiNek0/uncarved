// jade update 和 jade/update 插件：版本比较、每天一次的检查、安装方式、后台升级。从旧 jade 的 test/update.test.ts 移植。

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkForUpdate } from "../plugins/update/index.ts";
import { autoUpdate, autoUpdateEnabled, detectInstall, isNewer, newerVersion, updater, upgradeHint, VERSION } from "../src/update.ts";

describe("update check", () => {
  test("compares versions", () => {
    expect(isNewer("0.1.3", "0.1.2")).toBe(true);
    expect(isNewer("0.2.0", "0.1.10")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
    expect(isNewer("0.1.2", "0.1.2-beta.1")).toBe(true);
    expect(isNewer("0.1.2-beta.1", "0.1.2")).toBe(false);
  });

  test("asks npm at most once a day and caches the answer", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-update-"));
    let calls = 0;
    const latest = async () => (calls++, "0.2.0");
    expect(await newerVersion(home, { now: 1000, current: "0.1.2", latest })).toBe("0.2.0");
    expect(await newerVersion(home, { now: 2000, current: "0.1.2", latest })).toBe("0.2.0");
    expect(calls).toBe(1);
    expect(await newerVersion(home, { now: 2000, current: "0.2.0", latest })).toBeUndefined();
    expect(await newerVersion(home, { now: 1000 + 24 * 3600 * 1000, current: "0.1.2", latest })).toBe("0.2.0");
    expect(calls).toBe(2);
    expect(JSON.parse(await readFile(path.join(home, "update-check.json"), "utf8")).latest).toBe("0.2.0");
  });

  test("stays quiet when npm cannot be reached or the check is off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-update-"));
    await writeFile(path.join(home, "update-check.json"), "not json");
    expect(await newerVersion(home, { current: "0.1.2", latest: () => Promise.reject(new Error("offline")) })).toBeUndefined();
    process.env.JADE_UPDATE_CHECK = "off";
    try {
      expect(await newerVersion(home, { current: "0.1.2", latest: async () => "9.9.9" })).toBeUndefined();
    } finally {
      delete process.env.JADE_UPDATE_CHECK;
    }
  });

  test("detects how jade was installed", () => {
    expect(detectInstall("D:\\code\\uncarved\\apps\\jade").kind).toBe("dev");
    expect(detectInstall("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@uncarved\\jade").kind).toBe("npm");
    expect(detectInstall("/usr/local/lib/node_modules/@uncarved/jade").kind).toBe("npm");
    expect(detectInstall("/home/u/.bun/install/global/node_modules/@uncarved/jade").kind).toBe("bun");
    expect(detectInstall("/home/u/.local/share/pnpm/global/5/node_modules/@uncarved/jade").kind).toBe("pnpm");
    expect(upgradeHint("bun")).toBe("bun add -g @uncarved/jade@latest");
    expect(upgradeHint("npm")).toBe("npm install -g @uncarved/jade@latest");
  });

  const npm = { kind: "npm" as const, dir: "/usr/local/lib/node_modules/@uncarved/jade" };
  const node = (code: string) => [process.execPath, "-e", code];
  // autoUpdate 把安装进程和计时器都 unref 了（jade 退出时不等它）。jade 运行时界面让事件循环一直活着；
  // 测试里没有别的东西撑着，bun test 会一直等下去，所以等结果期间挂一个计时器
  const alive = async <T>(p: Promise<T>): Promise<T> => {
    const keep = setInterval(() => {}, 1000);
    try {
      return await p;
    } finally {
      clearInterval(keep);
    }
  };

  test("installs in the background and writes the log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-update-"));
    const r = await alive(autoUpdate(home, "0.2.0", { install: npm, command: node("console.log('added 1 package')") }));
    expect(r.status).toBe("installed");
    expect(await readFile(path.join(home, "update.log"), "utf8")).toContain("added 1 package");
    expect(existsSync(path.join(home, "update.lock"))).toBe(false);
  });

  test("does not retry a failed version right away", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-update-"));
    const r = await alive(autoUpdate(home, "0.2.0", { install: npm, command: node("console.error('EACCES'); process.exit(1)") }));
    expect(r).toEqual({ status: "failed", log: path.join(home, "update.log") });
    expect(await readFile(path.join(home, "update.log"), "utf8")).toContain("EACCES");
    expect(await autoUpdate(home, "0.2.0", { install: npm, command: node("") })).toEqual({ status: "skipped", why: "failed-recently" });
    // 更新的版本照常试
    expect((await alive(autoUpdate(home, "0.2.1", { install: npm, command: node("") }))).status).toBe("installed");
  });

  test("one jade updates at a time, and dev installs never update", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "jade-update-"));
    await writeFile(path.join(home, "update.lock"), "1");
    expect(await autoUpdate(home, "0.2.0", { install: npm, command: node("") })).toEqual({ status: "skipped", why: "busy" });
    expect(await autoUpdate(home, "0.2.0", { install: { kind: "dev", dir: "/src/jade" }, command: node("") })).toEqual({ status: "skipped", why: "unsupported" });
  });

  test("JADE_AUTO_UPDATE=off turns it off", () => {
    expect(autoUpdateEnabled()).toBe(true);
    process.env.JADE_AUTO_UPDATE = "off";
    try {
      expect(autoUpdateEnabled()).toBe(false);
    } finally {
      delete process.env.JADE_AUTO_UPDATE;
    }
  });
});

describe("jade/update", () => {
  const npm = { kind: "npm" as const, dir: "/usr/local/lib/node_modules/@uncarved/jade" };
  const home = () => mkdtemp(path.join(os.tmpdir(), "jade-update-"));
  const alive = async <T>(p: Promise<T>): Promise<T> => {
    const keep = setInterval(() => {}, 1000);
    try {
      return await p;
    } finally {
      clearInterval(keep);
    }
  };

  test("installs a newer jade in the background and says to restart", async () => {
    const notes: string[] = [];
    await alive(checkForUpdate({ update: updater(await home(), { install: npm, latest: async () => "99.0.0", command: [process.execPath, "-e", ""] }), auto: true, notify: (m) => notes.push(m) }));
    expect(notes).toEqual(["jade 99.0.0 was installed in the background; restart jade to use it"]);
  });

  test("with auto off it only tells, and an up-to-date or dev jade says nothing", async () => {
    const notes: string[] = [];
    const notify = (m: string) => void notes.push(m);
    await checkForUpdate({ update: updater(await home(), { install: npm, latest: async () => "99.0.0" }), auto: false, notify });
    expect(notes).toEqual([`jade 99.0.0 is available (you have ${VERSION}); run jade update`]);
    notes.length = 0;
    await checkForUpdate({ update: updater(await home(), { install: npm, latest: async () => VERSION }), auto: true, notify });
    await checkForUpdate({ update: updater(await home(), { install: { kind: "dev", dir: "/src/jade" }, latest: async () => "99.0.0" }), auto: true, notify });
    expect(notes).toEqual([]);
  });
});
