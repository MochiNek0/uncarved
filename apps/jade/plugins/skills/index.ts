// jade/skills：skill 工具、系统提示词里的 skill 列表、/skills（列出，以及 add / update / remove，见 install.ts；
// 终端里是 jade skills …），以及每个 skill 一条 /<skill 名> 命令。
//
// 每次调用模型之前重新查找 skill：会话中途装的马上能用，不用 /clear 或重启。随仓库分发的 skill（项目层）不用确认：
// 它只是给模型看的文字，不执行代码；和旧 jade 一样，列表里有项目层的 skill 时整段标为不可信。

import path from "node:path";
import { definePlugin, type Cli, type UI } from "../../src/api.ts";
import type { Approval } from "../approval/index.ts";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import { addSkill, removeSkill, skillsRoot, updateSkills } from "./install.ts";
import { bold, clip, dim, display, estimateTokens, realPath, red, repoRoot, splitArgs } from "./project.ts";
import { loadSkills, skillLine, skillsPrompt, skillTool, type Skill } from "./skills.ts";

const ID = "jade/skills";

/** /<skill> 发给模型的消息：让它先加载这个 skill */
export function skillMessage(name: string, args: string): string {
  return `Use the "${name}" skill${args.trim() ? ` for this: ${args.trim()}` : "."}`;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** cmd 是 "/skills" 或 "jade skills" */
export const manageUsage = (cmd: string) => `usage: ${cmd} [list]
       ${cmd} add <source> [--project] [--path <dir>] [--force]
       ${cmd} update [name…] [--project] [--force]
       ${cmd} remove <name> [--project]

  <source>   a git repository (https://…, git@…, github:user/repo, user/repo; #branch, #tag or #commit at the end),
             an npm package, or a local directory
  --project  use <cwd>/.jade/skills instead of $JADE_HOME/skills
  --path     the skill's directory inside the source (for repositories with several skills)
  --force    replace a skill with the same name, or overwrite local changes on update`;

/** list / add / update / remove，参数已经切好；返回给用户看的结果，用法错误或失败时抛错。cmd 用在提示里 */
export async function manageSkills(
  argv: readonly string[],
  env: { home: string; cwd: string; cmd: string; log?: (text: string) => void; skills?: Skill[] },
): Promise<string> {
  const usage = manageUsage(env.cmd);
  const [sub, ...tail] = argv;
  if (sub === "-h" || sub === "--help" || tail.includes("-h") || tail.includes("--help")) return usage;
  if (sub === undefined || sub === "list") {
    if (tail.length) throw new Error(usage);
    const skills = env.skills ?? (await find(env.home, env.cwd)).skills;
    // 每次请求都带着的：skill 工具的定义（总是注册），和提示词里的 skill 列表。skill 的正文用到时才读入，不算
    const tool = skillTool(() => skills, async () => {}, { user: skillsRoot(env.home, env.cwd, false), project: skillsRoot(env.home, env.cwd, true) });
    const toolTokens = estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
    if (skills.length === 0) {
      return dim(`(no skills) install one with ${env.cmd} add <source>, or put it in ${display(env.cwd, path.join(env.home, "skills"))}/<name>/SKILL.md or .jade/skills/<name>/SKILL.md\nthe skill tool itself takes ≈${toolTokens} tokens in every request`);
    }
    const total = toolTokens + estimateTokens(skillsPrompt(skills)!);
    return [
      ...skills.map((sk) => `${bold(sk.name)} ${dim(`${sk.layer} · ${display(env.cwd, sk.dir)} · ≈${estimateTokens(skillLine(sk))} tokens`)}\n  ${clip(sk.description.replace(/\s+/g, " "), 300)}`),
      dim(`≈${total} tokens in every request (the skill list and the skill tool); a skill's instructions are read only when it is used`),
    ].join("\n");
  }
  const positionals: string[] = [];
  let project = false;
  let force = false;
  let subdir: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a === "--project") project = true;
    else if (a === "--force" || a === "-f") force = true;
    else if (a === "--path") {
      subdir = tail[++i];
      if (subdir === undefined) throw new Error(`--path needs a value\n${usage}`);
    } else if (a.startsWith("--path=")) subdir = a.slice("--path=".length);
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${usage}`);
    else positionals.push(a);
  }
  const root = skillsRoot(env.home, env.cwd, project);
  const later = "a running jade can use it from its next step";
  switch (sub) {
    case "add":
    case "install": {
      if (positionals.length !== 1) throw new Error(usage);
      const { name, dir } = await addSkill(positionals[0]!, { root, cwd: env.cwd, force, ...(subdir ? { subdir } : {}), ...(env.log ? { log: env.log } : {}) });
      return `installed skill ${name} into ${display(env.cwd, dir)}; ${later}`;
    }
    case "update": {
      if (subdir) throw new Error(usage);
      const lines = await updateSkills(positionals, { root, cwd: env.cwd, force, ...(env.log ? { log: env.log } : {}) });
      if (lines.length === 0) return `no skills in ${display(env.cwd, root)} were installed with "${env.cmd} add"`;
      if (lines.some((l) => l.startsWith("updated "))) lines.push("a running jade uses the updated skills from its next step");
      return lines.join("\n");
    }
    case "remove":
    case "rm": {
      if (positionals.length !== 1 || subdir || force) throw new Error(usage);
      const dir = await removeSkill(positionals[0]!, root);
      return `removed skill ${positionals[0]} (${display(env.cwd, dir)})`;
    }
    default:
      throw new Error(usage);
  }
}

async function find(home: string, cwd: string) {
  const here = realPath(cwd);
  return loadSkills({ home, root: realPath(repoRoot(here)), cwd: here });
}

/** 最近一个会话找到的 skill，/skills 显示它 */
let latest: Skill[] | undefined;
/** 最近一个会话注册的 /<skill> 命令 → 撤销函数 */
const skillCommands = new Map<string, () => void>();
/** 已经告诉过用户的警告：每个会话都会重新查找，同样的警告不重复说 */
const warned = new Set<string>();

export default definePlugin({
  process(ctx) {
    latest = undefined;
    skillCommands.clear();
    ctx.service<Commands>("commands@1")?.register({
      name: "skills",
      args: "[add <source> | update [name…] | remove <name>] [--project]",
      description: "skills the agent can use; install them from git, npm or a directory",
      instant: true,
      async run(args, cctx) {
        let argv: string[];
        try {
          argv = splitArgs(args);
        } catch (e) {
          return red(errorText(e));
        }
        try {
          return await manageSkills(argv, { home: ctx.home, cwd: ctx.cwd, cmd: "/skills", log: (t) => cctx.print(dim(t)), ...(latest ? { skills: latest } : {}) });
        } catch (e) {
          return red(errorText(e));
        }
      },
    });
    // 同样的事也能在终端里做：jade skills add <source> [--project]（cli@1，核心提供）
    ctx.service<Cli>("cli@1")?.register({
      name: "skills",
      run: (argv, cli) => manageSkills(argv, { home: ctx.home, cwd: ctx.cwd, cmd: "jade skills", log: cli.log }),
    });
  },

  async session(ctx) {
    const ui = ctx.service<UI>("ui@1");
    const approval = ctx.service<Approval>("approval@1");
    const prompts = ctx.service<Prompts>("prompts@1");
    const commands = ctx.service<Commands>("commands@1");

    /** 这个会话现在的 skill，和据此加上的东西（都挂在会话作用域上，随会话撤销） */
    let current: Skill[] = [];
    let shown = "";
    let removeSection: (() => void) | undefined;
    const readable = new Map<string, () => void>();
    /** 这个会话注册过的 /<skill> 命令 */
    const mine = new Set<string>();

    /** 用新找到的 skill 更新提示词里的列表、可读目录和 /<skill> 命令；没变时什么也不做（不让提示缓存失效） */
    const apply = (skills: Skill[], warnings: string[]) => {
      for (const w of warnings) {
        if (warned.has(w)) continue;
        warned.add(w);
        ui?.notify(`${ID}: ${w}`, "warning");
      }
      current = skills;
      latest = skills;
      const key = JSON.stringify(skills.map((s) => [s.name, s.description, s.dir, s.layer]));
      if (key === shown) return;
      shown = key;

      // 有随仓库分发的 skill 时整段不可信
      removeSection?.();
      removeSection = skills.length ? prompts?.add({ text: skillsPrompt(skills)!, untrusted: !skills.every((s) => s.layer === "user") }) : undefined;

      // 读 skill 目录里的文件（脚本、参考资料）不用问
      const dirs = new Set(skills.map((s) => s.dir));
      for (const [dir, revoke] of readable) if (!dirs.has(dir)) (revoke(), readable.delete(dir));
      for (const dir of dirs) if (!readable.has(dir) && approval) readable.set(dir, approval.allowRead(dir));

      // skill 也可以当命令用：/<skill 名> [要做的事]。
      // 新会话在旧会话关闭之前打开：旧会话注册的同名命令先撤销，换成这个会话的。
      // 名字已被别的插件的命令占用时让给它（会话级的注册总在进程级的命令之后）
      if (!commands) return;
      const names = new Set(skills.map((s) => s.name.toLowerCase()));
      for (const [key, revoke] of skillCommands) {
        if (names.has(key)) continue;
        revoke();
        skillCommands.delete(key);
        mine.delete(key);
      }
      for (const sk of skills) {
        const key = sk.name.toLowerCase();
        if (mine.has(key)) continue;
        const taken = commands.get(sk.name);
        if (taken && taken.plugin !== ID) continue;
        if (taken) skillCommands.get(key)?.();
        try {
          const revoke = commands.register({
            name: sk.name,
            args: "[task]",
            description: `${clip(sk.description.replace(/\s+/g, " "), 80)} (skill)`,
            run: (args) => ({ prompt: skillMessage(sk.name, args) }),
          });
          skillCommands.set(key, revoke);
          mine.add(key);
        } catch {
          // 名字不能当命令名（commands@1 的规则更严）或刚被占用：只是少一条快捷命令
        }
      }
    };
    const refresh = async () => {
      const { skills, warnings } = await find(ctx.home, ctx.cwd);
      apply(skills, warnings);
    };
    await refresh();

    // 会话中途装的 skill（/skills add、jade skills add，或模型自己装的）马上能用：
    // 工具列表在会话创建时就定了，所以 skill 工具总是注册；每次调用模型之前重新查找一次，
    // 列表变了才更新提示词。context.project 在 context.build（jade/prompts 拼提示词）之前执行
    ctx.kernel.tool(skillTool(() => current, refresh, { user: skillsRoot(ctx.home, ctx.cwd, false), project: skillsRoot(ctx.home, ctx.cwd, true) }));
    ctx.kernel.hook({
      kind: "transform",
      point: "context.project",
      // 查找出错时沿用上一次的列表，不让这一轮失败
      optional: true,
      fn: async (messages) => {
        await refresh();
        return messages;
      },
    });
  },
});
