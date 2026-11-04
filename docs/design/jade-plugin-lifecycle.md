# 设计：jade 插件的生命周期

> 状态：第 1–5 步（静态 id、PluginHost、SessionScope、进程外插件的会话适配器、生命周期矩阵测试）已实施；第 9 节的问题待定 · 2026-11-05
>
> 对应条款：7.1（项目层确认）、8.2（不满足时拒绝加载，不静默降级）、I-9（一切可中断）、4.6（恢复时插件变化）
>
> 范围：只涉及 jade（`apps/jade`），不改内核。

## 1. 为什么要写这份设计

PR #1 的评审修了三轮，几乎每次修复都会带出新的取舍。回头看，这些问题几乎都可以归成同一类：**一样东西活多久、谁创建、谁销毁，从来没有写下来**。

| 遇到的问题 | 本质 |
|---|---|
| 模型服务被创建两次，最后改成从模块导出 | 服务应该是整个进程一份，却挂在每个会话都重建的实例上 |
| `/resume` 失败后状态栏、输入框错乱，靠 `jadeGeneration` 加手动回滚补救 | 换会话不是一个事务，失败时没有统一负责回滚的地方 |
| 按 id 停用的插件仍然先跑一遍工厂函数和服务的 `create`，事后再 `unregisterProviders` | 要创建实例才知道 id：身份不是静态的 |
| 缺少 `dispose` | 有创建，没有销毁 |
| 快捷键“同时只执行一次”的规则，后来又去掉 | 一次调用的生命周期没有定义 |
| 状态栏、模型服务用目录名，冲突检查、会话日志用 id | 身份有两个来源 |
| 项目层插件导出的 `providers` 被静默忽略 | 每种扩展点能在哪一层用，没有统一检查 |

现在这些规则分散在 `main.ts`（启动顺序、`leave`、`switchSession`、`reloadSession`、`abortKeys`、`jadeGeneration`）、`distro.ts`（`createExtensions`、`disposeInstance`、`disabledById`）和 `loader.ts` 里。每个补丁只在局部正确，所以修一处，旁边就冒出一处。

这份设计不加新功能，只做三件事：

1. 定下**三个作用域**，每个作用域只有一个负责创建和销毁的地方；
2. 把**身份**变成静态的：不执行插件代码就能认出插件；
3. 给每种扩展点写一张**规则表**，规定它的作用域、哪一层能用、冲突怎么处理、出错怎么处理。

## 2. 参考：pi 是怎么做的

pi（`badlogic/pi-mono` 的 coding-agent）的扩展系统比较成熟，读它的 `docs/extensions.md` 和 `docs/packages.md`，值得借鉴的有这些：

| pi 的做法 | 对 jade 的启发 |
|---|---|
| 生命周期写成图：启动、`/new`、`/resume`、`/fork`、`/reload`、退出，每条路径都先 `session_shutdown` 再 `session_start`，事件带 `reason` | jade 也该有一张图，所有换会话的路径走同一个流程 |
| 换会话后，旧的 `pi` / `ctx` 是“过期对象”，再用会抛错。文档专门有一节讲这类陷阱，包括 `await ctx.reload()` 之后的代码还在旧闭包里运行 | jade 的旧实例现在只是静默失效（generation 不匹配就忽略）。应该让问题被看见，但不能让 jade 崩溃（见 5.3） |
| 插件按**路径或包**识别，启用和停用在加载之前决定（`pi config`），不需要执行插件代码 | 这正是“按 id 停用还要先运行代码”这个问题的解法：身份要静态 |
| 文档明确规定：工厂函数里不要启动后台资源，要放在 `session_start` 里，并在 `session_shutdown` 里关闭 | jade 的工厂每个会话调用一次，相当于 `session_start`，所以对应的规则是：工厂里打开的资源，在 `dispose` 里关闭 |
| 处理器组合写成一张表：通知、原地修改、链式变换、关卡、最后一个覆盖 | jade 的冲突规则（先到先得、只用第一个、只能渲染自己的工具）也该集中写成一张表 |
| 出错的统一原则：插件出错只记日志、Agent 继续运行；关卡出错按拒绝处理 | 和 jade 现在的做法一致，只是没有写在一处 |

