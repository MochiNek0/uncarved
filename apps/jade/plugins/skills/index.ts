// jade/skills：skill 工具、系统提示词里的 skill 列表、/skills，以及每个 skill 一条 /<skill 名> 命令。
//
// 每个会话打开时重新查找 skill（/clear 之后能用上新装的）。随仓库分发的 skill（项目层）不用确认：
// 它只是给模型看的文字，不执行代码；和旧 jade 一样，列表里有项目层的 skill 时整段标为不可信。

import path from "node:path";
import { definePlugin, type UI } from "../../src/api.ts";
import type { Approval } from "../approval/index.ts";
import type { Commands } from "../commands/index.ts";
import type { Prompts } from "../prompts/index.ts";
import { bold, clip, dim, display, realPath, repoRoot } from "./project.ts";
import { loadSkills, skillsPrompt, skillTool, type Skill } from "./skills.ts";

const ID = "jade/skills";

/** /<skill> 发给模型的消息：让它先加载这个 skill */
export function skillMessage(name: string, args: string): string {
  return `Use the "${name}" skill${args.trim() ? ` for this: ${args.trim()}` : "."}`;
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
      description: "skills the agent can use",
      instant: true,
      async run() {
        const skills = latest ?? (await find(ctx.home, ctx.cwd)).skills;
        if (skills.length === 0) {
          return dim(`(no skills) put them in ${display(ctx.cwd, path.join(ctx.home, "skills"))}/<name>/SKILL.md or .jade/skills/<name>/SKILL.md`);
        }
        return skills
          .map((sk) => `${bold(sk.name)} ${dim(`${sk.layer} · ${display(ctx.cwd, sk.dir)}`)}\n  ${clip(sk.description.replace(/\s+/g, " "), 300)}`)
          .join("\n");
      },
    });
  },

  async session(ctx) {
    const { skills, warnings } = await find(ctx.home, ctx.cwd);
    latest = skills;
    const ui = ctx.service<UI>("ui@1");
    for (const w of warnings) {
      if (warned.has(w)) continue;
      warned.add(w);
      ui?.notify(`${ID}: ${w}`, "warning");
    }
    if (skills.length === 0) return;

    ctx.kernel.tool(skillTool(skills));
    const text = skillsPrompt(skills)!;
    // 读 skill 目录里的文件（脚本、参考资料）不用问；会话关闭时撤销
    const approval = ctx.service<Approval>("approval@1");
    for (const sk of skills) approval?.allowRead(sk.dir);
    // 有随仓库分发的 skill 时整段不可信
    ctx.service<Prompts>("prompts@1")?.add({ text, untrusted: !skills.every((s) => s.layer === "user") });

    // skill 也可以当命令用：/<skill 名> [要做的事]。挂在会话作用域上，随会话撤销。
    // 新会话在旧会话关闭之前打开：旧会话注册的同名命令先撤销，换成这个会话的。
    // 名字已被别的插件的命令占用时让给它（会话级的注册总在进程级的命令之后）
    const commands = ctx.service<Commands>("commands@1");
    if (commands) {
      for (const sk of skills) {
        const key = sk.name.toLowerCase();
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
        } catch {
          // 名字不能当命令名（commands@1 的规则更严）或刚被占用：只是少一条快捷命令
        }
      }
    }
  },
});
