# @uncarved/jade

基于 [uncarved](https://www.npmjs.com/package/uncarved) 内核的编程 Agent 命令行工具：读写文件、搜索代码、执行命令、联网查资料，改动前按权限模式请求确认。

## 安装

需要 **Node.js 22.18** 或更高版本，或者 [Bun](https://bun.sh) 1.3.9 或更高版本。

```sh
npm install -g @uncarved/jade
# 或者不安装直接运行
npx @uncarved/jade

# 用 Bun
bun add -g @uncarved/jade
bunx @uncarved/jade
```

只装了 Bun、没装 Node 时，用 `bunx --bun @uncarved/jade` 运行（`jade` 命令的启动脚本默认找 `node`）。这种方式下 Bun 会自动读取当前目录的 `.env`，里面如果有模型相关的变量，会覆盖 `~/.jade/.env` 里的配置。

Windows 上 `bash` 工具需要 [Git for Windows](https://git-scm.com/download/win)，没装时这个工具不可用，其他功能照常。

可选：装了 [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）时搜索更快，没有时自动改用内置搜索。

> npm 上另有一个同名的旧模板引擎 `jade`（Pug 的前身），它也提供 `jade` 命令。两个都全局安装时会冲突。

## 配置模型

第一次运行时，在 jade 里输入 `/model` 按提示配置，结果会写进 `~/.jade/.env`。也可以手动编辑这个文件，三种服务选一种：

```sh
# Claude
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-opus-5-5

# OpenAI Responses API
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5

# 任意兼容 /chat/completions 的服务（三项都要填）
OPENAI_COMPAT_BASE_URL=...
OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_MODEL=...
```

同时配了多种时用 `JADE_PROVIDER=anthropic | openai | openai-compat` 指定。其他选项（输出上限、思考力度、上下文窗口、网络搜索、代理）见仓库里的 [`.env.example`](https://github.com/MochiNek0/uncarved/blob/main/.env.example)。

jade 不读当前目录的 `.env`，因为那是你正在操作的项目自己的配置。shell 里已经设置的环境变量优先于 `~/.jade/.env`。

用 `/model` 配置过的服务和模型都记在 `~/.jade/models.json` 里：同一个服务（类型、地址、密钥都相同）只存一份，下面是在它上面用过的模型，每个模型带自己的输出上限、思考力度和上下文窗口。`/model` 的菜单里可以直接切回之前的模型，也可以用 `/model <模型名>` 切换；在同一个服务上加新模型时沿用输出上限和思考力度，上下文窗口按模型名重新推断。`~/.jade/.env` 里始终是当前在用的那一个。输出上限、上下文窗口这些 token 数可以写成 `512K`、`1M`。

## 用法

```sh
jade                      # 交互式会话
jade "修复失败的测试"       # 带着第一条消息开始
jade -p "总结这个仓库"      # 运行一条消息后退出，结果输出到 stdout
jade -c                   # 继续当前目录最近的会话
jade -r [id]              # 恢复指定会话，不带 id 时从列表里选
jade -m <mode>            # 权限模式，默认 ask
jade --cwd <dir>          # 指定工作目录
jade plugin <命令>         # 安装、更新、卸载、停用插件，见下文「插件」
```

会话里输入 `/` 可以看到全部命令，常用的有 `/model`、`/mode`、`/undo`、`/compact`、`/resume`、`/memory`。`@` 引用文件，`esc` 中断，连按两次 `ctrl+c` 退出。jade 工作时可以继续输入，消息会排队，当前这一轮结束后发送。

- **权限模式**：`ask`（默认，改动和命令先问）、`auto-edit`（直接改文件，`mkdir`、`touch` 也不问，其他命令先问）、`plan`（只读调研并给出计划，你批准后切到 `auto-edit` 或 `ask` 开始执行）、`yolo`、`readonly`。`shift+tab` 在 ask → auto-edit → plan 之间切换。
- **自动放行的命令**：只读命令（`ls`、`cat`、`grep`/`rg`、`find`（不带 `-exec`/`-delete`）、`sed -n '10,20p'`、`git status/diff/log/show/…`、`--version` 等）在所有模式下（包括 plan、readonly）都不问，包括用 `&&`、`||`、`|`、`;` 连起来的命令、`2>&1`、`>/dev/null` 和 `cd 子目录 && …`。碰到工作目录之外的路径、写文件的重定向或不认识的语法时照常先问。"总是允许"某条命令后，它出现在复合命令里（`bun test 2>&1 | tail -20`）也不再问。
- **审批**：修改文件时显示带行号和上下文的 diff；`write_file` 覆盖已有文件时显示和原内容的差异。
- **撤销**：`/undo` 恢复上一轮里改过的所有文件，再执行一次继续往前撤销。
- **上下文**：不设 `JADE_CONTEXT_WINDOW` 时按模型名推断窗口，认不出的按 128000 算；请求因为超长被拒时会自动压缩历史再重试一次。状态栏显示上下文用量、自动压缩的阈值、输出速度（tok/s）和本会话累计的 token。
- **重试和限速**：请求失败（限流、服务端错误、连接中断）时最多重试 9 次，等待时间逐次变长（2s、5s、10s … 最长 3 分钟），服务端给了 `Retry-After` 时按它的。主 Agent、子 Agent 和压缩共用同一个限速：被限流时所有请求一起等；`/model` → Requests per minute（`JADE_RPM`）设了上限时请求平均分布在一分钟里，没设时被限流后按当时一分钟内的请求数自动放慢。免费模型一般设 `JADE_RPM=20` 左右。
- **思考**：模型思考时对话里只占一行，实时显示它想到了哪里；点击这一行展开全文（思考中也可以）。

## 编辑后自动检查

模型一次回复里改了文件，jade 在下一次请求模型之前对这批文件跑一遍项目的检查，把问题附在最后一处修改的结果后面，模型能马上修掉自己引入的错误。只报告改过的文件里的问题，以及其他文件里比上一次检查多出来的问题（例如改了函数签名，调用方报错）。

自动发现的检查：

| 文件 | 条件 | 命令 |
|---|---|---|
| `.ts` `.tsx` `.js` 等 | 往上能找到 `tsconfig.json`，且项目里装了 `typescript` | `tsc --noEmit -p <tsconfig 所在目录>`（增量编译，缓存在 `~/.jade/cache`） |
| `.py` | PATH 里有 `ruff` | `ruff check <文件>` |
| `.go` | 往上能找到 `go.mod`，PATH 里有 `go` | `go vet <包>` |

其他检查写在仓库根目录的 `.jade/checks.json` 或 `~/.jade/checks.json`。命令里的 `{files}` 换成改过的文件，`{dirs}` 换成它们所在的目录（相对于 `cwd`）。配置了某类文件的检查后，这类文件不再自动发现；`"auto": false` 关掉全部自动发现：

```json
{
  "checks": [
    { "name": "eslint", "command": "npx eslint --format unix {files}", "extensions": [".ts", ".tsx"] },
    { "name": "cargo", "command": "cargo check --message-format short", "extensions": [".rs"], "cwd": "crates/core", "timeout_ms": 300000 }
  ]
}
```

检查会执行仓库里的代码，所以每条命令第一次运行前会请你确认，确认结果按项目记住（yolo 模式不问，`-p` 等非交互运行时不运行未确认的检查）。`/checks` 查看会运行哪些检查，`/checks off`、`/checks on` 在本会话里关闭或重新打开；`JADE_CHECKS=off` 完全关闭。超时或者失败了却认不出问题位置的检查，本会话里只报告一次就停用。

## 自定义命令

`~/.jade/commands/<name>.md`（所有项目）和 `.jade/commands/<name>.md`（随仓库，从仓库根目录到工作目录逐级查找，近的覆盖远的）里的每个文件都是一个斜杠命令 `/<name>`，内容就是发给模型的提示词：

```markdown
---
description: 审查当前的改动
argument-hint: [文件或目录]
---
审查 $ARGUMENTS 里未提交的改动，指出 bug 和可以简化的地方。
```

`$ARGUMENTS` 换成命令后面的全部参数，`$1`…`$9` 换成第几个参数；正文里没有占位符时参数接在末尾。和内置命令同名的不生效。`jade -p "/review src"` 也可以用。命令在启动时读取。

## MCP

jade 可以连接 [MCP](https://modelcontextprotocol.io) 服务，把它们的工具交给模型使用（GitHub、数据库、浏览器等现成的服务都可以）。配置格式和 Claude Code 的 `.mcp.json` 相同：

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

- 配置文件：`~/.jade/mcp.json`（所有项目），仓库根目录的 `.mcp.json`，以及仓库根目录到工作目录每一级的 `.jade/mcp.json`。同名的服务，近的覆盖远的。
- 支持 stdio 和 Streamable HTTP 两种传输，不支持旧的 HTTP+SSE。`${VAR}`、`${VAR:-默认值}` 会换成环境变量；没设置又没有默认值时跳过这个服务。
- jade 的扩展字段：
  - `"disabled": true`：不连接这个服务。
  - `startupTimeoutMs`：启动的超时，默认 30 秒。
  - `toolTimeoutMs`：单次工具调用的超时，默认 10 分钟。
- 工具名是 `mcp__<服务>__<工具>`。服务声明为只读（`readOnlyHint`）的工具按只读处理，ask 模式下不问，子 Agent 也能用；其他工具在 ask 和 auto-edit 模式下都先问。
- 随仓库分发的服务（`.mcp.json`、`.jade/mcp.json`）第一次启动前要你确认，配置变了要重新确认。确认的是配置本身（命令、参数、地址），不包括命令运行的脚本内容。
- 服务在 jade 启动时连接，连不上的跳过并提示。进程退出后，下一次调用它的工具时自动重连。
- `/mcp` 查看各服务的状态和工具；`/mcp reconnect <name>` 重新连接。服务的工具列表变了，要到下一个会话（`/clear`）才生效。

## Skills

skill 是打包好的做事方法：一个目录，入口是 `SKILL.md`，旁边可以放脚本、模板、参考资料。格式和 Claude Code、Agent Skills 相同：

```markdown
---
name: release
description: 发布新版本。用户要求发版、打 tag 时使用
---
1. 运行 scripts/check.sh……
```

- 查找位置：
  - 用户层：`~/.claude/skills/<name>/`、`~/.jade/skills/<name>/`。
  - 项目层：仓库根目录到工作目录每一级的 `.claude/skills/<name>/`、`.jade/skills/<name>/`。
  - 同名的，后面的覆盖前面的。
- 系统提示词里只列出每个 skill 的名字和描述。模型判断任务用得上时，调用 `skill` 工具读入正文，所以装很多 skill 也不怎么占上下文。
- skill 目录里的文件，模型可以直接读取，不用确认。运行其中的脚本仍然按权限模式确认。
- `/<skill 名> [要做的事]` 直接要求模型使用某个 skill；`/skills` 列出所有 skill。
- skill 在启动时读取，改了描述要重启 jade；正文每次调用时重新读取。

## 插件

插件可以给 jade 加上工具、斜杠命令、挂在扩展点上的 hook（例如拦截某些修改、给工具输出脱敏、往提示词里加内容），也可以只带 skills、命令和 MCP 服务配置。

```sh
jade plugin add github:someone/jade-plugin   # git 仓库（任何 git 地址，#分支/#tag/#提交），npm 包，或本地目录
jade plugin add ./my-plugin --link           # 开发插件时链接本地目录
jade plugin list                             # 内置插件和装了的插件
jade plugin update [名字]
jade plugin remove <名字>
jade plugin disable jade/web                 # 停用插件，包括内置插件
```

- 默认装进 `~/.jade/plugins/<name>/`，所有项目都加载；加 `--project` 装进仓库的 `.jade/plugins/<name>/`，随仓库分发。项目层的插件第一次加载和内容变化后要你确认，确认记录按内容哈希保存。
- 只带 skills、命令、MCP 服务的 Claude Code 插件（`.claude-plugin/plugin.json`）也能直接安装；它们的 hooks 和 agents 还不支持。
- jade 自己的功能（文件工具、shell、web、记忆、子 Agent、skills、MCP、编辑后检查、压缩……）也是插件，可以停用，也可以由第三方插件代替；只有负责审批的 `jade/policy` 不能。
- 插件可以是 TypeScript/JavaScript 模块（`index.ts`），也可以是任何语言写的独立进程（在 `plugin.json` 里写启动命令，经 stdio 用 JSON-RPC 通信）。
- `/plugins` 查看插件的状态，`/hooks` 查看各扩展点的执行顺序。插件在启动时加载，装了、改了要重启 jade。

开发插件见 [docs/plugins.md](docs/plugins.md)，示例在 [examples/plugins](examples/plugins)。

## 数据和指令文件

- 数据目录默认是 `~/.jade`，可以用 `JADE_HOME` 改：里面有模型配置、会话记录、输入历史和跨会话的记忆。
- 指令从 `$JADE_HOME` 以及仓库根目录到工作目录之间的 `AGENTS.md`（或 `CLAUDE.md`）读取。

## 作为库使用

包的入口导出了 jade 的工具、插件和 `createJade`，可以用来组装自己的 Agent。这些接口还没有稳定，0.x 版本之间可能会变。

## 许可证

MIT