不借鉴的地方：

- **事件总线**（`pi.on(...)`，四十多种事件，命令式注册）。jade 建立在内核的声明式插件对象上：hook 要声明 `needs`，内核检查兼容性（8.2），子 Agent 可以按 hook 种类取子集。这比事件总线更容易静态检查，是 jade 的优势，应该保留。
- **热重载插件代码**（`/reload`）。jade 的进程级资源（模块、进程外插件的进程、模型服务）在整个进程里不变，改了插件仍然要重启。这样作用域简单很多，等有明确需求再考虑。

## 3. 三个作用域

```
进程级  ─────────────────────────────────────────────────────────────── jade 进程
         清单（id、版本、层级、replaces）· 模块 import · 模型服务 · 进程外插件的进程
         负责者：PluginHost        创建：启动时        销毁：退出时（close）

会话级       ├──── 会话 A ────┤├──── 会话 B ────┤├── 会话 B（reload）──┤
         工厂返回的实例：tools、hooks、commands、keys、renderers、responder、suggest、beforeSend
         绑定到会话的 ctx：status、input、send
         负责者：SessionScope      创建：prepare     销毁：close（dispose）

调用级          ├┤  ├──┤   ├┤ ├───┤
         一次 hook、命令、快捷键、beforeSend、suggest、complete
         负责者：发起调用的地方    信号：用户取消，或者所属会话关闭
```

### 3.1 进程级：`PluginHost`

一个新模块（`src/plugins/host.ts`），把 `main.ts` 里和插件有关的启动、退出代码收进来：

1. **发现**（`discoverPlugins`）：得到目录列表；
2. **读清单**（`inspectPlugin`）：不执行代码，读出 id、版本、层级、`replaces`、带的内容；
3. **筛选**：按 `plugins.json` 的 `disabled`（id）去掉停用的插件；id 重复的，后发现的跳过并警告；
4. **加载**：项目层先确认（7.1），再 import 模块或启动进程；
5. **注册模型服务**：模块导出的 `providers`；
6. **退出**：`close()` 结束进程外插件。

它对外只暴露清单（`plugins`、`bundled`）、`load()`、加载好的插件（`loaded`）和 `close()`，要告诉用户的事经 `report` 交给宿主显示。进程级的东西只在这里创建、只在这里销毁，会话级代码不能注册或注销进程级资源。

### 3.2 会话级：`SessionScope`

一套插件实例，加上绑定到这套实例的 ctx，合起来叫一个 SessionScope。它有四个状态：

```
preparing ──commit──▶ active ──close──▶ closing ──▶ closed
    │
    └──rollback──▶ closed
```

| 状态 | ctx.status | ctx.input / ctx.send | scope.signal |
|---|---|---|---|
| preparing | 先存起来，commit 时显示 | 无效，开发时警告一次 | 未中止 |
| active | 生效 | 生效 | 未中止 |
| closing | 无效（插件还没轮到 dispose，不警告） | 无效，不警告 | **已中止** |
| closed（dispose 完成） | 无效，警告一次；`status(undefined)` 不警告 | 无效，警告一次 | **已中止** |

用状态代替现在的 `jadeGeneration` 计数器。区别在于：现在 `makeJade` 一开始就把计数加一，于是新实例还没有确定要用，旧实例就已经失效；`/resume` 失败时只能手动把计数、状态栏恢复回去。有了 `preparing` 状态，旧 scope 在 commit 之前一直是 active，回滚不需要任何恢复操作。

`scope.signal` 在 close 时中止，所有调用级的信号都从它派生（见 3.3）。插件也可以通过 `ctx.signal` 拿到它，用来关闭简单的资源：

