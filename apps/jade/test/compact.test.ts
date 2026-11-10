// jade/compact：清理旧的工具输出、总结、/compact、上下文溢出后压缩重试。
// 从旧 jade 的 test/jade.test.ts（compaction、context window）和 test/turns.test.ts（overflow）移植，在真实的会话里测。

import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Message } from "uncarved";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands, Renderers } from "@uncarved/jade-api/services";
import { compactThreshold, DERIVED_KEY, estimateTokens, isContextOverflow, parseTokens, TRIMMED, type CompactState } from "../plugins/compact/compact.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

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

  test("/compact summarizes before the next request; the summary is recorded once and reused after resume", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(say("A"), say("B"));
    const s = await host.sessions.open();
    await send(s, "first");
    await send(s, "second");

    const compact = host.service<Commands>("commands@1")!.get("compact")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    expect(await compact.run("keep the API decisions", c)).toContain("will be compacted");
    shared.script.push(say("SUMMARY"), say("C"));
    await send(s, "third");

    const summarizer = shared.requests[2]!;
    expect(summarizer.tools).toEqual([]);
    // 命令后面写的话交给总结
    expect(textOf(summarizer.messages[0]!.content)).toContain("pay particular attention to: keep the API decisions");
    expect(textOf(summarizer.messages[0]!.content)).toContain("<transcript>");
    const main = shared.requests[3]!;
    expect(textOf(main.messages[0]!.content)).toContain("SUMMARY");
    expect(main.messages.length).toBeLessThan(s.state.messages.length);
    const compacted = s.state.derived[DERIVED_KEY] as CompactState;
    expect(compacted.summary).toStartWith("SUMMARY");
    // 用户的原话原样带上
    expect(compacted.summary).toContain("verbatim:\n> first");
    expect(compacted.summary).toContain("read a file again before editing it");
    expect((await s.history()).filter((e) => e.type === "jade/compact/compacted")).toHaveLength(1);
    expect(host.service<Renderers>("renderers@1")!.forEvent("jade/compact/compacted")!.renderer.render({ from: 0, upTo: 1, before: 99 })!.line).toContain("compacted 1 messages");

    // 恢复后直接使用日志里的摘要，不再调用总结
    const id = s.id;
    await host.sessions.close();
    const resumed = await host.sessions.open({ resume: id });
    shared.script.push(say("D"));
    await send(resumed, "fourth");
    expect(shared.requests).toHaveLength(5);
    expect(textOf(shared.requests[4]!.messages[0]!.content)).toContain("SUMMARY");
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
