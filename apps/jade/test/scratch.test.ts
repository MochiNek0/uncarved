// jade/scratch：会话的临时目录，经插件宿主的端到端测试。

import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { featureHost, msg, reply, results, textOf, use } from "./feature-host.ts";

describe("scratch", () => {
  test("tells the model about a per-session scratch directory and lets auto mode write there without asking", async () => {
    const { host, state } = await featureHost({ config: { "jade/approval": { mode: "auto", review: false } } });
    let dir: string | undefined;
    try {
      const s = await host.sessions.open();
      state.script.push(reply("noted"));
      await s.send(msg("hi"));
      const line = state.requests[0]!.system.find((x) => x.text.includes("Scratch directory for this session"))!;
      expect(line.trust).toBe("trusted");
      dir = /Scratch directory for this session: (.+)/.exec(line.text)![1]!;
      expect(path.basename(dir)).toBe(s.id);

      const file = path.join(dir, "try.py");
      state.script.push({ content: [use("w", "write_file", { path: file, content: "print(1)\n" })], stopReason: "tool_use" }, reply("done"));
      await s.send(msg("try something"));
      expect(textOf(results(state.requests[2]!)[0]!.content)).toContain("Wrote");
      expect(await readFile(file, "utf8")).toBe("print(1)\n");
      expect(state.selects).toEqual([]);
    } finally {
      await host.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
