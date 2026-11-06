// jade/update：启动时（每天最多一次）查 npm 上有没有更新的 jade，有就在后台升级，下次启动生效；
// 配置 auto 为 false 或 JADE_AUTO_UPDATE=off 时只提示。仓库里的开发版和 npm link 既不提示也不升级。
// 查询和升级都用核心的 src/update.ts，和 jade update 是同一套；不想要它就 jade plugins disable jade/update。

import { definePlugin, type UI } from "../../src/api.ts";
import { autoUpdate, autoUpdateEnabled, detectInstall, newerVersion, VERSION, type Install } from "../../src/update.ts";

export interface CheckOptions {
  home: string;
  auto: boolean;
  notify: (message: string, level?: "info" | "warning") => void;
  install?: Install;
  /** 测试用 */
  latest?: () => Promise<string>;
  command?: string[];
}

/** 查一次，按结果提示；出什么错都不打扰用户 */
export async function checkForUpdate(o: CheckOptions): Promise<void> {
  const install = o.install ?? detectInstall();
  if (install.kind === "dev") return;
  const latest = await newerVersion(o.home, o.latest ? { latest: o.latest } : {}).catch(() => undefined);
  if (!latest) return;
  const manual = () => o.notify(`jade ${latest} is available (you have ${VERSION}); run jade update`);
  if (!o.auto || !autoUpdateEnabled()) return manual();
  const result = await autoUpdate(o.home, latest, { install, ...(o.command ? { command: o.command } : {}) }).catch(() => undefined);
  if (result?.status === "installed") o.notify(`jade ${latest} was installed in the background; restart jade to use it`);
  else if (result?.status === "failed") o.notify(`automatic update to jade ${latest} failed (see ${result.log}); run jade update`, "warning");
  else if (result?.status !== "skipped" || result.why !== "busy") manual();
}

export default definePlugin({
  process(ctx) {
    const ui = ctx.service<UI>("ui@1");
    // 不能提问的前端（jade -p）是脚本在用，不提示也不升级
    if (!ui?.interactive) return;
    // 作用域关闭后 ui 失效，再提示会抛错：那时也没人看了
    void checkForUpdate({ home: ctx.home, auto: ctx.config.auto !== false, notify: (m, level) => ui.notify(m, level) }).catch(() => {});
  },
});
