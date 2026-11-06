# 设计：jade

> 状态：草案；第 11 节第 1–7 步已实现（含从 npm、git 和本地目录安装/更新插件），第 8 步改名已提前完成（2026-11-05）。
>
> 范围：从零重写 jade 层（`apps/jade`）。旧 jade（0.1.3）已归档到 `.archive/jade`，下文的"旧 jade"和旧文件路径都指那里。uncarved 内核原则上不动；实现过程中发现内核缺的东西，记在第 10 节，逐项决定进不进内核。
>
> 参考：pi（earendil-works/pi，原 badlogic/pi-mono）的扩展系统；dsh（DeepSeek Harness，基于 cordis）的"万物皆插件"。

## 1. 为什么重写

旧 jade 想做"内核 + 插件"，实际做成了"内核 + 一个大宿主 + 调用宿主的插件"：

| 现象 | 例子 |
|---|---|
| 内置插件有第三方拿不到的接口 | `TurnParticipant` 只给内置插件；`jade/prompts` 由宿主单独构造并拿到全部工具；`ask_user` 的界面由宿主私下传入；`jade/task`、`jade/compact` 经 `JadeOptions.provider` 拿模型 |
| 扩展面按单个需求一个个开口 | 为 suggest 先后加了 `ctx.input.hint`、`ctx.complete({ model })`、`ctx.listModels`、自带服务配置 |
| 宿主里有 Agent 行为 | 模式管理、Shift+Tab、会话切换、命令分发都在 `main.ts`（1433 行） |
| 每加一项能力要改三处 | 内核插件、jade 扩展字段、`plugin-stdio` 协议各写一遍 |

根本原因：**宿主和插件之间的边界没有一条原则来定，每次都个案处理。**

## 2. 原则

> **核心稳定、小、不认识任何功能；一切功能都是插件；插件之间只通过声明过的服务协作；插件出错只伤到它自己。**

1. **核心不认识功能。** 核心代码里不出现任何功能的名字（fs、shell、tui、compact、审批……）。唯一的例外是核心自己要消费的少数服务契约（3.4）。
2. **没有特权接口。** 内置插件和第三方插件用同一套 API、同一个加载流程。内置插件只是"默认装上的第三方插件"。发行版可以把一个插件标成"不能被项目层代替"（第 7 节），那是信任规则，不是接口。
3. **一种协作机制：服务。** 插件提供服务、依赖服务。"往命令列表里加一条命令""加一个渲染器"都是调用另一个插件提供的注册服务，核心不设专门的贡献点。
4. **静态可知。** 不执行插件代码就能知道：插件是谁、提供什么、依赖什么、是否启用。依赖图在启动时一次性算好，运行期间不变。
5. **故障隔离由核心统一做。** 插件代码只经过核心的"膜"（5.2）被调用，出错归到具体插件，隔离那个插件，进程不退出。不靠每个调用点自觉 try/catch。
6. **进程内外同构。** 进程内插件和进程外插件走同一个膜、同一套消息形状，加新服务不需要改协议。

## 3. 分层

