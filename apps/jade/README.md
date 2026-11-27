<p align="center"><img src="assets/logo.svg" alt="jade" width="160"></p>

# jade

> 基于 [uncarved](../../README.md) 内核的编程 Agent 发行版。
>
> 核心稳定、小、不认识任何功能；**一切功能都是插件**。

jade 是一个跑在终端里的 coding agent：它能读写文件、运行命令、搜索网页、管理会话，并且可以中断、恢复、重放。它和别的 coding agent 的根本区别在于——shell、文件、审批、提示词、界面、模型路由，没有一个住在宿主里，全是普通插件。坏一个插件只伤到它自己，进程不退出；你想换掉任何一项能力，装个插件就行。

设计原则与分层见 [docs/design/jade.md](../../docs/design/jade.md)，内核的约束见 [CONSTITUTION.md](../../CONSTITUTION.md)。

## 运行环境

Node.js ≥ 22.18，或 Bun ≥ 1.3.9。

## 安装

```sh
npm install -g @uncarved/jade
# 或 bun add -g @uncarved/jade
```

## 配置模型

复制 [.env.example](https://github.com/MochiNek0/uncarved/blob/main/.env.example) 到 `~/.jade/.env`（即 `$JADE_HOME/.env`）后填写，或在 jade 里用 `/model` 配置（会写进同一个文件）。三家任选其一：

| 服务 | 环境变量 |
|---|---|
| Claude | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`（默认 `claude-opus-5-5`） |
| OpenAI Responses | `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` |
| 兼容 `/chat/completions` 的服务 | `OPENAI_COMPAT_BASE_URL`、`OPENAI_COMPAT_API_KEY`、`OPENAI_COMPAT_MODEL` |

用 `JADE_PROVIDER` 指定走哪一家（`anthropic` / `openai` / `openai-compat`），不设时按上面顺序自动选。

## 用法

```sh
jade                       # 启动终端界面（默认前端），交互式对话
jade -p "把 README 翻成英文"   # 非交互：把消息发给模型后打印结果退出
cat err.log | jade -p - "解释这个错误"   # "-"：把 stdin 接在消息后面（不写 "-" 时，有消息就不读 stdin）
jade -p -c "接着做"          # 非交互，接着这个目录里最近一次会话
jade -p --json "..."       # 结束时在 stdout 输出一个 JSON：session、result（最后的回复）、reason、usage
jade --serve               # 无头常驻：stdin/stdout 一行一个 JSON，一个进程同时跑多个会话、多轮对话（jade --serve --help 看协议）
jade -c                    # 继续最近一次会话
jade --resume <id>         # 恢复指定会话
jade --safe                # 只加载自带的插件（排查故障用）
jade -v                    # 打印版本
```

会话里的斜杠命令（由对应插件提供）：`/clear` `/resume` `/retry` `/mode` `/model` `/plugins` `/mcp` `/skills` `/memory` `/undo` `/search` `/compact` `/schedule` `/suggest` `/checks` `/copy` `/shells` `/cost` `/help` `/exit`。

- `/copy` 把最后一条回复的原文放进剪贴板（`/copy code` 只要其中最后一个代码块），没有折行和排版符号。
- `/undo` 撤销上一轮改过的文件；在 git 仓库里，这一轮 shell 命令改动、新建、删除的文件也一起恢复（被 `.gitignore` 忽略的除外）。
- `/compact 要留意的事`：压缩历史时让总结特别留意后面写的内容。
- `/shells` 列出 agent 启动的后台命令，`/shells kill <编号>` 停掉一个；后台命令自己结束时会提示。
- 自定义命令：把提示词写进 `$JADE_HOME/commands/<名字>.md`（或仓库里的 `.jade/commands/`），之后用 `/<名字> [参数]` 发送；正文里的 `$ARGUMENTS` 换成参数。

输入框里回车发送；换行用 Ctrl+J（Windows Terminal 里 Ctrl+Enter 也行）、Alt+Enter，或行尾写 `\` 再回车。终端单独上报 Shift+Enter 时它也换行。Ctrl+G 用编辑器（`$VISUAL`、`$EDITOR`，或配置 `{"jade/editor": {"editor": "code --wait"}}`）写这条消息，存盘退出后回到输入框。

agent 工作的时候可以接着打字：发出去的话在它下一次请求模型时就到（跟在刚执行完的工具的结果后面），不用等这一轮结束；这一轮先结束了的，当下一条消息发。按 ↑ 或连按两次 Esc 可以把还没送到的话取回来改。

连续两次 Ctrl+C（2 秒内）直接退出，不经过任何插件——插件出问题时你一定能停下来。

## 权限

jade 默认在改动前问你。模式由 `jade/approval` 插件提供，用 Shift+Tab 或 `/mode` 切换，`ask` / `auto` 会记到 `$JADE_HOME/mode.json`：

| 模式 | 行为 |
|---|---|
| `ask`（默认） | 改动前询问 |
| `auto` | 不询问：工作目录内的改动和无害命令直接放行，读工作目录之外的文件也直接放行（凭据、密钥、浏览器数据、`$JADE_HOME` 和整个主目录除外）；规则判断不了的让模型审，有风险的拦下并告诉 agent，agent 用 ask_user 问你，你同意后它重试就能通过；连续拦下 3 次（或一个会话累计 20 次）、或者审查超时出错时，那一次直接问你。审查放行过的命令，在它跑的脚本没改之前不再审查 |
| `plan` | 不改任何东西，只给出计划 |
| `yolo` | 从不询问 |

审批对话框里除了"允许一次"和"本会话里总是允许"，还可以选"在这个目录里总是允许"：规则记在 `$JADE_HOME/state/approvals.json`（按工作目录），以后在这个目录里开的会话都不再问，删掉文件里对应的条目就恢复询问。也可以选"拒绝并说明"，写一句话告诉 agent 该怎么做。预览放不下时用 PgUp/PgDn 翻看。

安全性靠三条：**拒绝优先**（任何一个插件的拒绝都不能被推翻）、**兜底关卡**（审批插件不在场时核心拒绝所有写操作，而不是放行）、**层级**（项目层插件换不掉你的审批、模型配置和前端）。审批插件坏掉的结果是"什么都改不了"，不是"什么都放行"。

## 无头模式

`jade --serve` 不画界面、常驻运行：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 事件，一个进程同时跑多个会话。协议见 `jade --serve --help`。

无头模式没人能回答审批，要问的调用一律拒绝。默认的 `ask` 模式下连工作目录里的 `write_file` 也会被拒绝，只能读。要让它改文件，在 `$JADE_HOME/config.json` 里设模式，例如 `{"jade/approval": {"mode": "auto"}}`（工作目录内的改动放行，判断不了的先让模型审，审不过的拒绝）。`jade -p` 也是这样。

### 内存占用

一个 `jade --serve` 进程里开 1、5、10、20 个会话，每个会话同时跑 5 轮带工具调用的真实模型对话，每轮结束等 1 秒后对整棵进程树采样，口径和提示词与 jcode 的 [bench_headless_memory.py](https://github.com/1jehuang/jcode/blob/master/scripts/bench_headless_memory.py) 相同。复现：`bun scripts/bench-serve-memory.ts --sessions 1,5,10,20 --runtime node`（`--scripted` 换成不联网的假模型）。

| 工具 | 第一个会话 | 每多一个会话 | 和 jcode 比（每多一个） |
|---|---:|---:|---|
| **jade**（Node） | **75.6 MB** | **~2.2 MB** | 0.67× |
| jade（Bun，假模型） | 217.3 MB | ~4.8 MB | 1.45× |
| jcode | 71.3 MB | ~3.3 MB | 基准 |
| OpenCode | 637.1 MB | ~5.9 MB | 1.8× |
| pi | 84.0 MB | ~79.6 MB | 24.1× |
| Claude Code | 272.9 MB | ~169.3 MB | 51.3× |
| Codex CLI | 398.6 MB | ~194.1 MB | 58.8× |

| 工具 | 启动到能接收输入 | 和 jcode 比 |
|---|---:|---|
| jade（Node） | 289 ms | ~15× |
| jade（Bun） | 313 ms | ~16× |
| jcode | 19.1 ms | 基准 |
| pi | 596.4 ms | 31.2× |
| Codex CLI | 905.8 ms | 47.4× |
| OpenCode | 1047.9 ms | 54.9× |
| Claude Code | 3512.8 ms | 183.9× |

jade 的数字测于 2026-11-25（i5-1340P、32 GB、Windows 11，Node 22.22 / Bun 1.3.9，模型 egg-alpha-004）；其余各行抄自 [jcode 的 README](https://github.com/1jehuang/jcode)，它没写硬件和平台。两边口径不完全相同，只能粗看：

- jcode 量的是 Linux 上的 PSS（共享的内存按进程分摊）；Windows 上量的是工作集，共享的内存整份计入，数字偏大。同一次测量的私有字节：1 个会话 70 MB，20 个会话 118.5 MB。
- "每多一个会话" = （20 个会话 − 1 个会话）÷ 19，都取第 5 轮之后的值。jcode 没写它怎么算。
- 启动时间：jcode 量的是在交互界面里打的字出现在屏幕上（10 次启动）；jade 量的是从启动 `jade --serve` 到回复 `opened`（10 次，中位数），不是同一个指标。
- npm 装的 `jade` 用 Node 运行。Bun 一开始就多占约 150 MB。

## 会话与恢复

每个会话是一条只追加的事件日志，内核状态完全由日志重建。进程退出后会话仍在，`jade -c` 或 `jade --resume <id>` 接着跑。会话索引在 `$JADE_HOME/state/sessions.jsonl`。崩溃恢复时，未完成的幂等工具会重跑，其余中断的工具交给你或插件决定，内核不自动重试。

## 插件

jade 自带的功能全是 `apps/jade/plugins/` 下的普通插件，和第三方插件走同一套加载流程。几个代表：

| 插件 | 提供的能力 |
|---|---|
| `jade/tui`、`jade/print`、`jade/serve` | 终端界面、`-p` 非交互模式、`--serve` 无头多会话模式 |
| `jade/fs`、`jade/shell` | 文件读写、运行命令（`shell@1` 供其他插件调用） |
| `jade/web` | `web_fetch`、`web_search`、`/search` |
| `jade/models` | 模型路由、`/model`（按服务分组列出模型，回车切换；设置、单价、服务名在 Manage models 里）、`provider@1` |
| `jade/approval` | 权限审批、模式、审查 |
| `jade/modes` | 模式切换、计划模式 |
| `jade/compact` | 上下文压缩（总结沿用主对话的提示缓存）、溢出后自动重试 |
| `jade/task` | 子 Agent（核心开的子会话） |
| `jade/mcp` | MCP 服务工具 |
| `jade/skills`、`jade/memory` | 技能目录、长期记忆 |
| `jade/schedule` | 定时任务（cron，重启后仍生效） |
| `jade/screenshot` | 无头浏览器截图交给模型看 |
| `jade/custom-commands` | 把 Markdown 文件变成斜杠命令 |
| `jade/hooks` | 在配置里写 shell 命令，工具调用前后、一轮结束时运行 |
| `jade/cost` | 按单价把 token 用量换算成钱（`/model` 里给模型填的，可以分时段、美元或人民币；或者配置里的），`/cost`；`/cost` 还列出提示缓存的命中率、Jade 改变请求前缀的次数（压缩、系统提示词……）和前缀没变却没命中的次数 |
| `jade/steer` | agent 工作时说的话在下一次请求模型时就交给它 |
| `jade/withdraw` | 按 esc 时模型还没回复的消息撤回、放回输入框，会话不换 |
| `jade/editor` | Ctrl+G 用 `$EDITOR` 编辑输入 |

完整清单见 [docs/design/jade.md](../../docs/design/jade.md) 第 9 节。

### 管理插件

```sh
jade plugins list                                   # 查看每个插件的状态、来源、服务冲突
jade plugins add <来源> [--project] [--link] [--path <子目录>] [--force]
jade plugins update [id…]
jade plugins remove <id>
jade plugins enable <id>    # 恢复被自动停用的插件
jade plugins disable <id>
```

`<来源>` 支持：本地目录、npm 包（`name@版本`、`@scope/name`、`npm:<spec>`、`.tgz`）、git 仓库（`https://…`、`git@…`、`github:user/repo`、`user/repo`，可带 `#分支/tag/提交`）。`--project` 装进仓库的 `.jade/plugins`（随代码分发，首次加载需确认）；`--link` 把本地目录链接进来，开发插件用。

### 安装 skill 和 MCP 服务

```sh
jade skills add <来源> [--path <子目录>] [--project] [--force]   # 来源的写法同上
jade skills update [名字…] [--project] [--force]
jade skills remove <名字> [--project]
jade skills                                                      # 列出找到的 skill

jade mcp add <名字> [--env KEY=VALUE]… [--project] [--force] [--] <命令> [参数…]
jade mcp add <名字> --url <地址> [--header "Name: value"]… [--project] [--force]
jade mcp remove <名字> [--project]
```

不加 `--project` 装到 `$JADE_HOME`（`$JADE_HOME/skills/<名字>`、`$JADE_HOME/mcp.json`），加了装到当前工作目录（`.jade/skills/<名字>`、`.jade/mcp.json`）。一个仓库里有多个 skill 时（例如 `anthropics/skills`），不加 `--path` 会列出它们，用 `--path skills/pdf` 选一个。`jade skills update` 不覆盖装好后手动改过的 skill，除非加 `--force`。新装的 skill 马上生效，运行中的 jade 从下一步起就能用，不用 `/clear` 或重启；会话里同样可以用 `/skills add …`、`/mcp add …`；`/mcp add` 加的服务马上生效，`jade mcp add` 加的重启 jade 后生效，项目层的服务第一次启动前仍然要你确认。

这两条命令由 `jade/skills`、`jade/mcp` 插件经核心的 `cli@1` 注册，核心并不认识 skill 和 MCP。

安装不执行插件代码（npm 依赖用 `--ignore-scripts`），失败不会留下装了一半的插件。连续 3 次启动都在激活阶段失败的插件会被自动停用。

### 写一个插件

进程内插件是一个声明 `provides` / `requires` 的模块：

```jsonc
// plugin.json
{
  "id": "my/notes",
  "version": "0.1.0",
  "api": "^1",
  "entry": "./index.ts",
  "provides": ["notes@1"],
  "requires": ["ui@1"]
}
```

```ts
import { definePlugin } from "@uncarved/jade-api";

export default definePlugin({
  process(ctx) {
    const ui = ctx.require("ui@1");
    ctx.provide("notes@1", { list, add });          // 提供服务
  },
  session(ctx) {
    ctx.kernel.tool({ name: "note_add", /* … */ }); // 注册工具、hook
  },
});
```

进程外插件用同一个 API，清单里把 `entry` 换成 `"runtime": { "command": "python", "args": ["main.py"] }`，走 JSON-RPC 2.0。Python SDK 在 [sdk/python/jade_plugin.py](./sdk/python/jade_plugin.py)，单文件、只用标准库：

```python
from jade_plugin import Plugin

plugin = Plugin("my/greeter")

@plugin.process
def process(ctx):
    ctx.provide("greeter@1", Greeter())

@plugin.session
def session(ctx):
    ctx.tool("shout", "Upper-cases text", {"type": "object"},
             effect="read", execute=shout)

plugin.run()
```

插件之间只通过声明过的**服务**协作（`commands@1`、`ui@1`、`provider@1`……），核心不设专门的贡献点。一个服务名同一时间只有一个提供者；依赖在启动时静态算好，运行期间不变。每次跨插件调用都经过核心的"膜"：归属、超时、取消、错误隔离——插件代码出错只隔离它自己，不拖累依赖它的插件。

## 环境变量

"写在哪"一栏：`.env` 表示既可以写进 `$JADE_HOME/.env`，也可以设在 shell 里（shell 里的优先）；"shell" 表示只能设在 shell 里，写进 `.env` 无效。

| 变量 | 写在哪 | 说明 |
|---|---|---|
| `JADE_HOME` | shell | 配置与状态目录，默认 `~/.jade` |
| `JADE_PROVIDER` | `.env` | `anthropic` / `openai` / `openai-compat`，不设时自动选 |
| `JADE_MAX_TOKENS` | `.env` | 每次回复的输出上限，可写 `32000` / `64K` / `1M` |
| `JADE_EFFORT` | `.env` | 思考力度（Claude：`low`–`max`；OpenAI：`minimal`–`high`） |
| `JADE_CONTEXT_WINDOW` | `.env` | 模型上下文窗口，不设时按模型名推断 |
| `JADE_RPM` | `.env` | 每分钟最多发几个模型请求，不设时不主动限速 |
| `JADE_FALLBACKS` | `.env` | Claude 因安全策略拒绝时由服务端换模型重试；不设时只对官方地址开启，其他 Anthropic 格式的服务默认关闭。可在 `/model` 的模型设置里按模型改 |
| `JADE_THINKING` | `.env` | Anthropic 格式的请求里带不带 `thinking`（adaptive）和默认的 effort；设成 `off` 给见到这个字段就拒绝请求的服务用（例如基元律动的 egg-alpha-004），模型自己决定思不思考。可在 `/model` 的模型设置里按模型改 |
| `JADE_SEARCH` | `.env` | 搜索服务顺序，逗号分隔 |
| `JADE_SEARCH_RESULTS` | `.env` | 每次搜索返回条数，默认 10 |
| `JADE_SHELL` | shell | shell 工具用的 shell，默认 bash（Windows 上是 Git Bash） |
| `JADE_BROWSER` | shell | screenshot 工具用的浏览器（Chrome / Edge / Chromium） |
| `JADE_AUTO_UPDATE` | shell | 设为 `off` 关闭后台自动升级 |
| `JADE_UPDATE_CHECK` | shell | 设为 `off` 不检查更新 |
| `HTTPS_PROXY` / `HTTP_PROXY` | shell | 模型和 web 请求走代理（Node.js 版本太旧、不支持时启动时会提示；Bun 都支持） |

权限模式和压缩阈值是插件配置，写在 `$JADE_HOME/config.json`，例如 `{"jade/approval": {"mode": "auto"}, "jade/compact": {"thresholdTokens": "120k"}}`。会话里用 Shift+Tab 或 `/mode` 选的模式记在 `mode.json`，比配置优先（见上文"权限"）。历史超过 100k token 时（远在压缩阈值之前）会先清理较早的大段工具输出，只留最近的一段；清理会让提示缓存失效，所以只在大约 10 次请求内能回本时清理：缓存价按 `jade/cost` 的单价（`/model` 里填的或配置里的）算，没有时按原价的 1/20。100k 这个起点可用 `{"jade/compact": {"trimTokens": "200k"}}` 调整，`false` 关掉。等审批回答的时限默认 24 小时，过了按拒绝处理，可用 `{"jade/approval": {"askTimeoutMinutes": 30}}` 改短（最长一周）。auto 模式的审查默认用当前的模型，可用 `{"jade/approval": {"reviewModel": "<模型名>"}}` 换成 `/model` 保存过的另一个模型（更快更便宜的更好，它的限速也和会话分开）；审查的 60 秒时限从请求发出时算起，排队等限流的时间不算，连等待在内最多 4 分钟。

其他插件配置（都写在 `$JADE_HOME/config.json`）：

```jsonc
{
  // 子 Agent 用另一个（更便宜、更快的）模型：/model 保存过的名字，或当前服务上的模型名
  // 子 Agent 历史到了多少 token 就写报告（默认 150000，窗口的 70% 更小时按窗口算）
  "jade/task": { "model": "claude-haiku-5-5", "wrapUpTokens": 150000 },
  // 单价，每百万 token（这里的数字只是示例，按你用的服务填）；键是模型名或它的前缀，currency 不写时是 USD。
  // 配了之后状态栏显示会话花了多少钱，不同货币分开合计。更方便的是在 /model 里给模型填（Manage models → 模型 → Settings → Price），
  // 那里还能加按时间的价格（峰谷价、周末价、限时折扣），并且优先于这里的
  "jade/cost": { "prices": { "claude-opus": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75, "currency": "USD" } } },
  // hook：before 的命令退出码不是 0 时拒绝这次调用；after 失败时告诉 agent；turn 在一轮结束时运行。
  // 命令里可以用 $JADE_TOOL、$JADE_TOOL_INPUT（参数的 JSON 文件）、$JADE_TOOL_PATH
  "jade/hooks": { "hooks": [
    { "on": "after", "tool": "edit_file", "command": "bunx prettier --write \"$JADE_TOOL_PATH\"" },
    { "on": "turn", "command": "echo done" }
  ] },
  // 不读 ~/.claude/CLAUDE.md（默认在 $JADE_HOME 里没有 AGENTS.md / CLAUDE.md 时用它作用户指令）
  "jade/prompts": { "claudeInstructions": false },
  // 不在 shell 命令之前给工作区拍快照（/undo 就撤销不了命令的改动）
  "jade/undo": { "shell": false }
}
```

网络搜索可选配置多家服务的 key（`TAVILY_API_KEY`、`JINA_API_KEY`、`EXA_API_KEY` 等），配了 key 的服务按顺序试；一个 key 都不设时只有 `web_fetch`，没有 `web_search`。完整列表见 [.env.example](https://github.com/MochiNek0/uncarved/blob/main/.env.example)。

## 目录布局

```
~/.jade/                       # $JADE_HOME：用户层
  .env                         # 模型配置（/model 也写这里）
  config.json                  # 用户层插件配置
  mode.json                    # 当前权限模式
  plugins/                     # 用户层插件
  commands/                    # 自定义斜杠命令（<名字>.md）
  checkpoints/                 # /undo 的文件快照和工作区快照（按会话）
  state/
    approvals.json             # "在这个目录里总是允许"的规则（按工作目录）
    sessions.jsonl             # 会话索引
    trust.json                 # 项目层插件的确认记录（按内容哈希）
    secrets/<id>.json          # 各插件的密钥，0600
    faults.json                # 连续崩溃记录
    schedules.json             # 定时任务
./.jade/                       # 项目层（随代码仓库分发）
  config.json                  # 项目层插件配置（只能设标了 project 的键）
  plugins/                     # 项目层插件（首次加载需确认）
```

## 开发

jade 是 uncarved 仓库的一部分，在 monorepo 里开发：

```sh
git clone https://github.com/MochiNek0/uncarved.git
cd uncarved
bun install
bun test                # 运行全部测试
bun run typecheck
bun run build
```

只测 jade：`bun test apps/jade`。在仓库里直接运行源码用 Bun：`bun apps/jade/src/main.ts`。

## 许可证

[MIT](../../LICENSE)
