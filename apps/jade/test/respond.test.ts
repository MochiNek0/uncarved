import { describe, expect, test } from "bun:test";
import { firstAnswer, type Remote } from "../src/respond.ts";

/** 等到 signal 中止才结束的来源；记下是否被中止 */
function waiting<T>(log: string[], name: string) {
  return (signal: AbortSignal) =>
    new Promise<T | undefined>((resolve) => signal.addEventListener("abort", () => (log.push(`${name} aborted`), resolve(undefined)), { once: true }));
}
const after = <T,>(ms: number, value: T | undefined) => () => new Promise<T | undefined>((r) => setTimeout(() => r(value), ms));

describe("firstAnswer", () => {
  test("a remote answer wins over a waiting terminal and closes it", async () => {
    const log: string[] = [];
    const got = await firstAnswer<string>(waiting(log, "local"), [{ plugin: "phone", run: after(5, "yes") }]);
    expect(got).toEqual({ value: "yes", by: "phone" });
    expect(log).toEqual(["local aborted"]);
  });

  test("the terminal's cancel counts as an answer; remotes are aborted", async () => {
    const log: string[] = [];
    const got = await firstAnswer<string>(after(5, undefined), [{ plugin: "phone", run: waiting(log, "phone") }]);
    expect(got).toEqual({ value: undefined });
    expect(log).toEqual(["phone aborted"]);
  });

  test("a remote that passes or fails is skipped; the next one answers", async () => {
    const errors: string[] = [];
    const remote: Remote<string>[] = [
      { plugin: "a", run: after(1, undefined) },
      { plugin: "b", run: async () => Promise.reject(new Error("offline")) },
      { plugin: "c", run: after(10, "ok") },
    ];
    const got = await firstAnswer<string>(undefined, remote, { onError: (p, e) => errors.push(`${p}: ${(e as Error).message}`) });
    expect(got).toEqual({ value: "ok", by: "c" });
    expect(errors).toEqual(["b: offline"]);
  });

  test("nobody answers without a terminal when every remote passes", async () => {
    expect(await firstAnswer<string>(undefined, [])).toEqual({ value: undefined });
    expect(await firstAnswer<string>(undefined, [{ plugin: "a", run: after(1, undefined) }])).toEqual({ value: undefined });
  });

  test("aborting the outer signal rejects and aborts every source", async () => {
    const log: string[] = [];
    const ac = new AbortController();
    const got = firstAnswer<string>(waiting(log, "local"), [{ plugin: "phone", run: waiting(log, "phone") }], { signal: ac.signal });
    await Promise.resolve();
    ac.abort(new Error("interrupted"));
    await expect(got).rejects.toThrow("interrupted");
    expect(log.sort()).toEqual(["local aborted", "phone aborted"]);
  });
});
