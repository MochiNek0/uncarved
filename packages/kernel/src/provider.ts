// Provider 的出错分类。对应宪法 4.7，设计见 docs/design/provider-contract.md。

/**
 * 模型调用失败。由 provider 判断能否重试，包装 Provider（重试、降级）据此决定，不用解析错误文案
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  /** 上游 HTTP 状态码 */
  readonly status?: number;
  /** 上游给出的建议等待时间 */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
