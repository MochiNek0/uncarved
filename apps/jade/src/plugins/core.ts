// 内置插件里和界面有关的部分：/memory、/skills、/mcp、/checks、/compact 这些斜杠命令，
// 以及把一段系统提示词、一个"第几次回复"计数器挂到插件上的小工具。
// 命令用的是第三方插件同样的 PluginCommand 接口（ctx.ui 交互、ctx.note 告诉模型），停用插件时命令也一起消失。

import path from "node:path";
import type { HookSpec, SystemSegment, Trust } from "uncarved";
import type { Check, Checks } from "./checks.ts";
import type { Compactor } from "./compact.ts";
import type { JadePlugin, PluginCommand } from "./loader.ts";
import { MEMORY_SCOPES, type Memory, type MemoryScope } from "../memory.ts";
import { describeServer, type McpClient } from "../mcp.ts";
import type { Skill } from "../skills.ts";
import { display } from "../tools/fs.ts";
import { clip } from "../ui/render.ts";
import { bold, dim, green, red, yellow } from "../ui/screen.ts";

/** 给插件加一个 context.build hook，把这些段落接在已有的系统提示词后面 */
export function withSystem<T extends JadePlugin>(plugin: T, parts: { text: string; trust: Trust }[]): T {
  if (parts.length === 0) return plugin;
  const segments: SystemSegment[] = parts.map(({ text, trust }) => ({ text, trust, stability: "stable", origin: { by: "plugin", id: plugin.id } }));
  return addHook(plugin, { kind: "transform", point: "context.build", fn: (req) => ({ ...req, system: [...req.system, ...segments] }) });
}

/** 每次请求模型前加一：工具据此判断两个调用是不是同一次回复里发出的 */
export function withCounter<T extends JadePlugin>(plugin: T, counter: { calls: number }): T {
  return addHook(plugin, {
    kind: "transform",
    point: "model.before",
    fn: () => {
      counter.calls++;
    },
  });
}

function addHook<T extends JadePlugin>(plugin: T, hook: HookSpec): T {
  const need = `${hook.kind}:${hook.point}`;
  return { ...plugin, hooks: [...(plugin.hooks ?? []), hook], needs: [...new Set([...(plugin.needs ?? []), need])] };
}

// ---------- /memory ----------

export function memoryCommand(memory: Memory): PluginCommand {
  return {
    name: "memory",
    args: "[text]",
    description: "see and remove what jade remembers across sessions, or remember text",
    instant: true,
    async run(args, { ui, note }) {
      let text = args.trim();
      if (!text) {
        const entries = (await Promise.all(MEMORY_SCOPES.map(async (scope) => (await memory.list(scope)).map((t) => ({ scope, text: t }))))).flat();
        if (!ui.interactive) return entries.length ? entries.map((e) => `${e.scope}: ${e.text}`).join("\n") : "jade does not remember anything yet";
        const choice = await ui.select<{ scope: MemoryScope; text: string } | "add">(
          entries.length ? "Memory: choose an entry to remove it, or add one" : "jade does not remember anything yet",
          [{ label: "Add a memory…", value: "add" as const }, ...entries.map((e) => ({ label: e.text, value: e, hint: e.scope }))],
          { body: dim(`user (all projects): ${memory.files.user}\nproject: ${memory.files.project}`) },
        );
        if (!choice) return;
        if (choice !== "add") {
          const ok = await ui.select(
            `Remove this ${choice.scope} memory?`,
            [
              { label: "No", value: false },
              { label: "Yes, remove it", value: true },
            ],
            { body: choice.text },
          );
          if (!ok) return;
          await memory.remove(choice.scope, choice.text);
          note(`The user removed this ${choice.scope} memory, so stop following it: ${choice.text}`);
          return green(`Removed from ${choice.scope} memory: ${choice.text}`);
        }
        text = (await ui.input("What should jade remember?", { placeholder: "e.g. Reply in Chinese; run tests with bun test" })) ?? "";
        if (!text) return;
      }
      const scope = await ui.select<MemoryScope>("Remember it for", [
        { label: "All projects", value: "user", hint: "user memory" },
        { label: "This project only", value: "project", hint: "project memory" },
      ]);
      if (!scope) return;
      const added = await memory.add(scope, text);
      if (added) note(`The user saved a ${scope} memory; follow it from now on: ${text}`);
      return added ? green(`Saved to ${scope} memory.`) : dim(`The ${scope} memory already has this.`);
    },
  };
}

// ---------- /skills ----------

export function skillsCommand(skills: Skill[], opts: { cwd: string; home: string }): PluginCommand {
  return {
    name: "skills",
    description: "skills the agent can use",
    instant: true,
    run() {
      if (skills.length === 0) {
        return dim(`(no skills) put them in ${display(opts.cwd, path.join(opts.home, "skills"))}/<name>/SKILL.md or .jade/skills/<name>/SKILL.md`);
      }
      return skills
        .map((sk) => {
          const from = sk.plugin ? `plugin ${sk.plugin}` : sk.layer;
          return `${bold(sk.name)} ${dim(`${from} · ${display(opts.cwd, sk.dir)}`)}\n  ${clip(sk.description.replace(/\s+/g, " "), 300)}`;
        })
        .join("\n");
    },
  };
}

