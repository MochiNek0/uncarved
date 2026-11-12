// jade/completions：输入框补全的注册表（completions@1）。前端在输入框里遇到触发字符时查这里取候选；
// 候选是什么、发送时拿它做什么归登记的插件（例如 jade/mentions 的 @ 文件）。只登记，不知道谁在用。

import { definePlugin } from "@uncarved/jade-api";
import type { Completion, Completions } from "@uncarved/jade-api/services";

const registry = new Map<string, { completion: Completion; plugin: string }>();

export default definePlugin({
  process(ctx) {
    ctx.provide("completions@1", (caller): Completions => ({
      register(completion) {
        const trigger = completion?.trigger;
        if (typeof trigger !== "string" || [...trigger].length !== 1 || /[\p{L}\p{N}\s/]/u.test(trigger)) {
          throw new Error(`invalid completion trigger ${JSON.stringify(trigger)}: use one character that is not a letter, digit, space or "/"`);
        }
        if (typeof completion.candidates !== "function") throw new Error(`completion ${trigger} has no candidates function`);
        // 重名时先登记的留下，后来的跳过并报告（同 commands@1）
        const taken = registry.get(trigger);
        if (taken) {
          ctx.report(`completion ${trigger} from ${caller.plugin} was skipped: ${taken.plugin} already registered it`);
          return () => {};
        }
        const entry = { completion, plugin: caller.plugin };
        registry.set(trigger, entry);
        const revoke = () => {
          if (registry.get(trigger) === entry) registry.delete(trigger);
        };
        caller.onDispose(revoke);
        return revoke;
      },
      list: () => [...registry.values()],
    }));
  },
});
