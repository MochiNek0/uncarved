// 输入框的补全：候选由 jade/mentions 经 completions@1 给（工作目录里的文件，git 仓库里只看版本控制的，目录以 / 结尾），
// jade/tui 只认触发字符、排序（rankPaths）和插入。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mentionCandidates } from "../plugins/mentions/candidates.ts";
import { mentionAt, mentionText, rankPaths } from "../plugins/tui/mentions.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "jade-mentions-"));
  tmp.push(d);
  return d;
}

describe("mentionCandidates", () => {
  test("lists files and the directories that contain them", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "a.ts"), "");
    await writeFile(path.join(cwd, "readme.md"), "");
    await mkdir(path.join(cwd, "src", "deep"), { recursive: true });
    await writeFile(path.join(cwd, "src", "b.ts"), "");
    await writeFile(path.join(cwd, "src", "deep", "c.ts"), "");

    const found = await mentionCandidates(cwd);
    for (const p of ["a.ts", "readme.md", "src/", "src/b.ts", "src/deep/", "src/deep/c.ts"]) expect(found).toContain(p);
  });

  test("skips .git and node_modules", async () => {
    const cwd = await dir();
    await writeFile(path.join(cwd, "keep.ts"), "");
    for (const d of [".git", "node_modules"]) {
      await mkdir(path.join(cwd, d), { recursive: true });
      await writeFile(path.join(cwd, d, "hidden.ts"), "");
    }
    const found = await mentionCandidates(cwd);
    expect(found).toContain("keep.ts");
    expect(found.some((p) => p.startsWith(".git/") || p.startsWith("node_modules/"))).toBe(false);
  });
});

describe("@ reference helpers", () => {
  test("mentionAt finds the path being typed at the cursor", () => {
    expect(mentionAt("look at @src/a", 14, ["@"])).toEqual({ trigger: "@", start: 8, query: "src/a" });
    // 引用带引号的路径：一开始引号是路径的一部分
    expect(mentionAt('see @"my', 8, ["@"])).toEqual({ trigger: "@", start: 4, query: "my" });
    expect(mentionAt("mail me@example.com", 18, ["@"])).toBeUndefined();
    // 光标在 @ 引用之前：不在引用里
    expect(mentionAt("at @src/a b", 3, ["@"])).toBeUndefined();
    // 只认登记了的触发字符；正则里有特殊意思的字符也照常
    expect(mentionAt("x #tag", 6, ["@"])).toBeUndefined();
    expect(mentionAt("x #tag", 6, ["@", "#"])).toEqual({ trigger: "#", start: 2, query: "tag" });
    expect(mentionAt("x ]y", 4, ["]", "^"])).toEqual({ trigger: "]", start: 2, query: "y" });
    expect(mentionAt("x @a", 4, [])).toBeUndefined();
  });

  test("mentionText quotes paths with spaces", () => {
    expect(mentionText("@", "src/a.ts")).toBe("@src/a.ts");
    expect(mentionText("@", "my file.txt")).toBe('@"my file.txt"');
  });

  test("rankPaths puts name matches before path matches", () => {
    const paths = ["src/util.ts", "util/", "src/util/helper.ts", "deep/notes/util.ts"];
    // 文件名以 query 开头的（util/、src/util.ts）在前；只在路径中间的（src/util/helper.ts）最后
    expect(rankPaths(paths, "util", 10)).toEqual(["util/", "src/util.ts", "deep/notes/util.ts", "src/util/helper.ts"]);
    // 空 query：只给顶层的文件和目录（保持候选原来的顺序）
    expect(rankPaths([...paths, "a.ts"], "", 10).sort()).toEqual(["a.ts", "util/"]);
  });

  test("rankPaths gives the same result when the query grows one key at a time, and after it shrinks", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `pkg${i % 7}/src/${["util", "main", "Ui", "tools"][i % 4]}${i}.ts`);
    // 每次换一个新数组：不用上一次的结果
    const fresh = (q: string) => rankPaths([...paths], q, 1000);
    for (const q of ["u", "ut", "uti", "util", "util1", "ut", "m", "mi", "src/u", "SRC/U"]) expect(rankPaths(paths, q, 1000)).toEqual(fresh(q));
  });
});
