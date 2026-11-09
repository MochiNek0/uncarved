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
jade -c                    # 继续最近一次会话
jade --resume <id>         # 恢复指定会话
jade --safe                # 只加载自带的插件（排查故障用）
jade -v                    # 打印版本
```

会话里的斜杠命令（由对应插件提供）：`/clear` `/resume` `/retry` `/mode` `/model` `/plugins` `/mcp` `/skills` `/memory` `/undo` `/search` `/compact` `/schedule` `/suggest` `/checks` `/help` `/exit`。

连续两次 Ctrl+C（2 秒内）直接退出，不经过任何插件——插件出问题时你一定能停下来。

## 权限

jade 默认在改动前问你。模式由 `jade/approval` 插件提供，用 Shift+Tab 或 `/mode` 切换，`ask` / `auto` / `readonly` 会记到 `$JADE_HOME/mode.json`：

| 模式 | 行为 |
|---|---|
| `ask`（默认） | 改动前询问 |
| `auto` | 工作目录内的改动和无害命令直接放行；规则判断不了的先让模型审，仍拿不准再问你 |
| `plan` | 不改任何东西，只给出计划 |
| `readonly` | 不改任何东西 |
| `yolo` | 从不询问 |

安全性靠三条：**拒绝优先**（任何一个插件的拒绝都不能被推翻）、**兜底关卡**（审批插件不在场时核心拒绝所有写操作，而不是放行）、**层级**（项目层插件换不掉你的审批、模型配置和前端）。审批插件坏掉的结果是"什么都改不了"，不是"什么都放行"。

## 会话与恢复

每个会话是一条只追加的事件日志，内核状态完全由日志重建。进程退出后会话仍在，`jade -c` 或 `jade --resume <id>` 接着跑。会话索引在 `$JADE_HOME/state/sessions.jsonl`。崩溃恢复时，未完成的幂等工具会重跑，其余中断的工具交给你或插件决定，内核不自动重试。

## 插件

jade 自带的功能全是 `apps/jade/plugins/` 下的普通插件，和第三方插件走同一套加载流程。几个代表：

| 插件 | 提供的能力 |
|---|---|
| `jade/tui`、`jade/print` | 终端界面、`-p` 非交互模式 |
| `jade/fs`、`jade/shell` | 文件读写、运行命令（`shell@1` 供其他插件调用） |
| `jade/web` | `web_fetch`、`web_search`、`/search` |
| `jade/models` | 模型路由、`/model`、`provider@1` |
| `jade/approval` | 权限审批、模式、审查 |
| `jade/modes` | 模式切换、计划模式 |
| `jade/compact` | 上下文压缩、溢出后自动重试 |
| `jade/task` | 子 Agent（嵌套 Runtime） |
| `jade/mcp` | MCP 服务工具 |
| `jade/skills`、`jade/memory` | 技能目录、长期记忆 |
| `jade/schedule` | 定时任务（cron，重启后仍生效） |
| `jade/screenshot` | 无头浏览器截图交给模型看 |

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

不加 `--project` 装到 `$JADE_HOME`（`$JADE_HOME/skills/<名字>`、`$JADE_HOME/mcp.json`），加了装到当前工作目录（`.jade/skills/<名字>`、`.jade/mcp.json`）。一个仓库里有多个 skill 时（例如 `anthropics/skills`），不加 `--path` 会列出它们，用 `--path skills/pdf` 选一个。`jade skills update` 不覆盖装好后手动改过的 skill，除非加 `--force`。新装的 skill 马上生效，运行中的 jade 从下一步起就能用，不用 `/clear` 或重启；新加的 MCP 服务重启 jade 后生效，项目层的服务第一次启动前仍然要你确认。会话里同样可以用 `/skills add …`、`/mcp add …`。

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
import { definePlugin } from "@uncarved/jade";

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
| `JADE_SEARCH` | `.env` | 搜索服务顺序，逗号分隔 |
| `JADE_SEARCH_RESULTS` | `.env` | 每次搜索返回条数，默认 10 |
| `JADE_SHELL` | shell | shell 工具用的 shell，默认 bash（Windows 上是 Git Bash） |
| `JADE_BROWSER` | shell | screenshot 工具用的浏览器（Chrome / Edge / Chromium） |
| `JADE_AUTO_UPDATE` | shell | 设为 `off` 关闭后台自动升级 |
| `JADE_UPDATE_CHECK` | shell | 设为 `off` 不检查更新 |
| `HTTPS_PROXY` / `HTTP_PROXY` | shell | 模型和 web 请求走代理（Node.js 版本太旧、不支持时启动时会提示；Bun 都支持） |

权限模式和压缩阈值是插件配置，写在 `$JADE_HOME/config.json`，例如 `{"jade/approval": {"mode": "auto"}, "jade/compact": {"thresholdTokens": "120k"}}`。会话里用 Shift+Tab 或 `/mode` 选的模式记在 `mode.json`，比配置优先（见上文"权限"）。等审批回答的时限默认 24 小时，过了按拒绝处理，可用 `{"jade/approval": {"askTimeoutMinutes": 30}}` 改短（最长一周）。

网络搜索可选配置多家服务的 key（`TAVILY_API_KEY`、`JINA_API_KEY`、`EXA_API_KEY` 等），配了 key 的服务按顺序试；一个 key 都不设时只有 `web_fetch`，没有 `web_search`。完整列表见 [.env.example](https://github.com/MochiNek0/uncarved/blob/main/.env.example)。

## 目录布局

```
~/.jade/                       # $JADE_HOME：用户层
  .env                         # 模型配置（/model 也写这里）
  config.json                  # 用户层插件配置
  mode.json                    # 当前权限模式
  plugins/                     # 用户层插件
  state/
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
