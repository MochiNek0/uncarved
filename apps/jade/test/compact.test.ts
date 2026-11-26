// jade/compact：清理旧的工具输出、总结、/compact、上下文溢出后压缩重试。
// 从旧 jade 的 test/jade.test.ts（compaction、context window）和 test/turns.test.ts（overflow）移植，在真实的会话里测。

import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Message } from "uncarved";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands, Renderers } from "@uncarved/jade-api/services";
import { compactor, compactThreshold, DEFAULT_CACHE, DERIVED_KEY, estimateTokens, isContextOverflow, parseTokens, TRIMMED, trimPaysOff, type CompactState } from "../plugins/compact/compact.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";
import { plain as plainText } from "../plugins/tui/screen.ts";
import type { Text } from "@uncarved/jade-api";
/** 插件给的是带样式的文字（Text）：只比文字 */
const shown = (r: unknown) => plainText(r as Text);

afterEach(cleanup);

const OVERFLOW = "prompt is too long: 210000 tokens > 200000 maximum";

describe("jade/compact helpers", () => {
  test("images and PDFs are estimated by kind, not by the size of their base64 data", () => {
    const media = (kind: "image" | "document", bytes: number): Message => ({
      role: "user",
      content: [
        {
          kind: "tool_result",
          toolUseId: "t",
          isError: false,
          content: [{ kind, source: { type: "base64", media_type: "x", data: "A".repeat((bytes * 4) / 3) }, origin: { by: "tool", name: "read_file" }, trust: "untrusted" }],
          origin: { by: "runtime" },
          trust: "untrusted",
        } as Block,
      ],
    });
    expect(estimateTokens([media("image", 500_000)])).toBeLessThan(2_000);
    expect(estimateTokens([media("document", 3_000_000)])).toBeGreaterThan(50_000);
  });

  test("estimates ignore fields that are not sent: origin, trust and the provider's raw copy in ext", () => {
    const text = "x".repeat(4000);
    const plain: Message = { role: "assistant", content: [{ kind: "text", text, origin: { by: "runtime" }, trust: "trusted" }] };
    const withExt: Message = {
      role: "assistant",
      content: [{ kind: "text", text, origin: { by: "model", provider: "anthropic", model: "m" }, trust: "trusted", ext: { anthropic: { type: "text", text } } }],
    };
    expect(estimateTokens([withExt])).toBe(estimateTokens([plain]));
    // 工具参数里同名的键照常计入
    const use = (input: unknown): Message => ({ role: "assistant", content: [{ kind: "tool_use", id: "t", name: "x", input, origin: { by: "runtime" }, trust: "trusted" }] });
    expect(estimateTokens([use({ origin: text })])).toBeGreaterThan(1000);
    // opaque 块的内容全在 ext 里
    const opaque: Message = { role: "assistant", content: [{ kind: "opaque", origin: { by: "runtime" }, trust: "trusted", ext: { p: { data: text } } }] };
    expect(estimateTokens([opaque])).toBeGreaterThan(1000);
  });

  test("recognizes context overflow errors", () => {
    expect(isContextOverflow(OVERFLOW)).toBe(true);
    expect(isContextOverflow("This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.")).toBe(true);
    expect(isContextOverflow("400 context_length_exceeded")).toBe(true);
    expect(isContextOverflow("Your input exceeds the context window of this model.")).toBe(true);
    expect(isContextOverflow("Rate limit reached: too many tokens per minute")).toBe(false);
    expect(isContextOverflow("invalid api key")).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });

  test("the threshold leaves room for the reply; token counts in config", () => {
    expect(compactThreshold(200_000, 64_000)).toBe(136_000);
    expect(compactThreshold(200_000, 8_000)).toBe(160_000);
    expect(compactThreshold(32_768, 32_000)).toBe(16_384);
    expect(parseTokens("120k")).toBe(120_000);
    expect(parseTokens(5000)).toBe(5000);
    expect(parseTokens("1.5m")).toBe(1_500_000);
    expect(parseTokens("lots")).toBeUndefined();
    expect(parseTokens(-1)).toBeUndefined();
  });
});

