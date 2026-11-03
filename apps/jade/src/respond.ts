// 问用户时同时等终端和插件的 responder（见 plugins/loader.ts 的 Responder），用最先到的回答。

export interface Remote<T> {
  plugin: string;
  run(signal: AbortSignal): Promise<T | undefined>;
}

/**
 * 本地（终端）返回 undefined 也算回答（用户取消了）；remote 返回 undefined 或出错表示它这次不回答，继续等别的。
 * 有了回答就中止其余的；谁都不回答时 value 为 undefined。by：回答的插件，本地回答时没有。
 * signal 中止时 reject，并中止所有来源（终端的对话框也关掉）
 */
export async function firstAnswer<T>(
  local: ((signal: AbortSignal) => Promise<T | undefined>) | undefined,
  remote: Remote<T>[],
  opts: { signal?: AbortSignal; onError?: (plugin: string, err: unknown) => void } = {},
): Promise<{ value: T | undefined; by?: string }> {
  const outer = opts.signal;
  outer?.throwIfAborted();
  const ac = new AbortController();
  let fail: (reason: unknown) => void = () => {};
  const stop = () => {
    // 先 reject 再中止：被中止的来源随后给出的 undefined 不算回答
    fail(outer!.reason);
    ac.abort(outer!.reason);
  };
  outer?.addEventListener("abort", stop, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      fail = reject;
      let left = remote.length + (local ? 1 : 0);
      const pass = () => void (--left === 0 && resolve({ value: undefined }));
      if (left === 0) return resolve({ value: undefined });
      local?.(ac.signal).then((value) => resolve({ value }), reject);
      for (const r of remote) {
        Promise.resolve()
          .then(() => (ac.signal.aborted ? undefined : r.run(ac.signal)))
          .then(
            (value) => (value === undefined ? pass() : resolve({ value, by: r.plugin })),
            (err) => {
              if (!ac.signal.aborted) opts.onError?.(r.plugin, err);
              pass();
            },
          );
      }
    });
  } finally {
    outer?.removeEventListener("abort", stop);
    ac.abort();
  }
}
