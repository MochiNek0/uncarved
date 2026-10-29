# 设计：Provider 契约

> 状态：已评审，已实施 · 2026-10-30
>
> 对应条款：第九章（不选模型、不做路由；重试和限流是插件）、5.2 `model.before`、3.3（`ext` 按 providerId 分组）、I-5、I-9

## 1. 问题

宪法第九章说多模型路由是 `model.before` 插件的事，重试和限流也是插件。但现有扩展点做不到：

| 需求 | 为什么现有扩展点做不到 |
|---|---|
| 路由（按请求选模型或厂商） | `model.before` 只能改 `ModelRequest`，而请求里没有"用哪个 provider/模型"的位置；`Runtime` 只持有一个 provider |
| 重试、限流、降级 | 需要包住模型调用本身：失败后再调一次、调用前等待。transform 只在调用前执行一次，调用失败直接结束本轮 |

另外三个实际问题（来自 2026-10-29 用 Agnes 做的端到端测试）：

1. `ModelRequest.ext` 的注释是"给 provider 的私有参数，内核只透传"，但三个 provider 都不读它。发行版想给某家加一个请求字段或请求头，只能改 provider 包。
2. provider 出错只有一个字符串。测试里写重试包装时，只能用正则匹配 `429`。
3. `model.responded` 的 `origin.provider` 取的是 `Runtime` 持有的那个 provider 的 id。如果它是一个路由包装，记下来的是包装的 id，不是实际回复的那一家。

## 2. 结论：Provider 本身就是组合点

不新增扩展点（11.3）。`Provider` 接口已经是内核定义的，一个 Provider 可以包装另一个 Provider：

```
Runtime ──► 重试包装 ──► 路由包装 ─┬─► anthropicProvider
                                    └─► openaiCompatProvider
```

- **意图**由 `model.before` 插件写进 `ext`（例如"这次用便宜的模型"）。插件可以读取会话状态和派生数据，适合做判断。
- **执行**由包装 Provider 完成（选哪一家、失败后重试、限流等待）。它们只看请求和调用结果，不碰会话状态。

这样宪法第九章的"这些是插件的事"仍然成立，只是插件分成两种：hook 插件和 Provider 包装。两者都在内核外。

理由：

- 包住一次调用，最自然的形式就是包装函数。新增一种"around"类 hook（第四种 hook 种类）要改 5.1 的组合规则、超时规则和进程外协议，代价大得多，换来的能力和包装 Provider 一样。
- I-5 要求的是"被使用的非确定性输入必须先入日志"。重试中失败的尝试没有被使用，不需要入日志；最终被使用的响应照常写入 `model.responded`。

## 3. 契约内容

### 3.1 `ModelRequest.ext`

与内容块的 `ext`（3.3）一致，按 providerId 分组：

```ts
ext?: Record<string, unknown>   // ext[providerId] 归该 provider 解释
```

- Provider **必须**读取 `ext[自己的 id]`，不认识的分组原样忽略。
- 包装 Provider 读取自己的分组，并把整个 `ext` 原样传给被包装者。
- 每个分组的具体格式由该 provider 自己定义，内核不规定。本仓库的三个参考 provider 统一用：

  ```ts
  { body?: Record<string, unknown>; headers?: Record<string, string> }
  ```

  `body` 合并进请求体，`headers` 合并进请求头。构造参数提供同名默认值（`extraBody`、`headers`），每次请求的 `ext` 覆盖默认值。`body` 中**不得**出现 provider 根据 `ModelRequest` 生成的字段（消息、系统提示词、工具等），出现时视为出错。`model` 可以覆盖，这样同一家内部切换模型不需要包装。

### 3.2 响应标明实际来源

`ModelResponse` 增加可选字段 `provider`。包装 Provider 必须把被包装者的值传上来；Runtime 用它填 `model.responded` 的 `origin.provider`，没有时退回 `Provider.id`。可选字段，兼容旧实现（8.3）。

### 3.3 出错分类

内核导出：

```ts
class ProviderError extends Error {
  retryable: boolean        // 由 provider 判断，例如 429、5xx、连接中断
  status?: number           // 上游 HTTP 状态码
  retryAfterMs?: number     // 上游给出的建议等待时间
}
```

Provider **应当**用它报告调用失败。包装 Provider 据此决定是否重试，不用解析错误文案。放在内核而不是单独的包里，是因为它是 `Provider` 接口的一部分：不同作者写的 provider 和包装需要共用同一个类型，而它们已经都依赖内核。

### 3.4 取消

包装 Provider 必须把 `signal` 传给被包装者；等待（退避、限流）期间收到取消，必须立即结束（I-9）。

## 4. 修宪草案

第九章第三条改为：

> - 不选择模型，不做多模型路由、重试和限流：由 `model.before` 插件在 `ext` 中给出意图，由包装 Provider 执行（见 4.7）

新增 4.7：

> ### 4.7 Provider
>
> Provider 把模型请求翻译成某个模型接口的调用，它的实现不属于内核，内核只定义接口。
>
> 1. `ModelRequest.ext` 按 providerId 分组。Provider 必须读取自己的分组，不认识的分组原样忽略。
> 2. Provider 可以包装另一个 Provider，用于路由、重试、限流、降级。包装者必须转发取消信号（I-9），并原样传递 `ext`。
> 3. 日志只记录最终被使用的响应（I-5）。响应必须标明实际产生回复的 provider 和模型。
> 4. 调用失败时应当抛出 `ProviderError`，并标明是否可以重试。

版本：0.6 → 0.7。内核侧只增加可选字段和一个导出类型，与现有日志、插件兼容。受影响的是 Provider 的实现者：必须读取 `ext`。

## 5. 评审问题

原则同 5.5：拿不准时先取严格、小的一边。

| # | 问题 | 结论 | 未采用 |
|---|---|---|---|
| 1 | 重试、路由放在哪 | 包装 Provider | 新增 around 类 hook；`Runtime` 内置多个 provider |
| 2 | `ext` 的格式 | 按 providerId 分组，组内格式由 provider 定义 | 内核规定统一格式 |
| 3 | 参考 provider 的 `body` 能否覆盖消息等字段 | 不能，出现即出错 | 允许覆盖（会绕过投影和 I-6 检查） |
| 4 | `ProviderError` 放在哪 | 内核 | 单独的 provider 工具包 |
| 5 | 失败的尝试是否入日志 | 不要求 | 每次尝试都写事件（需要新事件类型，以后可以兼容地增加） |
| 6 | 如何记录实际的 provider | `ModelResponse.provider`，可选 | 让包装 Provider 改写块的 `origin`（块的来源应由产生它的 provider 填写） |

## 6. 不在本次范围

- 流式片段（`Delta`）的粒度：块序号、工具参数的流式片段。以后增加可选字段即可，与本设计无关。
- token 计数（第九章：只提供计量接口，`usage` 已有）。

## 7. 实施步骤

1. 内核：`ProviderError`、`ModelResponse.provider`、Runtime 记录实际来源；`ModelRequest.ext` 的注释改为本约定。
2. 三个参考 provider：读取 `ext`，增加 `extraBody`、`headers`，用 `ProviderError` 报错。顺带修复 Agnes 测试暴露的兼容问题：Responses 回传 `function_call` 时保留 `id`；Anthropic 流中缺少 `stop_reason` 但有 `tool_use` 时按 `tool_use` 处理。
3. 宪法：评审通过后按第 4 节修改，升到 0.7。