```
┌────────────────────────────────────────────────────────────────┐
│ 插件（全部可停用、可代替）                                           │
│  前端：tui · print · rpc        行为：fs · shell · web · prompts ·  │
│  注册表：commands · keys ·       compact · mcp · skills · task ·    │
│          renderers               memory · todo · ask · checks ·     │
│  模型：models（provider 适配）    continue · mentions · repeats ·   │
│  审批：approval                  budget · undo · modes …            │
├────────────────────────────────────────────────────────────────┤
│ jade 核心（不可代替，目标 < 2000 行）                                │
│  清单与发现 · 依赖解析 · 作用域与生命周期 · 服务注册 · 膜与故障隔离 ·    │
│  会话（uncarved Runtime 的创建、恢复、切换）· 兜底关卡 · 救援 CLI       │
├────────────────────────────────────────────────────────────────┤
│ uncarved 内核：循环、日志、hook、信任（CONSTITUTION）                  │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 核心做什么

| 职责 | 说明 |
|---|---|
| 清单与发现 | 读 `plugin.json`，不执行代码；三层来源：bundled、user（`$JADE_HOME/plugins`）、project（`.jade/plugins`） |
| 启用与筛选 | `plugins.json` 按 id 停用；安全模式；连续崩溃自动停用（5.4） |
| 依赖解析 | 由清单算出激活顺序；缺依赖的插件不激活，原因精确到缺哪个服务 |
| 作用域 | 进程级、会话级、调用级三种（第 4 节），所有注册都挂在作用域上，作用域关闭时逆序撤销 |
| 服务注册 | 一个服务名只有一个提供者；冲突在激活前按规则裁决（3.3） |
| 膜 | 所有跨插件调用经过它：归属、超时、取消、过期检查、错误隔离 |
| 会话 | 创建、恢复、切换 uncarved `Runtime`，作为一个事务（4.2） |
| 兜底关卡 | `approval@1` 的提供者没有在会话里注册 `tool.gate` 时，拒绝非只读工具（第 7 节） |
| 救援 CLI | `jade plugins list|add|remove|enable|disable`、`jade --safe`：都不执行第三方插件代码 |

### 3.2 核心不做什么

界面、按键、斜杠命令、渲染、提示词、工具、模型配置、模式、审批对话框、压缩、MCP……一律是插件。核心没有任何默认界面：前端插件起不来时，核心打印诊断并提示 `jade --safe` 或 `jade plugins disable <id>`，然后退出。

### 3.3 服务

服务是一个有名字、有大版本的接口：`commands@1`、`ui@1`、`provider@1`。

```jsonc
// plugin.json
{
  "id": "jade/commands",
  "version": "1.0.0",
  "api": "^1",                       // jade 插件 API 的版本范围
  "entry": "./index.ts",
  "provides": ["commands@1"],
  "requires": ["ui@1"],
  "optional": ["keys@1"]
}
```

规则：

- **一个服务名同一时间只有一个提供者。** 多个插件提供同一服务时，按下面的顺序裁决，裁决发生在激活之前，结果写进诊断：
  1. 声明了 `"replaces": ["<id>"]` 的插件胜过被它代替的插件；
  2. 否则层级高的胜（project > user > bundled），**但项目层不能代替用户层或 bundled 的提供者**（第 7 节）；
  3. 同层冲突：两个都不激活，报错，要求用户停用其中一个。不按发现顺序悄悄选一个。
- **依赖是静态的。** `requires` 缺任何一项，插件不激活；`optional` 缺了照样激活，`ctx.service(name)` 返回 `undefined`。
- **激活顺序**：提供者先于依赖它的插件。`optional` 的依赖是软的：只由 `requires` 组成的环才算成环（环上的插件都不激活）；经过 `optional` 的环在那里断开，那个插件先激活，它在 `process()` 里取那项可选服务得到 `undefined`，`session()` 里和之后的调用里能拿到。例如 `jade/approval` 可选用 `ui@1`，`jade/tui` 可选用 `modes@1`，`jade/modes` 必需 `approval@1`：approval 先激活。所以可选服务要在用到的时候取，不要在 `process()` 里取了存起来。
- **不做运行期热替换。** 和 cordis 不同，服务出现、消失不会重新激活依赖它的插件。提供者故障被隔离时，它的服务变成"已失效"：调用会抛 `ServiceUnavailable`，调用方自己决定怎么办。依赖它的插件不会被连带停掉。这样一个插件坏掉不会顺着依赖图把一串插件拖进不确定状态。
- **服务的形状由提供它的那一方定义**，类型发布在提供者的包里（或者 jade 的公共类型包里，见 3.5）。核心不检查方法签名，只负责名字、版本、提供者和膜。
- **提供者知道调用方是谁。** `ctx.provide(name, (caller) => impl)` 为每个调用方作用域创建一个实例。`caller` 带调用方的 id、signal 和 `onDispose`。注册表在 `onDispose` 里撤销调用方注册的东西，因此调用方关闭、激活失败或被隔离时，它在别的插件里的注册会自动撤销，调用方自己什么都不用记。撤销由提供者负责，因为调用方不知道注册表返回的东西哪个是撤销函数。所有调用方共用一个实例的服务，直接传对象。

### 3.4 核心消费的服务契约

核心自己要用的服务只有这几个，契约写在 jade 的 API 包里：

| 服务 | 核心用它做什么 | 默认提供者 |
|---|---|---|
| `frontend@1` | 启动后把控制权交给它：`run({ argv, sessions, signal })` | `jade/tui`（`-p` 时 `jade/print`） |
| `provider@1` | 新建或恢复会话时取一个 uncarved `Provider` | `jade/models` |
| `store@1`（可选） | 会话日志存储；没有提供者时用核心自带的 jsonl | — |
| `jade@1` | 核心自己提供（不是插件）：每个插件的状态和原因、服务的提供者。`/plugins` 用它；插件可以在 `requires` 里写，但没有插件能提供它 | 核心 |

`jade@1` 是唯一由核心提供、给插件用的服务：核心知道自己加载了哪些插件，第三方插件拿不到这份信息，而"哪个插件坏了、为什么"是用户该看到的。它只读，没有副作用。

前端的选择：清单里 `"frontend": { "name": "tui", "default": true }` 或 `{ "name": "print", "flag": "-p" }`。核心按命令行选定一个前端，只激活被选中的那个前端插件提供的 `frontend@1`。

`frontend@1` 和 `ui@1` 的形状由 jade 定义（`api.ts` 的 `Frontend`、`UI`），因为每个前端都要提供它们、很多插件都要用 `ui@1`：

- `Frontend.run({ argv, sessions, signal })` 返回退出码。`argv` 是核心去掉自己的参数（`plugins`、`--safe`）之后的命令行，`sessions` 是核心的会话管理器（`SessionManager`：`open`、`close`、`current`）。
- `UI`：`interactive`、`notify(message, level)`、`select({ title, detail, options }, signal)`、`input({ title, initial, placeholder, mask }, signal)`。不能提问的前端（`jade/print`）`interactive` 为 false，`select`、`input` 总是返回 `undefined`。
- `UI.session({ session, plugin })`（可选）：一个插件在一个会话里的界面——状态栏上它的一段（`status(text)`，一行，undefined 去掉）和输入框（`draft`：读、插入、整段替换、灰色提示）。核心为每个加入会话的插件调用一次，插件的作用域关闭时调用返回值的 `dispose()` 收掉它的段落。前端没有这些东西时返回 `undefined`，插件的 `ctx.status`、`ctx.input` 也就是 `undefined`。`jade/tui` 提供它；`jade/print` 没有。
- `Session.history()` 返回会话日志里的全部事件：前端恢复会话时用它重新显示对话（日志存储归核心，前端拿不到）。

命令行入口（`src/main.ts`）只做：处理 `jade plugins …`、`--safe`、`--version`；把以 `-` 开头的参数作为选前端的开关；项目层插件存在且在终端里运行时提供确认方式（记录在 `$JADE_HOME/state/trust.json`）；前端起来之前的消息打到 stderr，之后交给 `ui@1`；连续两次 Ctrl+C 直接退出。

### 3.5 插件 API 包

- 新包 `@uncarved/jade-api`：只有类型和 `definePlugin`，没有运行时依赖。（第 1–3 步先放在 `apps/jade/src/api.ts`，第 4 步出现第一个仓库外插件之前拆成独立的包。）插件 `api` 字段按 `^` 规则匹配，不接受 `>=` 这类开放范围（dsh 的 `engines.dsh: ">=0.2.0"` 永远拒绝不了未来的破坏性版本）。
- 插件运行时用到的一切都从 `ctx` 拿，不从宿主的包里 import 值，避免两份模块副本造成单例错乱（pi #4748、#8620）。
- 各插件提供的服务类型由提供者自己导出，例如 `@uncarved/jade-tui` 导出 `UI`。

## 4. 作用域与生命周期

### 4.1 三个作用域

```
进程级   ├─────────────────────────────── jade 进程 ───────────────────────────────┤
         plugin.process(ctx)：提供进程级服务、注册命令/渲染器、启动进程外插件的进程
