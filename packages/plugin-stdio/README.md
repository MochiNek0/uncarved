# @uncarved/plugin-stdio

让 [uncarved](https://www.npmjs.com/package/uncarved) 插件运行在独立进程里，可以用任何语言编写。传输协议是 JSON-RPC 2.0，经子进程的 stdin/stdout，一行一条消息。

## 安装

```sh
npm install uncarved @uncarved/plugin-stdio
```

## 用法

```ts
import { Runtime } from "uncarved";
import { spawnPlugin } from "@uncarved/plugin-stdio";

const plugin = await spawnPlugin({ command: "python", args: ["redact.py"] });
const rt = await Runtime.create({ store, provider, plugins: [plugin] });

// ……
await plugin.close();
```

`spawnPlugin` 返回一个普通的 `Plugin`，另外带 `close()` 和 `exited`（进程退出时 resolve）。进程退出后不会自动重启，是否重新启动由调用方决定。

### 选项

| 选项 | 说明 |
|---|---|
| `command`、`args`、`cwd` | 启动命令 |
| `env` | 追加到当前进程环境变量之上 |
| `layer` | 默认 `"distro"`。为 `"project"` 时必须提供 `trust`，首次启动前先确认 |
| `trust` | `{ trust, confirm, dir }`：信任存储、确认回调、需要计算内容哈希的目录 |
| `initTimeoutMs` | 等待 `initialize` 回复的时间，默认 10 秒 |
| `maxMessageBytes` | 单条消息上限，超过时结束插件进程，默认 64 MiB |
| `onStderr` | 插件的 stderr 输出，不属于协议 |

## 协议

内核 → 插件：

| 方法 | 参数 | 回复 |
|---|---|---|
| `initialize` | `{ kernel: "0.1.0" }` | 插件清单 |
| `hook` | `{ hook, sessionId, payload }` | transform：只含可写字段的对象；gate：`{ decision, reason? }`；observe：`{}` |
| `$/cancel` | `{ id }`（通知） | — |
| `shutdown` | `{}` | `{}` |

插件清单示例：

```json
{
  "id": "acme/redact", "version": "1.2.0", "kernel": "^0.1",
  "needs": ["transform:tool.after"],
  "hooks": [
    { "name": "redact", "kind": "transform", "point": "tool.after",
      "reads": ["content"], "writes": ["content"], "timeoutMs": 5000 }
  ]
}
```

插件 → 内核（只在某次 `hook` 调用进行中有效）：`log/record { call, key, value }`、`log/emit { call, type, data }`，分别需要 `log:record`、`log:emit` 能力。

完整设计见 [5.5-out-of-process-hooks.md](https://github.com/MochiNek0/uncarved/blob/main/docs/design/5.5-out-of-process-hooks.md)。

## 许可证

MIT