```ts
const timer = setInterval(tick, 1000);
ctx.signal.addEventListener("abort", () => clearInterval(timer));
```

需要异步收尾的（例如等连接关闭），仍然用 `dispose`。

### 3.3 调用级

每次调用都带一个 `signal`，它由“用户取消”和“所属 scope 关闭”合并而成。规则：

- 调用的结果在 signal 中止之后到达的，直接丢弃，不报警告；
- 并发：快捷键可以并发（同一个键在上一次执行完之前可以再触发）；`beforeSend` 按插件顺序串行；非 `instant` 的命令排队；
- 时限：只有 `beforeSend`（30 秒，超时按原文发出）和 `dispose`（5 秒）有固定时限，其他的由用户取消。

**例外**：发起换会话的那次调用。命令里调用 `session.clear()`、`resume()`、`reload()` 时，旧 scope 会关闭，但这次命令的 signal 不因此中止，否则它会中止自己。规则写进文档：换会话是这次调用的最后一步，之后不要再使用旧实例的状态（和 pi 的 “treat reload as terminal” 一致）。

## 4. 身份：静态 id

### 4.1 规则

- **有代码的插件必须在 `plugin.json` 里写 `id`**。只带内容的插件可以不写，用目录名作 id。
- jade 读清单时就知道 id。停用、冲突检查、状态栏、模型服务的归属、`jade plugin list`、`jade plugin disable` 全部用 id，不再用目录名。
- 实例的 `id` 必须和清单里的一致，不一致就跳过并警告。`ctx.definePlugin` 自动从清单填上 `id` 和 `version`，所以插件代码里不用再写一遍：

```jsonc
// plugin.json
{ "id": "me/clock", "version": "1.0.0" }
```
```ts
export default (ctx) => ctx.definePlugin({ hooks: [...] });   // id、version 来自 plugin.json
```

- 进程外插件在 `initialize` 回复里给出的 id 也必须和清单一致。

### 4.2 能删掉的东西

| 现在 | 之后 |
|---|---|
| `plugins.json` 的 `disabled` 同时认目录名和 id | 只认 id（内置插件本来就用 id） |
| `Jade.disabledById` 和 `unregisterProviders`，以及 `main.ts` 里检查 owner 的代码 | 删掉：停用的插件根本不会被加载 |
| `jade plugin disable` 不知道 id 对应哪个目录，只能“不管是什么都停用” | 读清单就能解析 id，能给出准确提示 |
| 模型服务显示目录名 | 显示 id |

### 4.3 迁移

**已决定**：目前没有真实的使用者，直接要求写 `id`，不设过渡期。缺少时跳过并提示，`jade plugin add` 也拒绝安装。

## 5. 换会话：一个事务

### 5.1 所有路径共用一个流程

启动、`/clear`、`/resume`、reload、退出，都是同一个流程的不同组合：

```
prepare(next)        创建 next scope（preparing），调用工厂函数，创建 Runtime
   │ 失败 → rollback(next)：dispose next；当前 scope 不受任何影响
   ▼
commit
   1. 当前 scope → closing：中止 scope.signal（快捷键、命令等进行中的调用随之中止）
   2. 当前 Runtime detach（写 session.detached，会话的收尾 hook 运行完）
   3. next → active：显示它在 preparing 期间设置的状态
   4. 后台：dispose 旧 scope（限时 5 秒，警告延后显示）
```

| 路径 | prepare | commit | 说明 |
|---|---|---|---|
| 启动 | ✓ | 只有第 3 步 | 没有旧 scope |
| `/clear` | ✓ | ✓ | |
| `/resume` | ✓（`Runtime.resume`） | ✓ | 失败时 rollback，留在当前会话 |
| reload | ✓（resume 当前会话） | ✓ | 需要先 detach 当前 Runtime 才能 resume，所以先做第 1、2 步，再 prepare；prepare 失败时新建会话（和现在一样） |
| 退出 | — | 第 1、2 步，然后**等待** dispose | 退出要等 dispose 完成，最多 5 秒 |