会话级        ├── 会话 A ──┤├── 会话 B ──┤├── 会话 B（reload）──┤
         plugin.session(ctx)：工具、内核 hook、会话里的状态
调用级          ├┤ ├──┤  ├┤
         一次服务调用、一次 hook、一次命令：signal = 用户取消 ∪ 所属作用域关闭
```

插件模块：

```ts
import { definePlugin } from "@uncarved/jade-api";

export default definePlugin({
  process(ctx) {                       // 可选
    const commands = ctx.require<Commands>("commands@1");
    ctx.provide("notes@1", { list, add });
    commands.register({ name: "notes", run: async (args, c) => { /* ... */ } });   // 自动随作用域撤销
  },
  session(ctx) {                       // 可选
    ctx.kernel.tool({ name: "note_add", /* ... */ });
    ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => { /* ... */ } });
  },
});
```

规则（吸取 pi 的教训）：

- `process` / `session` 函数**只做注册**。需要后台资源（定时器、子进程、socket）的，用 `ctx.effect(start)`：`start` 返回清理函数，作用域关闭时逆序执行。
- 函数是**事务性**的：中途抛错，已经做的注册全部撤销，插件记为失败。不会留下注册了一半的插件（pi 的 commit/discard）。
- 作用域关闭后，旧 `ctx` 和从它拿到的服务句柄都**过期**：再调用会抛 `StaleContext`，错误信息说明是哪个插件、哪个作用域。过期调用也经过膜，所以只会伤到调用者自己。
- 每个插件在一个会话里的内核部分（`ctx.kernel.tool/hook`）被收集成一个 uncarved `Plugin`，id 和版本就是插件清单里的 id 和版本。这样内核的插件清单（4.6 恢复检查）和 jade 的插件一一对应。

### 4.2 换会话是一个事务

沿用 `jade-plugin-lifecycle.md` 的设计，挪进核心：

```
preparing ──commit──▶ active ──close──▶ closing ──▶ closed
    └──rollback──▶ closed
```

`sessions.open / resume / switch` 都走同一条路径：新作用域在 `preparing` 里激活全部插件的 `session`、建好 Runtime，成功才 commit 并关闭旧作用域；任何一步失败就回滚新作用域，旧作用域不受影响。

发起换会话的那次调用（例如 `/resume` 命令）的 signal 不随旧作用域关闭而中止；换会话之后它不能再用旧 ctx（会抛 `StaleContext`，而不是悄悄运行旧代码）。

### 4.3 轮次结束之后

pi 后来才补上"agent 停下来之后再执行"和延迟 reload。jade 从一开始就在核心的会话 API 里提供：

- `session.afterTurn(fn)`：本轮完全结束（`turn.ended` 已落盘、没有在途工具）后执行一次。续写、溢出重试、建议提示都用它，不再需要旧 jade 只给内置插件的 `TurnParticipant`。
- 插件想发起新一轮：`session.send(input)`。如果当前正在跑，排到本轮之后。用户层插件才能用；项目层插件不能替用户说话（第 7 节）。
- 会话里的界面：`ctx.status(text)` 在状态栏上占一段，`ctx.input` 改输入框（读、插入、整段替换、灰色提示）。两者来自前端 `ui@1.session`（3.4），每个插件一份，作用域关闭时自动收掉；前端不提供时都是 `undefined`。

## 5. 膜与故障隔离

### 5.1 dsh 为什么经常因为插件出问题

调研结论（详见附录 A）：

1. 插件的定时器、流回调里没接住的异常会让整个进程退出；
2. 依赖全有或全无，一个可选插件失败会让必需插件一直等着，启动直接失败；
3. 插件在界面起来之前加载，坏插件让用户连卸载它的界面都进不去；
4. 事件监听器出错默认往上抛，只有少数调用点自己加了隔离；
5. 配置补丁整行覆盖，后加载的悄悄冲掉前面的；
6. 两百多个内部包直接暴露给插件，版本漂移严重。

jade 对每一条的回答：5.2–5.4、3.3、3.5、第 6 节。

### 5.2 膜

插件之间、插件和核心之间的每一次调用都经过膜：

```
调用方插件 ──▶ 膜 ──▶ 被调用插件的函数
               │ 1. 检查作用域是否过期
               │ 2. 在 AsyncLocalStorage 里标记"当前执行的是插件 X"
               │ 3. 派生 signal（调用者的 ∪ 作用域的）
               │ 4. 超时（服务可声明，默认不限，由 signal 取消）
               │ 5. 异常包成 PluginError { plugin: X, service, method }
               ▼
