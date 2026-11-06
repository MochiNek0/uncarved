// jade/prompts：指令文件进系统提示词，并告诉用户读了哪些。

import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { featureHost, msg, reply, tempDir } from "./feature-host.ts";

test("instruction files go into the system prompt and the user is told which were loaded", async () => {
  const home = await tempDir("jade-prompts-home-");
  const cwd = await tempDir("jade-prompts-cwd-");
  await writeFile(path.join(home, "AGENTS.md"), "user rule");
  await writeFile(path.join(cwd, "CLAUDE.md"), "project rule");
  const { host, state } = await featureHost({ home, cwd });
  try {
    state.script.push(reply("ok"));
    const s = await host.sessions.open();
    await s.send(msg("hi"));
    const system = state.requests[0]!.system.map((x) => x.text).join("\n");
    expect(system).toContain("user rule");
    expect(system).toContain("project rule");
    const shownHome = path.join(home, "AGENTS.md").split(path.sep).join("/");
    expect(state.notes).toContain(`loaded instructions: ${shownHome}, CLAUDE.md`);
  } finally {
    await host.close();
  }
});

test("no notice without instruction files", async () => {
  const { host, state } = await featureHost();
  try {
    await host.sessions.open();
    expect(state.notes.filter((n) => n.startsWith("loaded instructions"))).toEqual([]);
  } finally {
    await host.close();
  }
});