这个流程只在一处实现（例如 `SessionScope` 加上 `main.ts` 里的一个 `replaceSession(prepare)`）。`leave`、`switchSession`、`reloadSession` 和 `abortKeys` 都改为调用它。

### 5.2 dispose 在后台进行

现在 `/clear` 要等旧实例 dispose 完成，一个卡住的插件最多能让 `/clear` 慢 5 秒。commit 之后新会话已经可以用，旧实例的 dispose 不必挡在前面。两套实例会短暂共存，这本来就避免不了：工厂函数在 prepare 阶段就已经运行了。插件需要遵守的只有一条：不要假设同一时间只有一个实例。

### 5.3 过期的 ctx：不抛错，但要警告

pi 让过期的 ctx 抛错。jade 不能这么做：插件常在定时器回调里调用 `ctx.status`，抛错会变成未捕获的异常，让 jade 崩溃。现在的做法是静默忽略，这又会把泄漏藏起来。折中的办法是：调用无效，并且每个插件只警告一次：

```
[warning] plugin me/clock used ctx.status after its session ended, so it was ignored; stop timers and listeners in dispose, or when ctx.signal aborts
```

这样，忘了写 `dispose` 的插件从“看不见的泄漏”变成了“看得见的警告”，符合 8.2 的精神。

实施时的修正：只在 dispose **完成之后**（closed）才警告。closing 到 dispose 之间要等会话收尾，按规矩在 `dispose` 里停定时器的插件，定时器这时再触发一次是正常的，警告它就是误报。`dispose` 里调用 `ctx.status(undefined)` 去掉自己的段落也不警告。

## 6. 进程外插件

进程是进程级的，在会话之间共用。现在每次 `create` 都会改写共用的 `proc.keys`（`processKeys` 绑定到新会话的 ctx），所以 prepare 一个新会话会影响当前会话的对象。

改法：会话级的绑定放在 jade 这边，作为 SessionScope 的一部分。按 `proc.manifest` 为每个 scope 生成 keys 和 commands 的适配器，不再写到 `proc` 上。内核只认 `spawnPlugin` 返回的那个对象（7.1），而 keys 和 commands 是 jade 的扩展，内核不读，所以不需要挂在 `proc` 上。

实施：`LoadedPlugin.create` 原样返回 `proc`；进程外插件另有 `adapters(host)`，每套实例调用一次，按清单生成绑定到这一套 ctx 的 keys 和 commands。`createExtensions` 检查过的 keys 和 commands 放在 `Jade.extensions` 的每一项上，不再写回实例，模块插件也一样，所以不管哪种插件，实例对象在创建之后都不会被 jade 改写快捷键和命令。

## 7. 规则表

这一节写进 `apps/jade/docs/plugins.md`，作为插件作者的参考；同时也是测试清单，每一行至少有一个测试。

