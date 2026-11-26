// tsc 不会清理 outDir，旧版本残留的 .js/.d.ts 会留在 dist/ 里混进发布产物。
// build 前先删干净，保证 dist 只含当前 src 的编译结果。在包目录里运行（bun run build 的工作目录就是包目录）
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

const pkg = process.cwd();
if (!existsSync(path.join(pkg, "package.json"))) throw new Error(`clean-dist: ${pkg} is not a package directory`);
await rm(path.join(pkg, "dist"), { recursive: true, force: true });
