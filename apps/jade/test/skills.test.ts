// jade/skills：从旧 jade 的 test/mcp-skills.test.ts 移植 skill 的部分，加上经插件宿主的端到端测试。

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import { loadSkills, parseSkill, skillTool } from "../plugins/skills/skills.ts";
import type { SessionManager, UI } from "../src/index.ts";
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
    const unknown = await skillTool(skills).execute({ name: "nope" }, {} as never);
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
      expect(String(await commands.get("skills")!.command.run("", ctxFor(host.sessions)))).toContain("cut a release");
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
      expect(commands.get("skills")!.command.description).toBe("skills the agent can use");
    } finally {
      await host.close();
    }
  }, 30_000);
});
