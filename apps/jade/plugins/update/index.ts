// jade/update：启动时（每天最多一次）查 npm 上有没有更新的 jade，有就在后台升级，下次启动生效；
// 配置 auto 为 false 或 JADE_AUTO_UPDATE=off 时只提示。仓库里的开发版和 npm link 既不提示也不升级。
// 查询和升级经核心的 update@1 服务，和 jade update 是同一套；不想要它就 jade plugins disable jade/update。

import { definePlugin, type UI, type Updater } from "../../src/api.ts";

export interface CheckOptions {
  /** 核心的 update@1 */
  update: Updater;
  auto: boolean;
  notify: (message: string, level?: "info" | "warning") => void;
}

/** 查一次，按结果提示；出什么错都不打扰用户 */
export async function checkForUpdate(o: CheckOptions): Promise<void> {
  const { update } = o;
  if (update.install === "dev") return;
  const latest = await update.newer().catch(() => undefined);
  if (!latest) return;
  const manual = () => o.notify(`jade ${latest} is available (you have ${update.version}); run jade update`);
  if (!o.auto || !update.autoEnabled()) return manual();
  const result = await update.upgrade(latest).catch(() => undefined);
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
    void checkForUpdate({ update: ctx.require<Updater>("update@1"), auto: ctx.config.auto !== false, notify: (m, level) => ui.notify(m, level) }).catch(() => {});
  },
});
