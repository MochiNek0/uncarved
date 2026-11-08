# acme：公司版 jade 的示例插件

演示"不 fork jade，只装插件，把它变成公司自己的 coding agent"。三个都是普通的用户层插件，只用 jade 公开的接口（`tool.gate`、`event` 观察、`approval@1`、`commands@1`），换成你们公司的规则改配置或改代码即可。

| 插件 | 做什么 |
|---|---|
| [`acme/guard`](./guard) | 公司红线：危险命令、密钥文件、工作目录外的写入、白名单外的主机。命中就拒绝，任何模式下都批准不了（拒绝优先）；正在问人的审批会被撤回 |
| [`acme/audit`](./audit) | 审计：记下谁在哪台机器上用；可以把每个事件实时发到公司的审计服务；`/audit` 生成审计报告 |
| [`acme/approval-web`](./approval-web) | 网页审批渠道：要问人时，问题同时出现在终端和一个网页上（手机也能开），先回答的算数，回答的人记进日志。换成飞书、钉钉机器人是同一个接口 |

## 安装

```sh
# 从仓库安装
jade plugins add github:MochiNek0/uncarved --path apps/jade/examples/acme/guard
jade plugins add github:MochiNek0/uncarved --path apps/jade/examples/acme/audit
jade plugins add github:MochiNek0/uncarved --path apps/jade/examples/acme/approval-web

# 或者在本仓库里开发时直接链接
jade plugins add ./apps/jade/examples/acme/guard --link
jade plugins add ./apps/jade/examples/acme/audit --link
jade plugins add ./apps/jade/examples/acme/approval-web --link
```

装在用户层（`$JADE_HOME/plugins`），项目层插件替换不了它们。

## 配置

写在 `$JADE_HOME/config.json`：

```jsonc
{
  "acme/guard": {
    // 加规则，或者把内置规则设成 null 关掉（内置：force-push、delete-everything、upload、file-transfer、publish）
    "denyCommands": { "no-sudo": "\\bsudo\\b", "publish": null },
    // 只许访问这些主机（含子域名）；不设时不限
    "allowedHosts": ["github.com", "acme.internal"],
    // 文件工具只能改工作目录和临时目录（默认 true）
    "confineWrites": true
    // secretFiles：不许读写的文件名（正则），默认包括 .env、*.pem、*.key、id_rsa、.npmrc
  },
  "acme/audit": {
    "employee": "zhang.san",                       // 不设时用系统用户名
    "endpoint": "https://audit.acme.internal/jade" // 不设时只留本地日志
  },
  "acme/approval-web": {
    "host": "0.0.0.0", // 默认 127.0.0.1；设成 0.0.0.0 时同一网络里的手机能打开
    "port": 7788,
    "token": null      // 链接里的密钥；不设时每次启动随机生成
  }
}
```

会话里 `/guard` 列出生效的规则，`/approvals` 显示审批网页的链接（第一个会话打开时也会提示一次）。

## 审计报告

`/audit` 报告当前会话，`/audit <会话 id>` 报告以前的会话，写到 `$JADE_HOME/audit/<id>.md`。每个工具调用都说明是怎么放行或拒绝的：

- 规则自动放行（审批模式、"总是允许"）
- 模型审查后放行（auto 模式）
- **谁经哪个渠道批准或拒绝**（终端，或审批渠道插件，例如飞书机器人返回的 `by`）
- **撞了哪条公司红线**

报告只读会话日志，日志是唯一的事实来源：插件当时在不在、配置后来改没改，都不影响报告。

`endpoint` 收到的是 `POST { "events": [{ "session": "<id>", "event": <日志事件> }] }`，攒一秒发一批，发不出去的下次再发。

## 网页审批

链接里带一个随机 token，没有它什么都看不到。页面上先填名字（记在手机浏览器里），之后点"允许一次""本会话总是允许""拒绝"。
回答记成 `jade/approval/answered` 事件：`channel` 是 `acme/approval-web`，`by` 是 `web:<名字>`，审计报告里写成"allowed once by **web:li.si via acme/approval-web**"。

终端和网页谁先答算谁的，另一边的问题自动撤回。有了这个渠道，`jade -p` 这种不能在终端提问的运行也能等人在网页上批准。

名字是页面上自己填的，拿到链接的人填什么都行：演示够用，正式用要换成有身份认证的渠道（公司 IM 机器人、审批系统），`by` 由它们给出。

## 演示脚本

1. 装上三个插件，`/guard` 看规则，`/approvals` 拿到链接，用手机打开。
2. 让 jade 改个 bug、提交并推送。要审批的调用同时出现在终端和手机上，在手机上点"允许"，终端的问题自动消失。
3. 让它 `git push --force`，或者读 `.env`。直接被拒，模型收到原因，不会弹审批框。
4. Shift+Tab 切到 yolo 再试一次：照样被拒。
5. `/audit`：每一步是谁、在哪个渠道批准的，哪条红线拦下了什么。

## 局限

- `acme/guard` 只看工具的参数。shell 命令里间接的操作（脚本里写的 curl、编码过的命令）它看不出来，真要防得靠沙箱和网络出口管控。
- 用户能用 `jade plugins disable` 停掉这些插件。jade 还没有"管理员层"配置，这是企业部署要补的。