```

- **函数参数也过膜。** 插件 A 把回调传给插件 B 的注册服务时（例如 `commands.register({ run })`），膜把 `run` 包成"属于 A 的函数"。B 调用它时，出错归 A、A 的作用域关闭后它自动失效。所以注册表服务不需要自己写隔离代码。
- 包装只深入普通对象和数组，不碰 class 实例。
- 进程外插件用同一个膜，函数变成句柄 `{ "$fn": id }`，反向调用（第 6 节）。

### 5.3 进程不因插件退出

- 核心安装 `uncaughtException` / `unhandledRejection` 处理器，按顺序找错误的归属：
  1. AsyncLocalStorage 里标记的插件。实测 node 下定时器和 Promise 都能拿到；bun 下只有定时器能拿到，Promise rejection 拿不到；两边的 `queueMicrotask` 都拿不到。所以只靠它不够。
  2. 错误栈里第一个落在某个插件目录下的帧。核心知道每个插件的目录，插件自己的代码和它 `node_modules` 里的依赖都算。
  3. 都找不到：记为"未归属"，写进 `faults.json` 并提示用户，**进程不退出**。归不到插件的错误不一定是核心的 bug（例如 Node 内部抛出、没有栈帧的 fs 错误），因此退出会重蹈 dsh 的覆辙。核心的 bug 靠测试发现。
- **能归到插件**的，隔离这个插件，进程继续。
- "隔离"指：关闭这个插件的全部作用域（逆序撤销它的注册），它提供的服务变成已失效，界面上提示一次。它在当前会话里的内核 hook 也随之撤销，但内核的 gate 和日志规则不变：撤销的是"这个插件"，审批的拒绝优先不受影响。
- 内核 hook 的出错规则保持宪法的规定：transform、observe 出错按内核规则处理，gate 出错按拒绝处理。

### 5.4 救援

- **启动顺序**：核心先完成清单解析和依赖计算，再激活插件。任何一个第三方插件失败都不阻止其他插件和前端激活。
- **安全模式** `jade --safe`：只加载 bundled 插件。救援 CLI 不执行任何插件代码，直接读写 `plugins.json`。
- **安装与更新**：`jade plugins add <来源>` 支持本地目录、npm 包（`name@版本`、`@scope/name`、`npm:<spec>`、`.tgz`）和 git 仓库（`https://…`、`git@…`、`github:user/repo`、`user/repo`，可带 `#分支/tag/提交`）。`--project` 装进 `<仓库>/.jade/plugins` 并把内容哈希记入信任存储，`--path <子目录>` 用于一个大仓库里的某个插件，`--link` 把本地目录链接进来（开发插件用），`--force` 替换同 id 的插件。`jade plugins update [id…]` 按插件目录里的 `.installed.json` 重新下载：git 比提交，npm 比版本，本地目录比内容哈希。记录里存着安装时的内容哈希，装好之后手动改过的插件默认不会被覆盖，要加 `--force`。下载先落在 `.staging-*`，检查清单、装好依赖之后再原子替换，失败不会留下装了一半的插件。
- **安装不执行插件的代码**：git 只 clone；npm 包和依赖都用 `--ignore-scripts` 安装；本地目录只复制。`jade plugins remove <id>` 删掉插件目录和安装记录。安装会清掉它的停用和连续崩溃记录；更新只清崩溃记录，保留用户显式停用。
- **升级 jade 本身**：`jade update [--check]` 查 npm 上 `@uncarved/jade` 的最新版本，按 jade 的安装方式（npm、bun、pnpm、yarn 全局安装）升级；仓库里的开发版和 `npm link` 不升级，提示用 git。它和 `jade plugins` 一样不启动插件宿主，插件坏了也能升级（`src/update.ts`）。启动时的检查和后台升级在 `jade/update` 插件里，用的是同一份代码。
- **连续崩溃自动停用**：一个插件在连续 3 次启动中都在激活阶段失败或被隔离，核心自动停用它，下次启动时告诉用户，`jade plugins enable <id>` 恢复。记录在 `$JADE_HOME/state/faults.json`。
- **诊断**：`jade plugins list` 列出启动计划里每个插件的状态（active / disabled / skipped / conflict 等）、安装来源、服务冲突的裁决结果和缺依赖的原因；它不激活插件，所以激活阶段的失败和运行期状态要看会话里的 `/plugins`（`jade@1`）。缺依赖或成环而没加载的插件，启动时也会提示一行（例如停用 `jade/shell` 之后的 `jade/checks`）；没选中的前端、以及只因为它缺依赖的插件，是意料之中的，不提示。

## 6. 进程外插件

和 pi 不同（pi 不支持进程外扩展），也和 dsh 不同（dsh 的进程边界只在协议端点），jade 把进程外插件作为一等公民：

