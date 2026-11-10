// jade/plugins：/plugins 命令。列出这次启动里每个插件的状态和原因（failed、skipped、conflicted……），
// 以及每个服务由谁提供。数据来自核心自己的 jade@1 服务，和救援 CLI `jade plugins list` 是同一份状态。

import { definePlugin, type Jade } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";

export default definePlugin({
  process(ctx) {
    const commands = ctx.require<Commands>("commands@1");
    const jade = ctx.require<Jade>("jade@1");

    commands.register({
      name: "plugins",
      args: "[id]",
      description: "every plugin's state and why it is not active, and who provides each service",
      // 只读，不碰会话
      instant: true,
      run(args) {
        const all = jade.plugins();
        const query = args.trim();
        if (query) {
          const found = all.filter((p) => p.id === query || p.id?.endsWith(`/${query}`) || p.dir === query);
          if (found.length === 0) return `No plugin matches ${query}. /plugins lists them all.`;
          const lines = found.map((p) => `${p.id ?? p.dir}@${p.version ?? "?"}  ${p.layer}  ${p.state}${p.reason ? `  ${p.reason}` : ""}\n  ${p.dir}`);
          for (const s of jade.services().filter((s) => found.some((p) => p.id === s.provider))) lines.push(`  provides ${s.service}`);
          return lines.join("\n");
        }

        const lines = all.map((p) => `${p.id ?? p.dir}@${p.version ?? "?"}  ${p.layer}  ${p.state}${p.reason ? `  ${p.reason}` : ""}`);
        const broken = all.filter((p) => p.state !== "active");
        if (broken.length > 0) lines.push("", `${broken.length} of ${all.length} plugins are not active; /plugins <id> shows where one lives.`);
        const services = jade.services();
        if (services.length > 0) lines.push("", "services:", ...services.map((s) => `  ${s.service}  ${s.provider}`));
        return lines.join("\n");
      },
    });
  },
});