已写进 [`plugins.md` 的规则一览](../../apps/jade/docs/plugins.md#规则一览)（那里的表按实现校对过，以那里为准）。每一行的测试见 7.2。

**加载顺序**：用户层在前，项目层从仓库根目录到工作目录；同一层内按目录名排序。下表的“先到先得”都按这个顺序。

| 扩展点 | 作用域 | 哪一层可用 | 冲突 | 出错 |
|---|---|---|---|---|
| 清单（`plugin.json`） | 进程 | 两层 | id 重复：后发现的跳过 | 格式不对：跳过插件 |
| `providers`（模块导出） | 进程 | 仅用户层；项目层的**给出警告** | kind 和内置服务同名或重复：跳过 | 格式不对：跳过这个服务；`create` 出错：`/model` 报错 |
| 进程外插件的进程 | 进程 | 两层（项目层需确认） | — | 进程退出：警告，之后的调用按出错处理（不重启） |
| 工厂函数 | 会话 | 两层 | — | 出错：跳过插件 |
| `tools` | 会话 | 两层 | 工具名重复：插件跳过；`replaces` 的内置插件除外 | 内核规定 |
| `hooks` | 会话 | 两层 | 全部执行，顺序见宪法 5.3 | 内核规定（关卡出错按拒绝处理） |
| `commands` | 会话 | 两层 | 宿主命令 > 内置插件 > 自定义命令和 skill > 第三方先到先得 | 警告 |
| `keys` | 会话（调用可以并发） | 两层；项目层的回复不能改输入框 | 先到先得；保留键不可用 | 警告 |
| `renderers` | 会话 | 两层 | 只能渲染自己的工具 | 退回默认显示，警告一次 |
| `responder` | 会话 | 仅用户层 | 全部同时等，用最先给出的回答 | 视为不回答，警告 |
| `suggest` | 会话 | 两层 | 只用第一个 | 不显示建议，警告 |
| `beforeSend` | 会话（串行） | 两层 | 按顺序链式处理 | 按原文继续，警告；30 秒超时 |
| `replaces` | 会话 | 两层 | 不动点计算（见 `distro.ts`）；`jade/policy` 不可代替 | 警告 |
| `dispose` | 会话 | 两层（进程外插件没有） | — | 警告；5 秒超时 |
| `ctx.status` | 会话 | 两层 | 按 id 分段 | 过期调用：无效并警告一次 |
| `ctx.input`、`ctx.send` | 会话 | 仅用户层，非 `-p` | — | 过期调用：无效并警告一次 |
| `ctx.complete`、`ctx.run` | 调用 | 两层 | — | 抛给插件 |

### 7.1 给插件作者的八条规则

1. **身份写在 `plugin.json` 里**。jade 不执行代码就能认出、停用你的插件。
2. **进程级的东西从模块导出，会话级的东西由工厂返回**。现在进程级的只有 `providers`。
3. **工厂函数每个会话调用一次**，按会话的状态放在工厂函数里。
4. **工厂里打开的资源，在 `dispose` 里关闭**，或者挂到 `ctx.signal` 上。
5. **会话结束后，ctx 就过期了**。不要把它保存到会话之外。
6. **耗时的操作都接收 `signal`**，中止后尽快返回，结果会被丢弃。
7. **调用 `session.clear/resume/reload` 是这次命令的最后一步**。
8. **同名、同键按加载顺序先到先得**。项目层插件不能替用户说话、不能回答审批、不能提供模型服务。

### 7.2 每一行的测试

测试都在 `apps/jade/test/`。

| 扩展点 | 测试 |
|---|---|
| 清单 | `plugins.test.ts` resolvePlugins 和 plugin host 的测试；`plugin-install.test.ts` 没有 `id` 的插件不安装 |
| `providers` | `plugins.test.ts` "only user plugins can provide services, and malformed ones are skipped"、plugin host 的测试 |
| 进程外插件的进程 | `plugins.test.ts` "a process plugin that exits by itself is reported once…" |
| 工厂函数 | `plugins.test.ts` "broken plugins are skipped with a warning instead of stopping jade" |
| `tools` | `plugins.test.ts` 同上（`tool read_file already exists`）；`plugin-install.test.ts` "a plugin replaces a built-in and may reuse its tool names…" |
| `hooks` | 内核的测试（`packages/kernel/test`） |
| `commands` | `host-rules.test.ts` "slash command names"；`plugins.test.ts` 进程外插件的斜杠命令 |
| `keys` | `plugins.test.ts` "keys are normalized; malformed, reserved and taken keys are skipped"、"a process plugin's keys go over jade/key…" |
| `renderers` | `transcript.test.ts` "a plugin's renderer … failures fall back to the default once warned"；`plugins.test.ts` 只能渲染自己的工具 |
| `responder` | `plugins.test.ts` "only user plugins can provide a responder"；`respond.test.ts` firstAnswer |
| `suggest` | `plugins.test.ts` "suggest, beforeSend and ctx.status are collected; only the first suggest is used" |
| `beforeSend` | `host-rules.test.ts` "beforeSend" |
| `replaces` | `plugin-install.test.ts` 同上；`host-rules.test.ts` 代替内置插件的命令 |
| `dispose` | `plugins.test.ts` "dispose: used instances on jade.dispose (once)…"；`session-lifecycle.test.ts` |
| `ctx.status`、`ctx.input`、`ctx.send`、`ctx.signal` | `session-scope.test.ts`、`session-lifecycle.test.ts` |
| `ctx.complete`、`ctx.run` | `plugins.test.ts` "a plugin can call the current model with ctx.complete…"；`jade.test.ts` 里 `shellTools().run` 的测试 |
| 不改写插件实例 | `plugins.test.ts` "jade never rewrites a plugin instance…" |

没有覆盖的：`suggest` 出错时的警告（在 `main.ts` 里，只有一行 `catch`）。

## 8. 实施步骤

每一步都可以单独合并，单独测试：

1. **静态 id**：`plugin.json` 加 `id`，`ctx.definePlugin` 从清单补全 `id` 和 `version`，实例的 id 和清单不一致时跳过；`disabled` 只认 id，在加载之前筛选。删掉 `disabledById`、`unregisterProviders` 和 owner 检查。
2. **PluginHost**：把 `main.ts` 里的发现、加载、注册服务和 `closePlugins` 收进 `src/plugins/host.ts`；项目层导出的 `providers` 给出警告。
3. **SessionScope 和换会话事务**：实现四个状态、`ctx.signal`、过期警告、后台 dispose；删掉 `jadeGeneration`、`/resume` 失败时的手动恢复和 `keyRuns`；`leave`、`switchSession`、`reloadSession` 改为调用同一个流程。
4. **进程外插件的会话适配器**：不再改写 `proc.keys` 和 `proc.commands`。（已实施）
5. **生命周期矩阵测试**：对启动、`/clear`、`/resume` 成功、`/resume` 失败、reload、退出这几条路径，各自断言工厂调用次数、dispose 的次数和时机、状态栏的内容、过期调用是否被拒绝。（已实施：换会话的流程从 `main.ts` 移到 `src/session-lifecycle.ts`，`test/session-lifecycle.test.ts` 用真的 `createJade`、`Runtime` 和插件测它；界面上的清屏、提示仍在 `main.ts`）

第 1、2 步之后，现有的四项取舍会消失三项：按 id 停用仍运行代码、服务显示目录名、项目层服务被静默忽略。第 3 步之后，最后一项（`/clear` 被 dispose 拖慢）也会消失。

## 9. 待评审的问题

1. ~~**`id` 一定要写在 `plugin.json` 里吗？**~~ **已决定：写在 `plugin.json` 里。** `export const id` 要先 import 才能读到，而 import 就是执行代码。
2. **`replaces` 要不要也放进清单？** 放进去后，`/plugins` 和 `jade plugin list` 不执行代码就能显示代替关系，内置插件也能在创建实例之前确定。但不动点计算仍然需要，因为工具名冲突要等实例创建之后才知道。
3. **过期 ctx 的处理**：本文选择“无效并警告一次”；另一种做法是像 pi 一样抛错。
4. **要不要收缩扩展点？** 目前没有真实的使用者，所以接口可以随时改，不需要兼容。`responder`、`suggest`、`beforeSend`、`keys`、`renderers`、`providers` 要不要先不公开，还没有决定。
5. **事件里要不要带 `reason`**（`"startup" | "new" | "resume" | "reload"`）？pi 有，插件可以据此决定要不要恢复状态。jade 可以放在工厂的 ctx 里。没有具体需求的话先不加。

## 10. 不在本次范围

- 热重载插件代码；
- 改动内核（内核没有插件生命周期，也不需要：按宪法 1.3，这是发行版的事）；
- 进程外插件自动重启；
- 新增扩展点。