describe("jade/compact in a session", () => {
  test("projected() is the number the compaction decision used: the real usage of the previous request when there is one", async () => {
    const c = compactor({ complete: () => Promise.reject(new Error("no summary expected")), threshold: () => 1_000_000, writes: () => undefined });
    const hook = { sessionId: "s", signal: new AbortController().signal, derived: {}, record: async () => {}, emit: async () => {} };
    const text = (role: Message["role"], t: string): Message => ({ role, content: [{ kind: "text", text: t, origin: { by: "user" }, trust: "trusted" }] });
    const first = [text("user", "hello")];
    expect(c.projected()).toBeUndefined();
    await c.project(first, hook);
    expect(c.projected()).toBe(estimateTokens(first));
    c.observe({ type: "model.responded", data: { usage: { inputTokens: 50_000, outputTokens: 10 } } } as never);
    const next = [...first, text("assistant", "hi"), text("user", "more")];
    await c.project(next, hook);
    expect(c.projected()).toBe(50_010 + estimateTokens(next.slice(2)));
  });

  test("old large tool output is cleared first, judged by the real usage of the previous request", async () => {
    const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/compact": { thresholdTokens: 12_000 } } });
    const big = Array.from({ length: 800 }, () => "a".repeat(40)).join("\n");
    await writeFile(path.join(cwd, "big.txt"), big);
    // 估算只有约 9k，真实用量 15k 超过阈值
    shared.script.push(use("u1", "read_file", { path: "big.txt" }), say("read", { inputTokens: 15_000, outputTokens: 10 }), say("ok"));
    const s = await host.sessions.open();
    await send(s, "read it");
    expect(estimateTokens(shared.requests[1]!.messages)).toBeLessThan(12_000);
    await send(s, "next");

    // 没有调用总结，只清理了旧的工具输出
    expect(shared.requests).toHaveLength(3);
    expect(textOf(shared.requests[2]!.messages[2]!.content)).toBe(TRIMMED);
    expect(s.state.derived[DERIVED_KEY] as CompactState).toEqual({ upTo: 0, summary: "", trimUpTo: 3 });
    expect((await s.history()).filter((e) => e.type === "jade/compact/trimmed")).toHaveLength(1);
  });

  test("old tool output is cleared early at trimAt, well below the threshold, only when that saves enough", async () => {
    const recorded: unknown[] = [];
    const hook = { sessionId: "s", signal: new AbortController().signal, derived: {} as Record<string, unknown>, record: async (_k: string, v: unknown) => void recorded.push(v), emit: async () => {} };
    const c = compactor({ complete: () => Promise.reject(new Error("no summary expected")), threshold: () => 1_000_000, trimAt: () => 10_000, writes: () => undefined });
    const blk = (text: string) => ({ kind: "text" as const, text, origin: { by: "user" as const }, trust: "trusted" as const });
    // 一次读取：assistant 调用 + 约 3k token 的工具结果
    const read = (i: number): Message[] => [
      { role: "assistant", content: [{ kind: "tool_use", id: `t${i}`, name: "read_file", input: {}, origin: { by: "runtime" }, trust: "trusted" }] },
      { role: "user", content: [{ kind: "tool_result", toolUseId: `t${i}`, content: [blk("x".repeat(12_000))], isError: false, origin: { by: "runtime" }, trust: "trusted" }] },
    ];
    const history = (n: number) => [{ role: "user" as const, content: [blk("review it")] }, ...Array.from({ length: n }, (_, i) => read(i)).flat()];

    // 约 9k：没到 trimAt
    expect(await c.project(history(3), hook)).toEqual(history(3));
    // 约 15k：超过 trimAt，保留最近约 4k，清理更早的
    const out = await c.project(history(5), hook);
    expect(recorded).toHaveLength(1);
    const state = recorded[0] as CompactState;
    expect(state.upTo).toBe(0);
    expect(state.summary).toBe("");
    expect(textOf(out[2]!.content)).toBe(TRIMMED);
    expect(textOf(out.at(-1)!.content)).not.toBe(TRIMMED);
    // 清理之后只多了一次读取：省不下一半，先不再清理（不让每一步都破坏提示缓存）
    hook.derived[DERIVED_KEY] = state;
    await c.project(history(6), hook);
    expect(recorded).toHaveLength(1);

    // 历史大多不是工具输出（约 10k 的用户消息加两次读取）：能清理的不到一半，重写缓存不划算，不清理
    const wordy = [{ role: "user" as const, content: [blk("y".repeat(40_000))] }, ...read(0), ...read(1)];
    hook.derived = {};
    expect(await c.project(wordy, hook)).toEqual(wordy);
    expect(recorded).toHaveLength(1);
  });

  test("early clearing pays off within about ten requests: the cheaper cached input is, the more it has to save", () => {
    const at = (read: number, write = 1) => ({ read, write });
    // 那次实际的会话：100k 时只能省 35.6k
    expect(trimPaysOff(100_000, 35_600, DEFAULT_CACHE)).toBe(false);
    expect(trimPaysOff(100_000, 35_600, at(1 / 5))).toBe(true);
    // 省下七成：缓存价 1/20 时划算，1/50 时不划算；Anthropic 写入加价 25% 时也不划算
    expect(trimPaysOff(100_000, 70_000, at(1 / 20))).toBe(true);
    expect(trimPaysOff(100_000, 70_000, at(1 / 50))).toBe(false);
    expect(trimPaysOff(100_000, 70_000, at(1 / 20, 1.25))).toBe(false);
    // 缓存不打折：清理没有代价
    expect(trimPaysOff(100_000, 1_000, at(1))).toBe(true);
    expect(trimPaysOff(100_000, 0, at(1))).toBe(false);
  });

  test("early clearing uses the cache price configured in jade/cost for the current model", async () => {
    const run = async (prices?: object) => {
      const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/compact": { trimTokens: "3k" }, ...(prices ? { "jade/cost": { prices } } : {}) } });
      const big = Array.from({ length: 100 }, () => "a".repeat(40)).join("\n");
      for (const n of [1, 2, 3]) await writeFile(path.join(cwd, `f${n}.txt`), big);
      shared.script.push(use("r1", "read_file", { path: "f1.txt" }), use("r2", "read_file", { path: "f2.txt" }), use("r3", "read_file", { path: "f3.txt" }), say("done"));
      await send(await host.sessions.open(), "go");
      // 第 4 次请求（约 3.6k）超过 3k，清理最早的两次读取能省一半多一点
      return textOf(shared.requests[3]!.messages[2]!.content);
    };
    // 不知道单价：按 1/20 算，省一半回本要十几次请求，不清理
    expect(await run()).not.toBe(TRIMMED);
    // 缓存价是原价的 1/4：几次请求就回本，清理
    expect(await run({ s1: { input: 1, output: 4, cacheRead: 0.25 } })).toBe(TRIMMED);
  });

  test("sub-agents neither clear old tool output early nor get summarized: each clearing would invalidate the whole prompt cache", async () => {
    const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/compact": { trimTokens: "3k" } } });
    const big = Array.from({ length: 100 }, () => "a".repeat(40)).join("\n");
    for (const n of [1, 2, 3]) await writeFile(path.join(cwd, `f${n}.txt`), big);
    shared.script.push(
      use("t", "task", { description: "read files", prompt: "read the files" }),
      use("r1", "read_file", { path: "f1.txt" }),
      use("r2", "read_file", { path: "f2.txt" }),
      use("r3", "read_file", { path: "f3.txt" }),
      say("report"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    // 子 Agent 的第 4 次请求（约 3.6k）超过 3k：照样不清理，也没有调用总结
    const child = shared.requests[4]!.messages;
    expect(textOf(child[2]!.content)).not.toBe(TRIMMED);
    expect(textOf(child.at(-1)!.content)).not.toBe(TRIMMED);
    expect(shared.requests).toHaveLength(6);
  });

  test("/compact summarizes before the next request; the summary is recorded once and reused after resume", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(say("A"), say("B"));
    const s = await host.sessions.open();
    await send(s, "first");
    await send(s, "second");

    const compact = host.service<Commands>("commands@1")!.get("compact")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    expect(shown(await compact.run("keep the API decisions", c))).toContain("will be compacted");
    shared.script.push(say("SUMMARY"), say("C"));
    await send(s, "third");

    // 总结沿用上一次请求的系统提示词、工具和消息（读主对话的缓存），只在最后一条 user 消息后面追加要求
    const summarizer = shared.requests[2]!;
    const before = shared.requests[1]!;
    expect(summarizer.system).toEqual(before.system);
    expect(summarizer.tools).toEqual(before.tools);
    expect(summarizer.tools.length).toBeGreaterThan(0);
    expect(summarizer.messages.slice(0, before.messages.length)).toEqual(before.messages);
    const asking = summarizer.messages.at(-1)!;
    expect(asking.role).toBe("user");
    expect(textOf(asking.content)).toStartWith("third");
    expect(textOf(asking.content)).toContain("Do not call any tools");
    // 命令后面写的话交给总结
    expect(textOf(asking.content)).toContain("pay particular attention to: keep the API decisions");
    const main = shared.requests[3]!;
    expect(textOf(main.messages[0]!.content)).toContain("SUMMARY");
    expect(main.messages.length).toBeLessThan(s.state.messages.length);
    const compacted = s.state.derived[DERIVED_KEY] as CompactState;
    expect(compacted.summary).toStartWith("SUMMARY");
    // 用户的原话原样带上
    expect(compacted.summary).toContain("verbatim:\n> first");
    expect(compacted.summary).toContain("read a file again before editing it");
    expect((await s.history()).filter((e) => e.type === "jade/compact/compacted")).toHaveLength(1);
    expect(shown(host.service<Renderers>("renderers@1")!.forEvent("jade/compact/compacted")!.renderer.render({ from: 0, upTo: 1, before: 99 })!.line)).toContain("compacted 1 messages");

    // 恢复后直接使用日志里的摘要，不再调用总结
    const id = s.id;
    await host.sessions.close();
    const resumed = await host.sessions.open({ resume: id });
    shared.script.push(say("D"));
    await send(resumed, "fourth");
    expect(shared.requests).toHaveLength(5);
    expect(textOf(shared.requests[4]!.messages[0]!.content)).toContain("SUMMARY");
  });

  test("when the model answers the in-place summary request without text, a separate summary request is made", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(say("A"));
    const s = await host.sessions.open();
    await send(s, "first");
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    await host.service<Commands>("commands@1")!.get("compact")!.command.run("", c);
    shared.script.push(use("x", "read_file", { path: "a.txt" }), say("SUMMARY"), say("B"));
    await send(s, "second");
    // 沿用缓存的那次、单独的那次、主会话
    expect(shared.requests).toHaveLength(4);
    expect(shared.requests[2]!.tools).toEqual([]);
    expect(textOf(shared.requests[2]!.messages[0]!.content)).toContain("<transcript>");
    expect((s.state.derived[DERIVED_KEY] as CompactState).summary).toStartWith("SUMMARY");
  });

  test("a request that overflows the context window is compacted and retried once per input", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(say("A"), say("B"), { error: OVERFLOW }, say("SUMMARY"), say("C"));
    const s = await host.sessions.open();
    await send(s, "first");
    await send(s, "second");
    await send(s, "third");
    // 主会话、主会话、溢出、总结、重试
    expect(shared.requests).toHaveLength(5);
    expect(shared.requests[3]!.tools).toEqual([]);
    expect(textOf(shared.requests[4]!.messages[0]!.content)).toContain("SUMMARY");
    expect(textOf(s.state.messages.at(-1)!.content)).toBe("C");
    expect(shared.notes.some((n) => n.includes("exceeded the model's context window"))).toBe(true);
    const ends = (await s.history()).filter((e) => e.type === "turn.ended").map((e) => (e.data as { reason: string }).reason);
    expect(ends).toEqual(["end", "end", "error", "end"]);

    // 重试又溢出：同一次输入里不再重试
    shared.script.push({ error: OVERFLOW }, say("SUMMARY 2"), { error: OVERFLOW });
    await send(s, "fourth");
    expect(shared.requests).toHaveLength(8);
    expect(s.state.messages.at(-1)!.role).toBe("user");

    // 别的错误不管
    shared.script.push({ error: "connection reset" });
    await send(s, "fifth");
    expect(shared.requests).toHaveLength(9);
  });
});
