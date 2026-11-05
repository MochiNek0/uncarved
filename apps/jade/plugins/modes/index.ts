// jade/modes：权限模式的切换。模式本身归 jade/approval（approval@1），这里只提供切换方式和给前端显示的状态：
// Shift+Tab 在 ask → auto → plan 之间轮换，/mode 查看或选择，modes@1 让前端显示当前模式、在模式变化时更新。

import { definePlugin } from "../../src/api.ts";
import type { Approval } from "../approval/index.ts";
import type { Commands } from "../commands/index.ts";
import type { Keys } from "../keys/index.ts";

/** modes@1 */
export interface Modes {
  current(): string;
  list(): { name: string; description: string }[];
  /** 换模式，从下一个工具调用起生效 */
  set(mode: string): void;
  /** 换到轮换顺序里的下一个 */
  cycle(): string;
  /** 模式变化时调用，返回取消订阅的函数；调用方关闭时自动取消 */
  subscribe(fn: (mode: string) => void): () => void;
}

const DESCRIPTIONS: Record<string, string> = {
  ask: "ask before edits and commands",
  auto: "edits in this directory and harmless commands run without asking; others still ask",
  plan: "change nothing: research read-only and propose a plan",
  readonly: "change nothing",
  yolo: "never ask",
};
const CYCLE = ["ask", "auto", "plan"];

export default definePlugin({
  process(ctx) {
    const approval = ctx.require<Approval>("approval@1");
    const listeners = new Set<(mode: string) => void>();
    const set = (mode: string) => {
      if (mode === approval.mode()) return;
      approval.setMode(mode as ReturnType<Approval["mode"]>);
      for (const fn of [...listeners]) {
        try {
          fn(mode);
        } catch {
          // 订阅者的错误经过膜归它自己，不影响别的订阅者
        }
      }
    };
    const cycle = () => {
      const next = CYCLE[(CYCLE.indexOf(approval.mode()) + 1) % CYCLE.length]!;
      set(next);
      return next;
    };
    const list = () => Object.entries(DESCRIPTIONS).map(([name, description]) => ({ name, description }));

    ctx.provide("modes@1", (caller): Modes => ({
      current: () => approval.mode(),
      list,
      set,
      cycle,
      subscribe(fn) {
        listeners.add(fn);
        const off = () => void listeners.delete(fn);
        caller.onDispose(off);
        return off;
      },
    }));

    ctx.service<Keys>("keys@1")?.register({ key: "shift+tab", description: "cycle ask/auto/plan", run: () => void cycle() });
    ctx.service<Commands>("commands@1")?.register({
      name: "mode",
      args: `[${Object.keys(DESCRIPTIONS).join("|")}]`,
      description: "show or change the permission mode",
      instant: true,
      async run(args, c) {
        let want: string | undefined = args.trim() || undefined;
        if (!want) {
          want = await c.ui.select(
            { title: "Permission mode", options: list().map((m) => ({ label: m.name, value: m.name, hint: m.name === approval.mode() ? "current" : m.description })) },
            c.signal,
          );
          if (!want) return;
        }
        if (!(want in DESCRIPTIONS)) return `unknown mode ${want}; one of ${Object.keys(DESCRIPTIONS).join(", ")}`;
        set(want);
        return `mode: ${approval.mode()}`;
      },
    });
  },
});
