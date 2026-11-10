// shell@1：给其他插件执行命令的入口（例如 jade/checks 跑项目的检查）。
//
// 找 shell、补 Git Bash 的 PATH、杀进程树这些只有一份，在 shell.ts 里；这里只把它包成服务。
// 和 bash 工具不同，这里的命令不经过模型和审批：调用方（插件）自己决定要不要问用户。
// 没有 shell 时 executable 是 undefined，run 会抛错；调用方据此说明"在这台机器上做不了"。

import { capture, findShell, shellEnv } from "./shell.ts";
import { which } from "./sys.ts";
import type { RunCommand, RunResult, Shell } from "@uncarved/jade-api/services";

/** 默认的 shell：JADE_SHELL，否则 bash（Windows 上是 Git Bash） */
export const shellName = (configured: unknown): string => (typeof configured === "string" && configured.trim() ? configured : (process.env.JADE_SHELL ?? "bash"));

export function shellService(opts: { shell?: string } = {}): Shell {
  const name = shellName(opts.shell);
  const executable = findShell(name);
  if (!executable) {
    const hint = process.platform === "win32" ? "install Git for Windows, or set JADE_SHELL to the path of a bash executable" : "set JADE_SHELL to the path of a shell";
    const unavailable = `${name} was not found; ${hint}`;
    return {
      executable: undefined,
      unavailable,
      run: () => Promise.reject(new Error(unavailable)),
      which,
    };
  }
  const env = shellEnv(executable);
  return {
    executable,
    run: (command, o): Promise<RunResult> => capture(executable, env, command, o),
    which,
  };
}
