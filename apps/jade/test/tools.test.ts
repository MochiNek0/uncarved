import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderError, type Block, type Message, type Provider, type Tool, type ToolContext } from "uncarved";
import { estimateTokens, fsTools, htmlToMarkdown, isPrivateHost, nearMiss, webTools, withRetry } from "../src/index.ts";

// ---------- 辅助 ----------

const ctx = (): ToolContext => ({
  sessionId: "s",
  toolUseId: "t",
  signal: new AbortController().signal,
  parent: { sessionId: "s", eventId: "e" },
  progress: () => {},
});

async function exec(tools: Tool[], name: string, input: unknown) {
  const r = await tools.find((t) => t.name === name)!.execute(input, ctx());
  return { text: typeof r.content === "string" ? r.content : "", blocks: typeof r.content === "string" ? [] : (r.content as Block[]), isError: r.isError ?? false };
}

const workspace = () => mkdtemp(path.join(os.tmpdir(), "jade-tools-"));

// ---------- grep ----------

/** 有 ripgrep 时两条路径都测；JADE_TEST_RG 可以指定不在 PATH 上的 ripgrep */
const RG = process.env.JADE_TEST_RG ?? Bun.which("rg");
const variants: Array<[string, string | null]> = [["js", null], ...(RG ? ([["ripgrep", RG]] as Array<[string, string]>) : [])];

describe.each(variants)("grep (%s)", (_name, rg) => {
  async function repo() {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "a.ts"), "one\nfoo two\nthree\nfour\nfive\nfoo six\n");
    await writeFile(path.join(cwd, "b.md"), "no match here\nfoo\n");
    return { cwd, tools: fsTools(cwd, { rg }) };
  }

  test("content, files and count modes", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "foo", include: "**/*.ts" })).text).toBe("a.ts:2:foo two\na.ts:6:foo six");
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "files" })).text).toBe("a.ts\nb.md");
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "count" })).text).toBe("a.ts:2\nb.md:1");
    expect((await exec(tools, "grep", { pattern: "nothing" })).text).toBe("No matches");
  });

  test("context lines, with -- between groups", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "foo", path: "a.ts", context: 1 })).text).toBe(
      ["a.ts-1-one", "a.ts:2:foo two", "a.ts-3-three", "--", "a.ts-5-five", "a.ts:6:foo six"].join("\n"),
    );
  });

  test("JavaScript-only syntax such as lookbehind still works", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "(?<=foo )six" })).text).toBe("a.ts:6:foo six");
  });
});

// ---------- edit ----------

describe("edit hints and multi_edit", () => {
  test("nearMiss points at lines that match when whitespace is ignored", () => {
    const text = "function f() {\n\treturn 1;\n}\n";
    expect(nearMiss(text, "function f() {\n    return 1;\n}")).toContain("lines 1-3 if whitespace is ignored");
    expect(nearMiss(text, "function f() {\n  return 2;\n}")).toContain('first line "function f() {" appears at line 1');
    expect(nearMiss(text, "something else")).toBe("");
  });

  test("edit_file explains a near miss", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    await writeFile(path.join(cwd, "a.ts"), "if (x) {\n\tgo();\n}\n");
    await exec(tools, "read_file", { path: "a.ts" });
    const r = await exec(tools, "edit_file", { path: "a.ts", old_string: "if (x) {\n  go();", new_string: "if (y) {\n  go();" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("lines 1-2 if whitespace is ignored");
  });

  test("multi_edit applies edits in order, and none of them if one fails", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "a.ts");
    await writeFile(file, "a = 1\nb = 2\n");
    await exec(tools, "read_file", { path: "a.ts" });
    const ok = await exec(tools, "multi_edit", {
      path: "a.ts",
      edits: [
        { old_string: "a = 1", new_string: "a = 10" },
        { old_string: "a = 10\nb", new_string: "a = 10\nc" },
      ],
    });
    expect(ok).toMatchObject({ isError: false, text: "Edited a.ts (2 replacements)" });
    expect(await readFile(file, "utf8")).toBe("a = 10\nc = 2\n");

    const bad = await exec(tools, "multi_edit", {
      path: "a.ts",
      edits: [
        { old_string: "a = 10", new_string: "a = 11" },
        { old_string: "missing", new_string: "x" },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toStartWith("edit 2 of 2: old_string not found");
    expect(await readFile(file, "utf8")).toBe("a = 10\nc = 2\n");
  });
});

// ---------- read_file PDF ----------

test("read_file returns a PDF as a document block", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "doc.pdf"), "%PDF-1.4\n\0binary");
  const r = await exec(fsTools(cwd), "read_file", { path: "doc.pdf" });
  expect(r.blocks[0]).toMatchObject({ kind: "document", source: { type: "base64", media_type: "application/pdf" }, trust: "untrusted" });
});