- 清单里 `"runtime": { "command": "python", "args": ["main.py"] }` 代替 `entry`。其余字段（provides、requires、frontend……）完全一样。插件进程的工作目录是插件目录（所以 `args` 可以写相对路径），jade 的工作目录、`$JADE_HOME`、插件配置在 `scope/open` 里给。
- 实现：核心的桥（`src/remote.ts`）启动插件进程，把它包成一个普通的 `PluginModule`。核心的其余部分不知道插件在进程外：服务裁决、作用域、膜、隔离都一样。
- 协议：JSON-RPC 2.0，一行一条（`src/rpc.ts`，按 LF 切分，不用 Node 的 `readline`：它会在 U+2028/2029 处切开）。stdout 只传协议消息，stderr 的每一行转告用户。
- 方法只有通用的几个，**和具体服务无关**：
  | 方向 | 方法 | 用途 |
  |---|---|---|
  | 宿主 → 插件 | `initialize` | `{ plugin, version, api }` → `{ id?, session? }`：核对 id；`session` 为 false 时不为它打开会话作用域。10 秒内不回复算激活失败 |
  | 宿主 → 插件 | `scope/open`、`scope/close` | `{ scope, kind: "process" \| "session", cwd, home, config, session? }`，对应 `process(ctx)`、`session(ctx)` 和关闭。`scope/open` 回复之前插件发来的注册才算数 |
  | 宿主 → 插件 | 通知 `caller/open`、`caller/close` | 按调用方提供的服务：新调用方出现、调用方关闭（插件在这里撤销它的注册） |
  | 双向 | `call` | `{ scope, target, method?, args, caller? }`。`target` 是服务名、`"$session"`（`send`、`afterTurn`）或函数句柄 |
  | 双向 | `$/cancel` | 取消一次调用（宿主在工具被中止、hook 超时时发） |
  | 插件 → 宿主 | `provide`、`kernel/tool`、`kernel/hook` | 注册：`provide` 列出方法名，`perCaller` 为 true 时按调用方创建实例；工具的 `execute`、hook 的 `fn` 是函数句柄 |
  | 插件 → 宿主 | `secrets/get`、`secrets/set` | 读写这个插件自己的密钥（第 8 节）：`{ scope, key, value? }`，`value` 为 null 时删除；宿主按插件 id 取，参数里没有插件 id |
- 值里的函数表示成句柄 `{ "$fn": id }`，对方用 `call` 调用。句柄属于一个作用域，作用域关闭后失效。函数参数照样过膜：插件交给注册表的回调归插件，出错归它，插件关闭后失效。
- 加一个新服务不需要改协议：只要它的方法参数和返回值能 JSON 序列化（函数用句柄表示）就能跨进程用。不能序列化的服务（例如要传 React 组件的 TUI 扩展）在清单里标 `"local": true`，进程外插件依赖它时直接报不兼容。（`local` 还没实现，等 `jade/tui` 出现时一起做。）
- 内核 hook 用 uncarved 的 `RemoteHookSpec`：插件声明 `reads`、`writes`、`timeoutMs`，字段裁剪、回复检查、超时都由内核保证。`ctx.kernel.hook` 因此也接受 `RemoteHookSpec`。
- 进程退出：插件记为隔离（它的注册全部撤销，服务变成已失效），核心不自动重启（同崩溃自动停用规则）。宿主关闭插件时先发 `scope/close`，再关 stdin，2 秒后还没退出就结束进程。
- 项目层的进程外插件暂不加载：内核的确认只能检查 JS 的 import，管不住另一种语言的代码从目录外加载什么（第 10 节）。
- Python SDK：`sdk/python/jade_plugin.py`，单文件、只用标准库。jade 启动插件进程时把它的目录加进 `PYTHONPATH`。每个请求在自己的线程里处理，处理函数里可以同步调用宿主的服务。

## 7. 信任与审批

审批是普通插件 `jade/approval`：它注册 `tool.gate`，并通过 `ui@1` 弹审批对话框。不需要任何特权，安全性靠三条规则：

1. **拒绝优先**（宪法 I-7）：其他插件的 gate 只能让审批更严，不能推翻拒绝。
2. **兜底关卡**：`approval@1` 的提供者（不能是项目层插件）没有在会话里注册仍然有效的 `tool.gate` 时，核心拒绝所有 `effect` 不是 `read` 的工具调用。审批插件坏掉、被停用、被隔离，结果是"什么都改不了"，而不是"什么都放行"。（uncarved 在所有 gate 弃权时放行，这条由 jade 核心补上。）只认审批服务的提供者，是因为别的插件也会注册 gate（例如 `jade/repeats` 拒绝重复调用），它们平时弃权；若按"有任何 gate"判断，审批插件停用后兜底关卡就失效了。
3. **层级**：
   - 项目层插件加载前要用户确认（沿用内核的信任机制，经 `importProjectModule`）。确认方式由启动核心的入口经 `HostOptions.trust` 传入；没有确认方式时（例如非交互运行）不加载带代码的项目层插件。用户拒绝记为 `untrusted`，不计入连续崩溃；
   - 项目层不能代替用户层或 bundled 的服务提供者（3.3），所以克隆的仓库换不掉你的审批、你的模型配置、你的前端；
   - 项目层插件不能调用 `session.send`、不能改输入框：克隆仓库不等于授权它替你操作。

中断和退出（Ctrl+C）由前端插件实现，但核心兜底：连续两次 SIGINT 在 2 秒内到达时，核心直接中止所有会话并退出，不经过任何插件。插件出问题时用户一定能停下来。

## 8. 配置与密钥

- 每个插件有自己的配置段。`plugin.json` 的 `config` 列出键：`{ "mode": { "default": "ask", "description": "…", "project": false } }`。配置**按插件、按键合并**：清单里的默认值 < 用户 `$JADE_HOME/config.json` < 项目 `.jade/config.json`，两个文件都是 `{ "<插件 id>": { "<键>": 值 } }`。不整段覆盖。插件从 `ctx.config` 读，进程运行期间不变。
- 项目层的文件只能设置项目层插件的键，和清单里标了 `"project": true` 的键；其余的忽略并告诉用户一次。所以克隆的仓库改不了你的审批模式。
- 暂不做 JSON Schema 校验，插件自己检查值（例如 `jade/approval` 遇到不认识的模式时提示并用 `ask`）。
- 密钥：`ctx.secrets.get/set`（`set(key, undefined)` 删除），按插件 id 分隔存储在 `$JADE_HOME/state/secrets/<id>.json`（id 里的 `/` 编码成 `%2F`），文件 0600（POSIX 上有效）；插件只能读写自己的。这是 API 层的隔离，进程内插件仍能直接读文件，真正的沙箱不在这层。值不放进配置文件，也不通过环境变量传给进程外插件：进程外插件用 `secrets/get`、`secrets/set` 读写同一份，宿主按插件 id 取，参数里没有插件 id。`jade/models` 目前仍沿用旧 jade 的 `$JADE_HOME/.env`（shell 里的环境变量优先），`/model` 写这个文件，用过的模型记在 `models.json`；迁移到 `ctx.secrets` 另做。

