// jade/scratch：每个会话一个临时目录，放不属于项目的临时文件（试跑的脚本、中间结果），免得弄脏工作目录。
// 目录在系统临时目录下、按会话 id 命名，恢复会话时还是同一个；不主动删除，由系统清理临时目录。

import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePlugin } from "../../src/api.ts";
import type { Approval } from "../approval/index.ts";
import type { Prompts } from "../prompts/index.ts";

/** 会话 id 对应的临时目录 */
export const scratchDir = (session: string): string => path.join(os.tmpdir(), "jade-scratch", session);

export default definePlugin({
  async session(ctx) {
    // 恢复时的 id 来自命令行，还没经过校验；只用单级、不含路径分隔符的名字，免得目录落到 jade-scratch 外面
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(ctx.session.id)) return;
    const created = scratchDir(ctx.session.id);
    await mkdir(created, { recursive: true });
    // 提示词和审批都用真实路径：Windows 上 os.tmpdir() 可能是 8.3 短路径
    const dir = realpathSync.native(created);
    // 在里面改文件和在工作目录里一样对待；会话关闭时撤销
    ctx.service<Approval>("approval@1")?.allowWrite(dir);
    ctx.service<Prompts>("prompts@1")?.add({
      text:
        `- Scratch directory for this session: ${dir}\n` +
        "  Put temporary files there (throwaway scripts, intermediate output, files that do not belong in the project) instead of the working directory or /tmp.",
    });
  },
});
