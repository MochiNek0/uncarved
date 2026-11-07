// tsc 不会清理 outDir，旧版本残留的 .js/.d.ts 会留在 dist/ 里混进发布产物。
// build 前先删干净，保证 dist 只含当前 src 的编译结果。
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await rm(path.join(pkg, "dist"), { recursive: true, force: true });