## 9. 现有功能的去向

所有内置功能都是 `apps/jade/plugins/` 下的普通插件，用和第三方完全相同的方式加载。

| 插件 | 提供 | 依赖 | 来自旧 jade |
|---|---|---|---|
| `jade/tui` | `frontend@1`（默认）、`ui@1`（含 `session`：状态栏段落、输入框）；启动参数 `--resume <id>`、`-c/--continue`；`@` 路径补全 | `commands@1`、`keys@1`、`renderers@1`；可选 `modes@1`、`models@1` | `ui/*`、`main.ts` 的界面部分（`frontend.ts`）。`tui@1`（local）等第一个要扩展界面的插件出现时再做 |
| `jade/print` | `frontend@1`（`-p`）、`ui@1` | — | `-p` 模式 |
| `jade/commands` | `commands@1`：`register`、`get`、`list`。只登记不执行，前端带着 `{ signal, ui, sessions, print }` 调用 `run` | — | 插件命令（`PluginCommand`）。自定义命令（Markdown 文件）以后由单独的插件注册进来 |
| `jade/keys` | `keys@1`：`register`、`get`、`list`；`shift+tab` 也可以注册 | — | 快捷键 |
| `jade/renderers` | `renderers@1`：`tool`、`event`、`forTool`、`forEvent` | — | `ToolRenderer`、`EventRenderer`。`jade/fs`、`jade/shell` 为自己的工具登记，`jade/approval` 用工具的 `preview` 作审批对话框的内容 |
| `jade/models` | `provider@1`、`models@1`（`current`、`complete`、`list`、`subscribe`）；`/model`：切换保存过的模型、改当前模型的设置、加一个模型；用过的模型记在 `$JADE_HOME/models.json` | 可选 `ui@1`、`commands@1` | `provider.ts`、`ui/configure.ts` |
| `jade/approval` | `approval@1`（`mode`、`setMode`、`allowRead`：登记不用问就能读的目录，项目层插件不能用）、gate；auto 模式下判断不了的调用先由模型审查（`review.ts`） | `ui@1`、`models@1`（都可选：没有 `ui@1` 时，要问的调用一律拒绝；没有 `models@1` 或 `review: false` 时不审查） | `plugins/policy.ts`、`plugins/review.ts` |
| `jade/modes` | `modes@1`（`current`、`set`、`cycle`、`subscribe`），Shift+Tab、`/mode`；计划模式：往系统提示词里加"先给计划"的段落，一轮正常结束、模型给出计划后问"执行这个计划？"，批准了就换模式并替用户发一句"开始做" | `approval@1`；可选 `keys@1`、`commands@1`、`prompts@1`、`ui@1` | Shift+Tab、`/mode`、计划模式的批准流程（`test/modes.test.ts`） |
| `jade/plugins` | `/plugins [id]`：每个插件的状态和原因、每个服务的提供者（来自核心的 `jade@1`） | `commands@1`、`jade@1` | — |
| `jade/sessions` | 命令 `/clear` `/resume` `/retry`；会话索引 `$JADE_HOME/state/sessions.jsonl` | `commands@1` | `plugins/sessions.ts`、`session-lifecycle.ts` |
| `jade/prompts` | `prompts@1`（其他插件往系统提示词里加段落；项目层插件加的、或标了 `untrusted` 的段落为不可信） | `models@1`（可选，写上当前模型） | `plugins/prompts.ts` |
| `jade/fs`、`jade/shell` | 工具；shell 还提供 `shell@1`（`executable`、`unavailable`、`run(command, { cwd, timeoutMs, signal })`、`which`）：其他插件执行命令的入口，找 shell、补 Git Bash 的 PATH、连子进程一起杀只有这一份 | `renderers@1`、`prompts@1`（可选）；fs 可选 `task@1`（把只读工具另建一套给子 Agent） | `tools/*` |
| `jade/web` | `web_fetch`、`web_search`、`/search`；只读工具另建一套经 `task@1` 给子 Agent（`web_search` 只在配置了搜索服务时给） | 可选 `ui@1`、`prompts@1`、`commands@1`、`renderers@1`、`task@1` | `tools/web.ts` |
| `jade/screenshot` | `screenshot` 工具：用本机的 Chrome / Edge / Chromium 无头模式渲染本地文件或网页，把截图交给模型看（`JADE_BROWSER` 可以指定浏览器；没有浏览器时不注册；模型不能看图片时说明原因） | 可选 `renderers@1`、`prompts@1`、`models@1` | `tools/screenshot.ts`（`test/screenshot.test.ts`） |
| `jade/todo`、`jade/ask` | 工具 | `ask` 需要 `ui@1`，不能提问时不注册工具 | `tools/todo.ts`、`tools/ask.ts` |
| `jade/task` | `task` 工具、`task@1`（`tool(tool, { when })`：其他插件给子 Agent 登记只读工具，`when` 每次启动子 Agent 时决定给不给） | `models@1` | `tools/task.ts`。子 Agent 是嵌套的 `Runtime`，日志在内存里，不关联到父会话 |
| `jade/compact` | `context.project` 里清理旧输出、总结；`/compact`；上下文溢出后压缩并经 `afterTurn` 重试 | `models@1` | `plugins/compact.ts` |
| `jade/mcp` | MCP 服务的工具、`/mcp`；项目层服务启动前确认（`$JADE_HOME/trust.jsonl`） | 可选 `ui@1`、`commands@1`、`prompts@1`、`task@1` | `mcp.ts`。插件自带的 MCP 配置（旧的 PluginBundle）没有了 |
| `jade/skills` | `skill` 工具、`/skills`、`/<skill 名>`；skill 目录经 `approval@1.allowRead` 可直接读 | 可选 | `skills.ts` |
| `jade/checks` | 改文件后在 `context.project` 里跑项目检查、`/checks`；命令第一次运行前确认 | `shell@1`（运行检查）；可选 `ui@1`、`approval@1`、`renderers@1`、`commands@1` | `plugins/checks.ts` |
| `jade/memory`、`jade/undo` | `memory` 工具和 `/memory`；`/undo`（`tool.before`/`tool.after` 记快照） | 可选 | `memory.ts`、`tools/checkpoint.ts` |
| `jade/mentions` | 在 `context.project` 里把 `@` 引用的文件附到那条用户消息上 | — | `mentions.ts`。附上的内容不算 `read_file` 读过 |
| `jade/continue`、`jade/repeats`、`jade/budget` | 截断后续写（`afterTurn`）；重复调用；每轮步数上限 | — | `plugins/turns.ts`、`repeats.ts`、`budget.ts` |
| `jade/update` | 启动时查 npm 上有没有更新的 jade（每天最多一次，缓存在 `$JADE_HOME/update-check.json`），有就在后台升级、下次启动生效；配置 `auto: false` 或 `JADE_AUTO_UPDATE=off` 时只提示，`JADE_UPDATE_CHECK=off` 不查。开发版和不能提问的前端（`-p`）既不提示也不升级 | 可选 `ui@1` | `update.ts` 的 `checkForUpdate`（`test/update.test.ts`） |

