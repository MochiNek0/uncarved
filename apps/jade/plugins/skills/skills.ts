// Skills：打包好的做事方法。一个目录就是一个 skill，入口是 SKILL.md（和 Claude Code、Agent Skills 的格式相同）：
//   ---
//   name: pdf
//   description: 读取、合并、拆分 PDF。处理 PDF 文件时使用
//   ---
//   正文：具体步骤，可以引用同目录里的脚本、模板、参考资料
//
// 系统提示词里只列出每个 skill 的名字和描述；模型判断任务用得上时调用 skill 工具，才读入正文（渐进加载，省上下文）。
// 用户也可以用 /<skill 名> 直接要求使用某个 skill。
//
// 查找位置（同名时后面的覆盖前面的）：
//   ~/.claude/skills、$JADE_HOME/skills（用户层）；
//   仓库根目录到工作目录每一级的 .claude/skills、.jade/skills（项目层）。
// 从旧 jade 的 src/skills.ts 移植；旧 jade 的"插件自带 skills 目录"（PluginBundle）没有移植：新的插件宿主没有内容包的概念。

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Tool } from "uncarved";
import { projectDirs } from "./project.ts";

export interface Skill {
  name: string;
  description: string;
  /** skill 目录的绝对路径 */
  dir: string;
  layer: "user" | "project";
  /** 前一个同名 skill 被它覆盖 */
  overrides?: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
/** 系统提示词里每个描述的上限 */
const MAX_DESCRIPTION = 400;
/** skill 工具列出的目录内文件数上限 */
const MAX_FILES = 60;

export async function loadSkills(opts: {
  home: string;
  root: string;
  cwd: string;
  /** 用户的主目录，读 ~/.claude/skills 用；测试时可以换掉 */
  userHome?: string;
}): Promise<{ skills: Skill[]; warnings: string[] }> {
  const dirs: { dir: string; layer: Skill["layer"] }[] = [
    { dir: path.join(opts.userHome ?? os.homedir(), ".claude", "skills"), layer: "user" },
    { dir: path.join(opts.home, "skills"), layer: "user" },
  ];
  for (const d of projectDirs(opts.root, opts.cwd)) {
    dirs.push({ dir: path.join(d, ".claude", "skills"), layer: "project" }, { dir: path.join(d, ".jade", "skills"), layer: "project" });
  }
  const out = new Map<string, Skill>();
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { dir, layer } of dirs) {
    // JADE_HOME 就是 ~/.claude 之类的情况，同一个目录不读两次
    if (seen.has(path.resolve(dir))) continue;
    seen.add(path.resolve(dir));
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const skillDir = path.join(dir, n);
      let text: string;
      try {
        if (!(await stat(skillDir)).isDirectory()) continue;
        text = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const { meta, body } = parseSkill(text);
      const name = meta.name && NAME.test(meta.name) ? meta.name : n;
      if (!NAME.test(name)) {
        warnings.push(`skill ${skillDir} is skipped: the name may only contain letters, digits, - and _`);
        continue;
      }
      const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
      const description = (meta.description || firstLine).trim();
      if (!description) {
        warnings.push(`skill ${skillDir} is skipped: SKILL.md has no description`);
        continue;
      }
      const prev = out.get(name.toLowerCase());
      out.set(name.toLowerCase(), {
        name,
        description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description,
        dir: skillDir,
        layer,
        overrides: prev?.dir,
      });
    }
  }
  return { skills: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** front matter 里的简单键值（支持引号和 YAML 的 > | 多行写法），以及正文 */
export function parseSkill(text: string): { meta: Record<string, string>; body: string } {
  let body = text.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fm) {
    const lines = fm[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[i]!);
      if (!m) continue;
      let value = m[2]!;
      if (/^[>|][+-]?$/.test(value)) {
        // 多行：后面缩进的行都属于这个值
        const parts: string[] = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) parts.push(lines[++i]!.trim());
        value = parts.join(value.startsWith(">") ? " " : "\n").trim();
      }
      meta[m[1]!.toLowerCase()] = value.replace(/^(["'])(.*)\1$/, "$2");
    }
    body = body.slice(fm[0].length);
  }
  return { meta, body: body.trim() };
}

/** 系统提示词里的 skill 列表；没有 skill 时为 undefined */
export function skillsPrompt(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    "# Skills",
    "Skills are packaged instructions for specific kinds of tasks, installed by the user or shipped with the repository. " +
      "When a task matches a skill's description, call the skill tool with its name before starting, then follow the instructions it returns. " +
      "Files a skill refers to are relative to its directory, which the skill tool tells you.",
    "",
    ...skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`),
  ].join("\n");
}

/** skill 工具：读入某个 skill 的正文，以及它目录里的文件 */
export function skillTool(skills: Skill[]): Tool {
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  return {
    name: "skill",
    description:
      "Load the instructions of a skill listed in the system prompt. Call it when a task matches the skill's description, then follow the instructions.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: skills.map((s) => s.name), description: "the skill's name" } },
      required: ["name"],
      additionalProperties: false,
    },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      const name = String((input as { name?: unknown }).name ?? "");
      const skill = byName.get(name.toLowerCase());
      if (!skill) return { content: `There is no skill named ${JSON.stringify(name)}. Available: ${skills.map((s) => s.name).join(", ")}.`, isError: true };
      let text: string;
      try {
        text = await readFile(path.join(skill.dir, "SKILL.md"), "utf8");
      } catch (err) {
        return { content: `Could not read the skill: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const files = (await listFiles(skill.dir)).filter((f) => f !== "SKILL.md");
      const shown = files.slice(0, MAX_FILES);
      return {
        content: [
          `Skill "${skill.name}" (${skill.layer === "project" ? "shipped with the repository" : "installed by the user"}).`,
          `Its directory is ${skill.dir}; paths in the instructions are relative to it.`,
          files.length ? `Files in the skill:\n${shown.map((f) => `  ${f}`).join("\n")}${files.length > shown.length ? `\n  … ${files.length - shown.length} more` : ""}` : "",
          "",
          parseSkill(text).body,
        ]
          .filter((l, i) => l !== "" || i === 3)
          .join("\n"),
      };
    },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
      .filter((f) => !f.split("/").some((seg) => seg.startsWith(".") || seg === "node_modules" || seg === "__pycache__"))
      .sort();
  } catch {
    return [];
  }
}