// ---------- /mcp ----------

export function mcpCommand(clients: McpClient[], opts: { cwd: string; home: string }): PluginCommand {
  return {
    name: "mcp",
    args: "[reconnect <name>]",
    description: "MCP servers: status and tools",
    instant: true,
    async run(args) {
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (words[0] === "reconnect") {
        const c = clients.find((x) => x.name === words[1]);
        if (!c) return red(`usage: /mcp reconnect <name>; servers: ${clients.map((x) => x.name).join(", ") || "(none)"}`);
        await c.close();
        try {
          await c.connect();
          return green(`${c.name} connected, ${c.tools.length} tools`);
        } catch (err) {
          return red(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (clients.length === 0) {
        return dim(`(no MCP servers) configure them in ${display(opts.cwd, path.join(opts.home, "mcp.json"))}, .mcp.json or .jade/mcp.json`);
      }
      const lines: string[] = [];
      for (const c of clients) {
        const state = c.status === "connected" ? green("connected") : c.status === "failed" ? red("failed") : yellow(c.status);
        const info = c.serverInfo?.name ? ` · ${c.serverInfo.name}${c.serverInfo.version ? ` ${c.serverInfo.version}` : ""}` : "";
        const from = c.entry.plugin ? `plugin ${c.entry.plugin}` : `${c.entry.layer} · ${display(opts.cwd, c.entry.file)}`;
        lines.push(`${bold(c.name)} ${state} ${dim(`${from} · ${describeServer(c.entry.config)}${info}`)}`);
        if (c.error) lines.push(red(`  ${c.error}`));
        if (c.tools.length) {
          lines.push(`  tools  ${c.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? dim(" (read)") : ""}`).join(", ")}`);
        }
        if (c.status === "failed" && c.stderr.length) lines.push(dim(c.stderr.map((l) => `  │ ${clip(l, 200)}`).join("\n")));
      }
      return lines.join("\n");
    },
  };
}

/** MCP 服务在初始化时给出的使用说明，放进系统提示词（来自外部，untrusted） */
export function mcpInstructions(clients: McpClient[]): { text: string; trust: Trust }[] {
  return clients
    .filter((c) => c.status === "connected" && c.instructions)
    .map((c) => ({ text: `# Instructions from the MCP server "${c.name}" (about its mcp__${c.name}__* tools)\n\n${c.instructions}`, trust: "untrusted" as const }));
}

// ---------- /checks ----------

export interface ChecksCommandOptions {
  cwd: string;
  home: string;
  /** 本会话改过的文件 */
  changed(sessionId: string): Promise<string[]>;
  /** 这条检查命令用户是否已经确认过 */
  confirmed?(check: Check): Promise<boolean>;
  /** 没有检查时的原因 */
  unavailable?: string;
}

export function checksCommand(checks: Checks | undefined, opts: ChecksCommandOptions): PluginCommand {
  return {
    name: "checks",
    args: "[on|off]",
    description: "checks jade runs after the agent edits files (type checker, linter)",
    instant: true,
    async run(args, { sessionId }) {
      if (!checks) return dim(opts.unavailable ?? "Edit-time checks are not available.");
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        checks.enabled = arg === "on";
        if (arg === "on") checks.reset();
        return `checks: ${arg}`;
      }
      if (arg) return red("usage: /checks [on|off]");
      const files = await opts.changed(sessionId);
      const found = await checks.resolve(files);
      const lines = [`Edit-time checks are ${checks.enabled ? "on" : "off"} in this session.`];
      if (found.length > 0) {
        lines.push("For the files changed in this session:");
        for (const c of found) {
          const pending = opts.confirmed && !(await opts.confirmed(c)) ? ", not confirmed yet" : "";
          lines.push(`  ${bold(c.name)} ${dim(`in ${display(opts.cwd, c.cwd) || "."}${pending}`)}\n    ${dim(c.command)}`);
        }
      } else lines.push(dim(files.length ? "No checks apply to the files changed in this session." : "No files changed in this session yet."));
      lines.push(
        dim(
          "Detected per file: TypeScript (nearest tsconfig.json + the project's typescript), Python (ruff), Go (go vet).\n" +
            `Add your own in .jade/checks.json or ${path.join(opts.home, "checks.json")}; JADE_CHECKS=off turns them off.`,
        ),
      );
      return lines.join("\n");
    },
  };
}

// ---------- /compact ----------

export function compactCommand(compact: Compactor): PluginCommand {
  return {
    name: "compact",
    description: "compact the history before the next request",
    run() {
      compact.request();
      return dim("History will be compacted before the next request.");
    },
  };
}