几条值得注意的变化：

- `jade/prompts` 不再由宿主"单独构造并拿到全部工具"：它在 `context.build` 里本来就能看到请求里的工具，提示词里提到某个工具的条目只在请求里有这个工具时保留。环境信息里不再写各工具插件的细节（shell 是哪个、有没有 web 工具），那些由工具插件经 `prompts@1` 自己加。
- `jade/fs` 去掉了检查点（撤销以后由 `jade/undo` 提供）。所以恢复的会话里，改已有文件之前要重新读一遍。
- 审批的"总是允许"规则记在日志里（`derived`），恢复会话后仍有效；模式是进程级的，来自配置，`jade/modes` 经 `approval@1` 改；用户选的 ask/auto/readonly 记在 `$JADE_HOME/mode.json`，下次启动的第一个可交互会话里恢复（比配置优先；plan、yolo 不记，`jade -p` 这类不能问用户的运行不恢复）。auto 模式下，规则判断不了、本来要问用户的调用先让模型审一次（`plugins/approval/review.ts`，`test/review.test.ts`）：审查只能放行或转给用户，出错、超时、回答看不懂时也转给用户；带 URL 的只读工具审查放行后，本会话里完全相同的调用不再审查（不按主机记：同一主机上换个路径或查询参数就能把数据带出去）。审查的模型调用经 `models@1`，用量经 `reviewed` 事件计入会话。
- `ask_user` 的对话框经 `ui@1`，不再由宿主私下传入。
- `jade/task`、`jade/compact` 经 `models@1` 调模型，不再由宿主传 provider。
- 续写、溢出重试经 `session.afterTurn`，不再需要只给内置插件的 `TurnParticipant`。
- 模式管理整个在 `jade/modes`，前端只显示 `modes@1` 给出的状态。计划模式的说明经 `prompts@1` 加段落（`stable: false`），切出计划模式时去掉；"执行这个计划？"在 `turn.ended` 的 observe 里登记 `afterTurn` 再问（会话空闲时登记会立刻执行）。插件看不到前端排队的输入，所以用户已经在输入框里排了别的消息时也会问——这是第 11 节记的缺口之一。

## 10. uncarved 可能缺的

实现中逐项确认，每项都要过宪法第 1 章第 3 条（三个发行版都需要、内核外做不对）：

| 项 | 现状 | 倾向 |
|---|---|---|
| 会话中途换模型 | `Runtime` 创建时固定 provider | **已解决，不改内核**：`jade/models` 给核心的 `provider@1` 是一个转发到"当前 provider"的壳，`/model` 换掉里面的实现，下一次请求就用新的。配置建不起 provider 时留着旧的（状态栏和请求都还是旧的） |
| 无 gate 时默认放行 | 内核规定 | **已解决，不改内核**：jade 核心交给内核一个 `jade/core` 插件，带兜底 gate（第 7 节） |
| 轮次结束后的调度 | 宿主自己在 `send` resolve 后处理 | **已解决，不改内核**：jade 的会话把输入排队，每轮之后执行 `afterTurn` |
| 插件在会话中途被隔离 | 内核插件清单在创建时确定 | **已解决，不改内核**：jade 交给内核的 hook 和工具外面包了一层，插件被隔离后 gate 弃权、transform 不改、observe 不做事，工具返回错误。审批插件被隔离时兜底 gate 生效，所以弃权不会放行写操作 |
| 重名工具、不合法的 hook 让整个会话打不开 | `Runtime` 构造时抛错 | **已解决，不改内核**：jade 在插件加入会话时先检查，只排除这一个插件 |
| 项目层的进程外插件 | 内核的确认（哈希整个目录、检查 import 不出目录）只懂 JS | **暂不支持**：项目层的进程外插件激活失败并说明原因。要支持，得先决定"确认一个 Python 插件"确认的是什么（目录哈希够不够、解释器和它的依赖算不算） |
| 项目层插件的确认 | 内核的 `checkImports`（检查插件不 import 目录外的代码）没有导出；`loadProjectPluginFactory` 要求默认导出内核插件，和 jade 的模块形状不同 | **已解决，内核新增 `importProjectModule`**：确认流程和 `loadProjectPluginFactory` 完全相同（后者改为调用它），但不管模块形状，返回模块和一个可多次使用的 `mark(plugin)`。jade 每个会话用它标记交给内核的插件。安全检查只有内核这一份 |

