// jade/skills：从旧 jade 的 test/mcp-skills.test.ts 移植 skill 的部分，加上经插件宿主的端到端测试。

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { manageSkills } from "../plugins/skills/index.ts";
import { readRecords } from "../plugins/skills/install.ts";
import { loadSkills, parseSkill, skillTool } from "../plugins/skills/skills.ts";
import { fetchSource } from "../src/fetch.ts";
import { parseSource, treeHash, type SessionManager, type Sources, type UI } from "../src/index.ts";
import { featureHost, msg, reply, results, tempDir, textOf, use } from "./feature-host.ts";

async function skill(base: string, name: string, text: string, files: Record<string, string> = {}) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), text);
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), c);
  }
  return dir;
}

/** 和核心给插件的 sources@1 是同一份函数 */
const sources: Sources = { parse: parseSource, fetch: fetchSource, hash: treeHash };
const ui: UI = { interactive: false, notify: () => {}, select: async () => undefined, input: async () => undefined };
const ctxFor = (sessions: SessionManager): CommandContext => ({ signal: new AbortController().signal, ui, sessions, print: () => {} });

describe("skills", () => {
  test("parses front matter, including multi-line descriptions", () => {
    const { meta, body } = parseSkill("---\nname: pdf\ndescription: >\n  Work with PDFs.\n  Use for PDF files.\nlicense: MIT\n---\n# Steps\n1. go\n");
    expect(meta).toEqual({ name: "pdf", description: "Work with PDFs. Use for PDF files.", license: "MIT" });
    expect(body).toBe("# Steps\n1. go");
  });

  test("found in ~/.claude/skills, $JADE_HOME/skills and the project's .claude/.jade skills; nearer wins", async () => {
    const root = await tempDir("jade-skills-");
    const home = await tempDir("jade-skills-home-");
    const userHome = await tempDir("jade-skills-user-");
    await skill(path.join(userHome, ".claude", "skills"), "review", "---\ndescription: claude review\n---\nA");
    await skill(path.join(home, "skills"), "review", "---\ndescription: jade review\n---\nB");
    await skill(path.join(root, ".claude", "skills"), "deploy", "---\nname: deploy\ndescription: deploy it\n---\nC");
    await skill(path.join(root, ".jade", "skills"), "nodesc", "");
    await skill(path.join(root, ".jade", "skills"), "fallback", "# Uses the first line\nbody");
    const { skills, warnings } = await loadSkills({ home, root, cwd: root, userHome });
    expect(skills.map((x) => [x.name, x.description, x.layer])).toEqual([
      ["deploy", "deploy it", "project"],
      ["fallback", "Uses the first line", "project"],
      ["review", "jade review", "user"],
    ]);
    expect(warnings.join("\n")).toContain("no description");
    const unknown = await skillTool(() => skills, async () => {}, { user: "u", project: "p" }).execute({ name: "nope" }, {} as never);
    expect(unknown.isError).toBe(true);
  });
});

