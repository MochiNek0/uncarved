// prepublishOnly 检查：包之间的依赖写的是 workspace:^，只有 bun publish 会在打包时换成实际版本，
// npm publish 会原样发布，装的时候就失败
const agent = process.env.npm_config_user_agent ?? "";
if (!agent.startsWith("bun/")) {
  console.error(`publish with "bun publish": "workspace:" dependency ranges are only rewritten by bun (got ${agent || "unknown agent"})`);
  process.exit(1);
}