## 11. 实施顺序

每一步都有可验证的结果：

1. **核心：插件系统**。清单、依赖解析、服务裁决、作用域、膜、故障隔离、诊断、救援 CLI。
   验证：单元测试覆盖冲突裁决、缺依赖、事务性激活、过期 ctx、回调归属、定时器异常隔离、连续崩溃自动停用。
2. **核心：会话**。Runtime 的创建、恢复、切换事务，兜底 gate，`afterTurn`。
   验证：用假 provider 的端到端测试；审批插件缺失时写工具被拒绝。
3. **最小可用发行版**：`jade/print`、`jade/models`、`jade/prompts`、`jade/fs`、`jade/shell`、`jade/approval`。
   验证：`jade -p "..."` 能读写文件。已完成：`test/distro.test.ts` 用按脚本回复的用户层模型插件真实运行 `bin/jade.js -p`；也用真实模型在 Node 下跑通了先读后写。
4. **项目层插件的确认**（见第 10 节最后一项）。
   验证：未确认的项目层插件不执行任何代码；确认后内容变化需要重新确认；import 目录外的文件被拒绝。
5. **进程外插件**：协议和桥。
   验证：Python 写的插件提供一个服务，并注册一条命令。已完成：`test/remote.test.ts` 用 Python 插件提供服务、向进程内插件的注册表注册命令（命令执行中再调用宿主的 `ui@1`）、调用进程内插件给的回调、注册工具和 gate；进程退出时插件被隔离、命令被撤销。也在 Node 下用 `jade -p` 跑通了 Python 插件的工具。
6. **TUI 和注册表插件**：`jade/tui`、`jade/commands`、`jade/keys`、`jade/renderers`、`jade/modes`、`jade/sessions`。
   已完成：`test/tui-frontend.test.ts` 用假终端和假模型跑真实的 bundled 插件：输入消息、在审批对话框里批准（预览是 `jade/fs` 的 diff）、看到回复、`/mode`、`/help`、`/exit`、`@` 补全（候选来自 `jade/fs` 的 `listFiles`，发送时由 `jade/mentions` 附上内容）、`--continue`。`test/registries.test.ts` 覆盖注册、撤销、保留键、`/clear`、`/resume`。插件在状态栏显示自己的段落、`ctx.input`（改输入框）已由 `ui@1.session` 提供，见 `test/session-ui.test.ts`。`/model` 已完成（`test/model.test.ts`），`/plugins` 由单独的 `jade/plugins` 提供（`test/plugins.test.ts`）。
7. **其余功能插件**逐个移植。每移植一个，都检查它没有用到第三方拿不到的东西。
   大部分已完成：web、todo、ask、task、compact、mcp、skills、checks、memory、undo、mentions、continue、repeats、budget，各有测试（`test/<插件>.test.ts`）。期间核心改了两处：会话队列的竞争（上一条 `send` 刚 resolve 就再 `send`，新输入没人处理），兜底关卡只认 `approval@1` 的提供者（见第 7 节）。
   已完成：从 npm、git 和本地目录安装/更新插件（`test/install.test.ts` 覆盖本地目录、git 提交、npm 包、`--link`、`--project`、`--path`、本地改动保护和更新记录）。
   移植中发现的缺口，以后再定：没有"给模型留一句说明"的接口（memory、undo 各自在 `context.project` 里附说明，`/undo` 的已撤销记录存在 `$JADE_HOME/checkpoints`）；子 Agent 的日志不能关联到父会话。已经补上的：`jade/checks` 不再复制 jade/shell 找 shell、杀进程树的代码，改由 `shell@1` 提供。
8. ~~功能对齐后改名为 jade~~：已提前完成（2026-11-05）。旧 jade 归档到 `.archive/jade`，新实现直接占用 `apps/jade` 和 `jade` 命令；功能对齐前，jade 只是开发中的版本。

## 附录 A：参考调研摘要

**pi**：

- 扩展是 `export default (pi) => {...}`，用 `pi.on` 订阅四十多种事件，`registerTool/Command/Shortcut/Renderer`。
- 处理器组合有明确的表：通知、原地修改、链式变换、关卡（先拒绝者胜）、最后者胜。
- 出错时处理器 try/catch 后继续，`tool_call` 出错按拒绝处理；工厂函数的注册是事务性的。
- 问题：
  - 最大的一类是过期 ctx 和换会话时的竞争（#10599、#8680、#8988、#6101）；
  - `sendUserMessage("/cmd")` 不执行命令、缺"停下来之后再做"的调度；
  - 模块双份导致单例错乱；
  - 工具、压缩、提示词、界面仍是几千行宿主代码（`interactive-mode.ts` 7254 行）；
  - 没有进程外扩展。

**dsh / cordis**：

- 没有内核包，cordis 的 Fiber + `inject` 驱动激活：服务出现就激活、消失就卸载、换掉就重跑 `apply`。
- 所有注册都是 effect，卸载时逆序撤销，这一点值得照搬。
- 问题见 5.1。另外：
  - 配置补丁可以执行 `!!js`；
  - 同名服务第二个提供者直接抛错；
  - 插件拿到完整的 Node 能力，没有资源和时间预算。
