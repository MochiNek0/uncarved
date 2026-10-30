# @uncarved/store-jsonl

[uncarved](https://www.npmjs.com/package/uncarved) 的文件存储：每个会话一个 `.jsonl` 文件，一行一个事件。另有信任确认记录的文件存储。

## 安装

```sh
npm install uncarved @uncarved/store-jsonl
```

## 用法

```ts
import { Runtime } from "uncarved";
import { JsonlLogStore, JsonlTrustStore } from "@uncarved/store-jsonl";

const store = new JsonlLogStore(".sessions"); // 目录，不存在时自动创建

const rt = await Runtime.create({ store, provider, plugins, sessionId: "demo" });
// ……进程重启后：
const resumed = await Runtime.resume({ store, provider, plugins, sessionId: "demo" });

// 项目层插件的信任确认记录
const trust = new JsonlTrustStore(".uncarved/trust.jsonl");
```

## 保证

- **持久化**：`append` 写入后 fsync（新建文件时还会 fsync 所在目录），resolve 即代表已落盘。
- **只追加**：不提供删除，已写入的事件不会被修改。
- **崩溃安全**：崩溃可能在文件末尾留下不完整的一行。那次写入从未 resolve，读取时忽略它，下次 `append` 前截掉。中间某行损坏则抛出 `CorruptLog`，不做任何修复。
- **单写入者**：每次 `append` 持有 `<id>.jsonl.lock`（独占创建）。另一个进程或实例也在写同一个会话时抛出 `ConcurrentWrite`。持锁进程已经不在、或者锁超过 60 秒没有释放时，锁视为失效并被接管。
- **内存占用与日志长度无关**：`read` 分块读取；`append` 前检查末尾残行时只从文件末尾往前读。

## 限制

- **只支持本机文件系统。** 锁是否失效靠锁文件里的 pid 判断（`process.kill(pid, 0)`），pid 只在同一台机器、同一个 pid 命名空间里有意义。不要把存储目录放在 NFS、SMB 等网络文件系统上，也不要让不同容器（各自的 pid 命名空间）共享同一个目录：别的机器或容器上的写入者会被误判为已退出，锁被接管，单写入者的保证就失效了。
- **崩溃后 pid 被别的进程占用。** 持锁进程崩溃后，如果它的 pid 恰好分给了另一个仍在运行的进程，锁要等到超过 60 秒才会被接管，在此之前 `append` 等待 10 秒后抛出 `ConcurrentWrite`。急用时可以手动删除 `<id>.jsonl.lock`。（重启后 pid 和崩溃前相同的情况，例如容器里的 pid 1，会立即被识别为失效的锁。）
- **会话 ID 不区分大小写。** 文件名一律用小写，`abc` 和 `ABC` 在所有平台上都是同一个会话（Windows、macOS 默认的文件系统本来就不区分大小写，统一之后各平台行为一致）。Windows 的设备名（`con`、`nul`、`com1` 等）不能用作会话 ID。

## 错误

| 类 | 何时抛出 |
|---|---|
| `CorruptLog` | 日志中间某行无法解析。带 `sessionId`、`line` |
| `ConcurrentWrite` | 同一个会话有另一个写入者。带 `sessionId` |

## 许可证

MIT