// ---------- web ----------

/** 不真的解析域名：测试不依赖网络 */
const PUBLIC_IP = "93.184.215.14";
const publicLookup = async () => [PUBLIC_IP];

/** 按 URL 返回预设响应的 fetch，记录请求过的地址 */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const res = route();
    (impl as { lastInit?: RequestInit }).lastInit = init;
    return res;
  }) as typeof fetch;
  return { impl, seen };
}

const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("web_fetch", () => {
  test("converts HTML to markdown and resolves links", async () => {
    const { impl } = fakeFetch({
      "https://example.com/doc": html(
        `<html><head><title>Doc &amp; Co</title><script>evil()</script></head><body><nav>menu</nav>` +
          `<h1>Title</h1><p>Hello <a href="/next">next page</a> &lt;3</p><ul><li>one<li>two</ul><pre>  indented\n    code</pre></body></html>`,
      ),
    });
    const { tools } = webTools({ env: {}, fetch: impl, lookup: publicLookup });
    const r = await exec(tools, "web_fetch", { url: "https://example.com/doc" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      "URL: https://example.com/doc\nTitle: Doc & Co\n\n# Title\n\nHello [next page](https://example.com/next) <3\n\n- one\n- two\n\n```\n  indented\n    code\n```",
    );
  });

  test("pages long content with offset, without downloading again", async () => {
    const { impl, seen } = fakeFetch({ "https://example.com/big.txt": () => new Response("x".repeat(45_000), { headers: { "content-type": "text/plain" } }) });
    const { tools } = webTools({ env: {}, fetch: impl, lookup: publicLookup });
    const first = await exec(tools, "web_fetch", { url: "https://example.com/big.txt" });
    expect(first.text).toEndWith("(showing characters 0-30000 of 45000; continue with offset 30000)");
    const second = await exec(tools, "web_fetch", { url: "https://example.com/big.txt", offset: 30_000 });
    expect(second.text).toBe(`URL: https://example.com/big.txt\n\n${"x".repeat(15_000)}`);
    expect(seen).toHaveLength(1);
  });

  test("refuses local addresses, also after a redirect", async () => {
    const { impl, seen } = fakeFetch({
      "https://example.com/go": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
    });
    const { tools } = webTools({ env: {}, fetch: impl, lookup: publicLookup });
    expect((await exec(tools, "web_fetch", { url: "http://localhost:3000" })).isError).toBe(true);
    expect((await exec(tools, "web_fetch", { url: "file:///etc/passwd" })).isError).toBe(true);
    const r = await exec(tools, "web_fetch", { url: "https://example.com/go" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("redirects to http://127.0.0.1:8080/admin");
    expect(seen).toEqual(["https://example.com/go"]);
  });

  test("reports HTTP errors and returns PDFs as documents", async () => {
    const { impl } = fakeFetch({
      "https://example.com/paper.pdf": () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }),
    });
    const { tools } = webTools({ env: {}, fetch: impl, lookup: publicLookup });
    const missing = await exec(tools, "web_fetch", { url: "https://example.com/missing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toStartWith("HTTP 404");
    const pdf = await exec(tools, "web_fetch", { url: "https://example.com/paper.pdf" });
    expect(pdf.blocks[0]).toMatchObject({ kind: "document", source: { media_type: "application/pdf" } });
  });

  test("refuses host names that resolve to local addresses", async () => {
    const { impl, seen } = fakeFetch({
      "https://example.com/go": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1.nip.io/admin" } }),
    });
    const lookup = async (host: string) => (host.endsWith("nip.io") ? ["127.0.0.1"] : [PUBLIC_IP]);
    const { tools } = webTools({ env: {}, fetch: impl, lookup });
    const direct = await exec(tools, "web_fetch", { url: "http://127.0.0.1.nip.io/admin" });
    expect(direct.isError).toBe(true);
    expect(direct.text).toContain("resolves to 127.0.0.1");
    const redirected = await exec(tools, "web_fetch", { url: "https://example.com/go" });
    expect(redirected.text).toContain("redirects to http://127.0.0.1.nip.io/admin, which is refused");
    expect(seen).toEqual(["https://example.com/go"]);
  });

  test("private host detection", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "::ffff:127.0.0.1", "fd00::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateHost(h)).toBe(false);
  });

  test("htmlToMarkdown drops empty links and decodes numeric entities", () => {
    expect(htmlToMarkdown(`<p><a href="/x"><img src="i.png"></a>&#20013;&#x6587; &amp; more</p>`).text).toBe("中文 & more");
  });
});

describe("web_search", () => {
  test("is only provided when a search service is configured", () => {
    expect(webTools({ env: {} }).tools.map((t) => t.name)).toEqual(["web_fetch"]);
    expect(webTools({ env: { TAVILY_API_KEY: "k" } }).tools.map((t) => t.name)).toEqual(["web_fetch", "web_search"]);
    expect(() => webTools({ env: { JADE_SEARCH: "bing", TAVILY_API_KEY: "k" } })).toThrow("JADE_SEARCH");
  });

  test("queries Tavily and formats the results", async () => {
    let body: unknown;
    let auth: unknown;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      auth = new Headers(init?.headers).get("authorization");
      return Response.json({
        answer: "Bun 1.4 is current.",
        results: [{ title: "Bun", url: "https://bun.sh", content: "Bun is a fast\n JavaScript runtime" }],
      });
    }) as typeof fetch;
    const { tools } = webTools({ env: { TAVILY_API_KEY: "tvly-k" }, fetch: impl });
    const r = await exec(tools, "web_search", { query: "bun version", max_results: 50 });
    expect(body).toMatchObject({ query: "bun version", max_results: 10 });
    expect(auth).toBe("Bearer tvly-k");
    expect(r.text).toBe("Summary from tavily: Bun 1.4 is current.\n\n1. Bun\n   https://bun.sh\n   Bun is a fast JavaScript runtime");
  });

  test("reports a failing service as a tool error", async () => {
    const impl = (async () => new Response("quota exceeded", { status: 432 })) as unknown as typeof fetch;
    const { tools } = webTools({ env: { TAVILY_API_KEY: "k" }, fetch: impl });
    const r = await exec(tools, "web_search", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 432");
  });
});

// ---------- 估算与重试 ----------

test("estimateTokens counts CJK characters as about one token each", () => {
  const msg = (text: string): Message[] => [{ role: "user", content: [{ kind: "text", text, origin: { by: "user" }, trust: "trusted" }] }];
  const base = estimateTokens(msg(""));
  expect(estimateTokens(msg("a".repeat(400))) - base).toBe(100);
  expect(estimateTokens(msg("中".repeat(400))) - base).toBe(400);
});

test("withRetry adds jitter to the backoff unless the server says when to retry", async () => {
  const delays: number[] = [];
  let calls = 0;
  const inner: Provider = {
    id: "inner",
    async complete() {
      calls++;
      if (calls === 1) throw new ProviderError("overloaded", { retryable: true });
      if (calls === 2) throw new ProviderError("rate limited", { retryable: true, retryAfterMs: 7 });
      return { model: "m", content: [], stopReason: "end" };
    },
  };
  await withRetry(inner, { baseDelayMs: 10, random: () => 0, onRetry: (i) => delays.push(i.delayMs) }).complete(
    { system: [], messages: [], tools: [] },
    { signal: new AbortController().signal },
  );
  expect(delays).toEqual([5, 7]);
});
