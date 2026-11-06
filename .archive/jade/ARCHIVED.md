# 已归档：jade 0.1.3

这是旧 jade 的最后一个版本（npm 上的 `@uncarved/jade@0.1.3`），2026-11-05 归档。新的 jade 在 `apps/jade`，设计见 `docs/design/jade.md`，第 1 节写了为什么重写。

这里的代码不再维护，也不参与构建、测试和类型检查（bun test 会跳过以点开头的目录）。保留它是为了把功能逐个移植到新 jade 时对照。

| 位置 | 内容 |
|---|---|
| `src/`、`test/`、`docs/`、`examples/`、`bin/` | 原 `apps/jade` |
| `design/` | 原 `docs/design/jade-host-extensibility.md`、`jade-plugin-lifecycle.md` |
| `smoke-jade-node.mjs` | 原 `scripts/smoke-jade-node.mjs`（CI 的 `smoke:jade`） |

依赖已经不在 workspace 里，要运行这份代码，请检出归档前的提交 `a8e1051`。