describe("jade/skills plugin", () => {
  test("the skill list is trusted system text via prompts@1; the skill tool loads instructions; /skills and /<skill> work", async () => {
    const home = await tempDir("jade-skills-home-");
    const dir = await skill(path.join(home, "skills"), "release", "---\ndescription: cut a release\n---\nRun scripts/release.sh, then read notes.md.", {
      "notes.md": "release notes template",
      "scripts/release.sh": "echo",
    });
    const { host, state } = await featureHost({ home });
    try {
      state.script.push(
        { content: [use("k", "skill", { name: "release" })], stopReason: "tool_use" },
        { content: [use("r", "read_file", { path: path.join(dir, "notes.md") })], stopReason: "tool_use" },
        reply("done"),
      );
      const s = await host.sessions.open();
      await s.send(msg("make a release"));
      const listed = state.requests[0]!.system.find((x) => x.text.startsWith("# Skills"))!;
      expect(listed.text).toContain("- release: cut a release");
      expect(listed.trust).toBe("trusted");
      const loaded = textOf(results(state.requests[1]!)[0]!.content);
      expect(loaded).toContain(`Its directory is ${dir}`);
      expect(loaded).toContain("scripts/release.sh");
      expect(loaded).toContain("Run scripts/release.sh");
      expect(loaded).not.toContain("description:");
      // skill 目录在工作目录之外，读它不用问（approval@1 的 allowRead）
      expect(textOf(results(state.requests[2]!)[0]!.content)).toContain("release notes template");
      expect(state.selects).toEqual([]);

      const commands = host.service<Commands>("commands@1")!;
      const shown = String(await commands.get("skills")!.command.run("", ctxFor(host.sessions)));
      expect(shown).toContain("cut a release");
      // 每个 skill、合计都估算了每次请求占多少 token；合计包括 skill 工具本身
      const each = Number(/release .*≈(\d+) tokens/.exec(shown)![1]);
      const total = Number(/≈(\d+) tokens in every request/.exec(shown)![1]);
      expect(each).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(each + 50);
      expect(await commands.get("release")!.command.run("v2", ctxFor(host.sessions))).toEqual({ prompt: 'Use the "release" skill for this: v2' });
      // 换会话时会话级的 /<skill> 撤销、按新会话找到的 skill 重新注册
      await host.sessions.open();
      expect(commands.get("release")).toBeDefined();
    } finally {
      await host.close();
    }
  }, 30_000);

  test("a skill shipped with the repository makes the list untrusted; a skill named like a command does not take it", async () => {
    const home = await tempDir("jade-skills-home-");
    const cwd = await tempDir("jade-skills-repo-");
    await mkdir(path.join(cwd, ".git"));
    await skill(path.join(cwd, ".jade", "skills"), "deploy", "---\ndescription: deploy it\n---\nsteps");
    await skill(path.join(cwd, ".jade", "skills"), "skills", "---\ndescription: shadows /skills\n---\nsteps");
    const { host, state } = await featureHost({ home, cwd });
    try {
      state.script.push(reply("ok"));
      await (await host.sessions.open()).send(msg("hi"));
      const listed = state.requests[0]!.system.find((x) => x.text.startsWith("# Skills"))!;
      expect(listed.trust).toBe("untrusted");
      expect(listed.text).toContain("- deploy: deploy it");
      const commands = host.service<Commands>("commands@1")!;
      expect(commands.get("deploy")!.plugin).toBe("jade/skills");
      expect(commands.get("skills")!.command.description).toStartWith("skills the agent can use");
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("skills installed while jade is running", () => {
  test("are listed and loadable from the next model call, without /clear; the skill tool is there even with no skills and says where to install", async () => {
    const home = await tempDir("jade-skills-home-");
    const { host, state, cwd } = await featureHost({ home });
    try {
      state.script.push(reply("none yet"));
      const s = await host.sessions.open();
      await s.send(msg("hi"));
      const first = state.requests[0]!;
      expect(first.system.some((x) => x.text.startsWith("# Skills"))).toBe(false);
      const tool = first.tools.find((t) => t.name === "skill")!;
      expect(tool.description).toContain("jade skills add");
      expect(tool.description).toContain(path.join(home, "skills"));
      expect(tool.description).toContain(path.join(cwd, ".jade", "skills"));

      // 同一个会话里装一个 skill（相当于 jade skills add，或者模型自己在 shell 里装）
      await skill(path.join(home, "skills"), "release", "---\ndescription: cut a release\n---\nRun the release script.");
      state.script.push({ content: [use("k", "skill", { name: "release" })], stopReason: "tool_use" }, reply("done"));
      await s.send(msg("make a release"));
      const listed = state.requests[1]!.system.find((x) => x.text.startsWith("# Skills"))!;
      expect(listed.text).toContain("- release: cut a release");
      expect(textOf(results(state.requests[2]!)[0]!.content)).toContain("Run the release script.");
      expect(host.service<Commands>("commands@1")!.get("release")?.plugin).toBe("jade/skills");
      // 工具列表不变（提示缓存不失效）
      expect(state.requests[1]!.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name));
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("installing skills", () => {
  const HAS_GIT = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test("add from a local directory into $JADE_HOME/skills, or <cwd>/.jade/skills with --project; update and remove", async () => {
    const home = await tempDir("jade-skills-home-");
    const cwd = await tempDir("jade-skills-cwd-");
    const src = await tempDir("jade-skills-src-");
    const dir = await skill(src, "pdf-tools", "---\nname: pdf\ndescription: work with PDFs\n---\nv1", { "scripts/a.py": "print(1)" });

    expect(await manageSkills(["add", dir], { home, cwd, cmd: "/skills", sources })).toContain("installed skill pdf");
    expect(await readFile(path.join(home, "skills", "pdf", "scripts", "a.py"), "utf8")).toBe("print(1)");
    expect(await manageSkills(["add", dir, "--project"], { home, cwd, cmd: "/skills", sources })).toContain("installed skill pdf into .jade/skills/pdf");
    expect(existsSync(path.join(cwd, ".jade", "skills", "pdf", "SKILL.md"))).toBe(true);
    // 装好的 skill 能被找到
    const { skills } = await loadSkills({ home, root: cwd, cwd, userHome: await tempDir("jade-skills-user-") });
    expect(skills.map((s) => [s.name, s.layer])).toEqual([["pdf", "project"]]);

    await expect(manageSkills(["add", dir], { home, cwd, cmd: "/skills", sources })).rejects.toThrow("already installed");
    expect(await manageSkills(["update"], { home, cwd, cmd: "/skills", sources })).toBe("current pdf");
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: pdf\ndescription: work with PDFs\n---\nv2");
    expect(await manageSkills(["update", "pdf"], { home, cwd, cmd: "/skills", sources })).toContain("updated pdf");
    expect(await readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf8")).toContain("v2");
    // 装好后手动改过的不覆盖，除非 --force
    await writeFile(path.join(home, "skills", "pdf", "SKILL.md"), "---\ndescription: mine\n---\nlocal edit");
    expect(await manageSkills(["update"], { home, cwd, cmd: "/skills", sources })).toContain("changed since it was installed");
    expect(await manageSkills(["update", "--force"], { home, cwd, cmd: "/skills", sources })).toContain("pdf");
    expect(await readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf8")).toContain("v2");

    expect(await manageSkills(["remove", "pdf"], { home, cwd, cmd: "/skills", sources })).toContain("removed skill pdf");
    expect(existsSync(path.join(home, "skills", "pdf"))).toBe(false);
    expect(await readRecords(path.join(home, "skills"))).toEqual({});
    expect(existsSync(path.join(cwd, ".jade", "skills", "pdf"))).toBe(true);
    await expect(manageSkills(["remove", "../x"], { home, cwd, cmd: "/skills", sources })).rejects.toThrow("invalid skill name");
  });

  test.skipIf(!HAS_GIT)("a git repository with several skills: lists them, --path picks one", async () => {
    const home = await tempDir("jade-skills-home-");
    const repo = await tempDir("jade-skills-repo-");
    await skill(path.join(repo, "skills"), "docx", "---\ndescription: Word files\n---\nsteps");
    await skill(path.join(repo, "skills"), "xlsx", "---\ndescription: spreadsheets\n---\nsteps");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    const url = pathToFileURL(repo).href;
    await expect(manageSkills(["add", `git+${url}`], { home, cwd: home, cmd: "/skills", sources })).rejects.toThrow(/skills\/docx\n  skills\/xlsx/);
    expect(await manageSkills(["add", `git+${url}`, "--path", "skills/xlsx"], { home, cwd: home, cmd: "/skills", sources })).toContain("installed skill xlsx");
    const rec = (await readRecords(path.join(home, "skills"))).xlsx!;
    expect(rec.kind).toBe("git");
    expect(rec.subdir).toBe("skills/xlsx");
    expect(rec.commit).toMatch(/^[0-9a-f]{40}$/);
    // staging 目录被清掉
    expect((await readdir(path.join(home, "skills"))).filter((n) => n.startsWith(".staging"))).toEqual([]);
  }, 30_000);

  test("/skills add through the plugin; quoted arguments; usage errors are shown, not thrown", async () => {
    const home = await tempDir("jade-skills-home-");
    const src = await tempDir("jade skills src ");
    const dir = await skill(src, "notes", "---\ndescription: take notes\n---\nsteps");
    const { host } = await featureHost({ home });
    try {
      const run = (args: string) => host.service<Commands>("commands@1")!.get("skills")!.command.run(args, ctxFor(host.sessions));
      expect(String(await run(`add "${dir}"`))).toContain("installed skill notes");
      expect(String(await run("add"))).toContain("usage: /skills");
      expect(String(await run('add "unclosed'))).toContain("unclosed");
    } finally {
      await host.close();
    }
  }, 30_000);
});
