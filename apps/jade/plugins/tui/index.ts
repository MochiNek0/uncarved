// jade/tui：终端界面，默认的前端。提供 frontend@1 和 ui@1；命令、快捷键、显示方式都来自注册表插件。

import { definePlugin } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";
import type { Compact } from "../compact/index.ts";
import type { Keys } from "../keys/index.ts";
import type { Models } from "../models/index.ts";
import type { Modes } from "../modes/index.ts";
import type { Renderers } from "../renderers/index.ts";
import type { SessionIndex } from "../sessions/index.ts";
import { ScreenBridge, tuiFrontend } from "./frontend.ts";

export default definePlugin({
  process(ctx) {
    const bridge = new ScreenBridge();
    ctx.provide("ui@1", bridge.ui);
    ctx.provide(
      "frontend@1",
      tuiFrontend(
        {
          home: ctx.home,
          cwd: ctx.cwd,
          commands: ctx.require<Commands>("commands@1"),
          keys: ctx.require<Keys>("keys@1"),
          renderers: ctx.require<Renderers>("renderers@1"),
          ...optional("modes", ctx.service<Modes>("modes@1")),
          ...optional("models", ctx.service<Models>("models@1")),
          ...optional("compact", ctx.service<Compact>("compact@1")),
          ...optional("index", ctx.service<SessionIndex>("sessions@1")),
        },
        bridge,
      ),
    );
  },
});

const optional = <K extends string, T>(k: K, v: T | undefined) => (v === undefined ? {} : ({ [k]: v } as { [P in K]: T }));
