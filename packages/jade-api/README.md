# @uncarved/jade-api

写 [jade](https://www.npmjs.com/package/@uncarved/jade) 插件用的类型和 `definePlugin`。没有运行时依赖。

## 安装

```sh
npm install --save-dev @uncarved/jade-api
```

只用到类型时装成开发依赖就够了。`definePlugin` 原样返回传给它的对象，只是为了让编辑器知道 `ctx` 的类型；
用了它就要把这个包写进插件 `package.json` 的 `dependencies`，`jade plugins add` 会连它一起装上。

## 用法

```ts
import { definePlugin, type UI } from "@uncarved/jade-api";

export default definePlugin({
  process(ctx) {
    const ui = ctx.require<UI>("ui@1");
    ctx.provide("notes@1", { list, add });
  },
  session(ctx) {
    ctx.kernel.tool({ name: "note_add", /* … */ });
  },
});
```

`plugin.json` 的 `api` 字段写这个包的主版本，例如 `"^1"`。

运行时用到的一切都从 `ctx` 拿，不要 import jade 本身（`@uncarved/jade`）：那会在进程里加载第二份宿主。
jade 抛给插件的错误（`PluginError`、`StaleContext`、`ServiceUnavailable`）按 `error.name` 判断。

内置插件提供的服务（`commands@1`、`prompts@1`……）的类型目前在 jade 包里各插件的目录下，还没有单独发布。
