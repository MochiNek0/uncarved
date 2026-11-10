// jade/web：web_fetch、web_search、/search。工具部分从旧 jade 的 test/tools.test.ts 移植，网络换成假的 fetch。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Tool, ToolContext } from "uncarved";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { htmlToMarkdown, isPrivateHost, parseOrder, parseResults, SEARCH_OFF, SEARCH_PROVIDERS, webTools } from "../plugins/web/web.ts";
import { msg, say, scripted, turn } from "./scripted-host.ts";

const ctx = (): ToolContext => ({ sessionId: "s", toolUseId: "t", signal: new AbortController().signal, parent: { sessionId: "s", eventId: "e" }, progress: () => {} });

async function exec(tools: Tool[], name: string, input: unknown) {
  const r = await tools.find((t) => t.name === name)!.execute(input, ctx());
  return { text: typeof r.content === "string" ? r.content : "", blocks: typeof r.content === "string" ? [] : (r.content as Block[]), isError: r.isError ?? false };
}

const PUBLIC_IP = "93.184.215.14";
const publicLookup = async () => [PUBLIC_IP];

/** 按 URL 返回预设响应的 fetch，记录请求过的地址 */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as typeof fetch;
  return { impl, seen };
}

const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

// 本机 shell 里可能配了真的 key：测试期间拿掉，免得 web_search 出现、或者真的联网
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of [...SEARCH_PROVIDERS.map((p) => p.env), "JADE_SEARCH", "JADE_SEARCH_RESULTS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

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

  test("fetches directly first and asks a search service only when blocked, failing or thin", async () => {
    const seen: string[] = [];
    const longText = "word ".repeat(100);
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u === "https://api.tavily.com/extract") return Response.json({ results: [{ raw_content: "# Via Tavily" }] });
      if (u === "https://example.com/ok") return html(`<p>${longText}</p>`)();
      if (u === "https://example.com/blocked") return new Response("Just a moment", { status: 403 });
      if (u === "https://example.com/spa") return html(`<div id="root"></div><noscript>enable JS</noscript>`)();
      return new Response("not here", { status: 404 });
    }) as typeof fetch;
    const { tools } = webTools({ env: { TAVILY_API_KEY: "t" }, fetch: impl, lookup: publicLookup });
    expect((await exec(tools, "web_fetch", { url: "https://example.com/ok" })).text).toBe(`URL: https://example.com/ok\n\n${longText.trim()}`);
    expect((await exec(tools, "web_fetch", { url: "https://example.com/gone" })).text).toStartWith("HTTP 404");
    expect(seen).toEqual(["https://example.com/ok", "https://example.com/gone"]);
    expect((await exec(tools, "web_fetch", { url: "https://example.com/blocked" })).text).toBe("URL: https://example.com/blocked\nFetched via: tavily\n\n# Via Tavily");
    expect((await exec(tools, "web_fetch", { url: "https://example.com/spa" })).text).toContain("Fetched via: tavily");
    expect(seen.slice(2)).toEqual(["https://example.com/blocked", "https://api.tavily.com/extract", "https://example.com/spa", "https://api.tavily.com/extract"]);
  });

  test("keeps the thin page when no service can read it either", async () => {
    const impl = (async (url: string | URL | Request) =>
      String(url).startsWith("https://r.jina.ai/") ? new Response("rate limited", { status: 429 }) : html("<p>short</p>")()) as typeof fetch;
    const { tools } = webTools({ env: { JINA_API_KEY: "j" }, fetch: impl, lookup: publicLookup });
    const r = await exec(tools, "web_fetch", { url: "https://example.com/short" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("URL: https://example.com/short\n\nshort");
  });

  test("names the cause when every way of fetching fails", async () => {
    const impl = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://r.jina.ai/")) return new Response("rate limited", { status: 429 });
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND wttr.in"), { code: "ENOTFOUND" }) });
    }) as typeof fetch;
    const { tools } = webTools({ env: { JINA_API_KEY: "j" }, fetch: impl, lookup: publicLookup });
    const r = await exec(tools, "web_fetch", { url: "https://wttr.in/Seoul" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Could not fetch https://wttr.in/Seoul:\n- direct: fetch failed (getaddrinfo ENOTFOUND wttr.in)\n- jina: Jina reader returned HTTP 429: rate limited");
  });

  test("reads from a real local HTTP server only through the private-address check", async () => {
    // 真实的 fetch：本机地址被拒绝，不发出请求
    const server = Bun.serve({ port: 0, fetch: () => new Response("secret") });
    try {
      const { tools } = webTools({ env: {} });
      const r = await exec(tools, "web_fetch", { url: `http://127.0.0.1:${server.port}/` });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("local or private address");
    } finally {
      server.stop(true);
    }
  });

  test("htmlToMarkdown drops empty links and decodes numeric entities", async () => {
    expect((await htmlToMarkdown(`<p><a href="/x"><img src="i.png"></a>&#20013;&#x6587; &amp; more</p>`)).text).toBe("中文 & more");
  });
});

describe("web_search", () => {
  test("follows the keys it is given at call time", async () => {
    const env: Record<string, string | undefined> = {};
    const impl = (async () => Response.json({ results: [{ title: "A", url: "https://a.example", content: "x" }] })) as unknown as typeof fetch;
    const web = webTools({ env: () => env, fetch: impl });
    expect(web.tools.map((t) => t.name)).toEqual(["web_fetch", "web_search"]);
    expect(web.search()).toEqual([]);
    expect(await exec(web.tools, "web_search", { query: "q" })).toEqual({ text: SEARCH_OFF, blocks: [], isError: true });
    env.TAVILY_API_KEY = "k";
    expect(web.search()).toEqual(["tavily"]);
    expect((await exec(web.tools, "web_search", { query: "q" })).text).toBe("1. A\n   https://a.example\n   x");
  });

  test("the service order and result count are checked", () => {
    expect(parseOrder("exa, AnySearch", "search")).toEqual(["exa", "anysearch"]);
    expect(parseOrder(["jina"], "search")).toEqual(["jina"]);
    expect(parseOrder(undefined, "search")).toBeUndefined();
    expect(() => parseOrder("bing", "JADE_SEARCH")).toThrow("JADE_SEARCH: unknown search service bing");
    expect(parseResults(undefined, "results")).toBe(10);
    expect(parseResults("15", "results")).toBe(15);
    expect(() => parseResults(50, "JADE_SEARCH_RESULTS")).toThrow("JADE_SEARCH_RESULTS");
    // order 只列了没有 key 的服务：没有搜索
    expect(webTools({ env: { TAVILY_API_KEY: "k" }, order: ["exa"] }).search()).toEqual([]);
  });

  test("falls back to the next service in the configured order", async () => {
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(new URL(u).host);
      if (u.startsWith("https://api.exa.ai")) return new Response("no credit", { status: 402 });
      return Response.json({ code: 0, data: { results: [{ title: "A", url: "https://a.example", content: "from anysearch" }] } });
    }) as typeof fetch;
    const { tools } = webTools({ order: ["exa", "anysearch"], env: { EXA_API_KEY: "e", ANYSEARCH_API_KEY: "a", TAVILY_API_KEY: "t" }, fetch: impl });
    const r = await exec(tools, "web_search", { query: "q" });
    expect(r.text).toBe("1. A\n   https://a.example\n   from anysearch");
    expect(seen).toEqual(["api.exa.ai", "api.anysearch.com"]);
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
    const { tools } = webTools({ env: { TAVILY_API_KEY: "tvly-k" }, results: 15, fetch: impl });
    const r = await exec(tools, "web_search", { query: "bun version" });
    expect(body).toMatchObject({ query: "bun version", max_results: 15 });
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

describe("jade/web plugin", () => {
  /** 按脚本选择和输入的 UI */
  const scriptedUi = (picks: (string | undefined)[], typed: string | undefined): UI => ({
    interactive: true,
    notify: () => {},
    select: async () => picks.shift() as never,
    input: async () => typed,
  });

  test("web_search is sent to the model only while a search service is set up; /search sets one up for the running session", async () => {
    const { home, host, requests, reports } = await scripted([say("one"), say("two"), say("three")]);
    try {
      const s = await host.sessions.open();
      await turn(s, msg("hi"));
      const tools = (i: number) => requests[i]!.tools.map((t) => t.name);
      const system = (i: number) => requests[i]!.system.map((x) => x.text).join("\n");
      expect(tools(0)).toContain("web_fetch");
      expect(tools(0)).not.toContain("web_search");
      expect(system(0)).toContain("the user can turn it on with /search");

      const search = host.service<Commands>("commands@1")!.get("search")!.command;
      const c: CommandContext = { signal: new AbortController().signal, ui: scriptedUi(["tavily"], " tvly-secret "), sessions: host.sessions, print: () => {} };
      expect(await search.run("", c)).toContain("Web search is on with tavily");
      expect(await readFile(path.join(home, ".env"), "utf8")).toBe("TAVILY_API_KEY=tvly-secret\n");

      // 当前会话立即用上，不用重开
      await turn(s, msg("again"));
      expect(tools(1)).toContain("web_search");
      expect(system(1)).not.toContain("turn it on with /search");

      // 去掉 key
      const off: CommandContext = { ...c, ui: scriptedUi(["tavily", "off"], undefined) };
      expect(await search.run("", off)).toContain("Web search is off");
      expect(await readFile(path.join(home, ".env"), "utf8")).toBe("\n");
      await turn(s, msg("once more"));
      expect(tools(2)).not.toContain("web_search");
      // 其他插件（例如正在移植的）的报告不管
      expect(reports.filter((r) => r.includes("jade/web") || r.includes(`plugins${path.sep}web`))).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("/search does not change a key set in the shell, which would win again in the next session", async () => {
    const { home, host } = await scripted([]);
    const before = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "from-shell";
    try {
      const search = host.service<Commands>("commands@1")!.get("search")!.command;
      const c: CommandContext = { signal: new AbortController().signal, ui: scriptedUi(["tavily", "set"], "new"), sessions: host.sessions, print: () => {} };
      expect(await search.run("", c)).toContain("TAVILY_API_KEY is set in your shell environment");
      await expect(readFile(path.join(home, ".env"), "utf8")).rejects.toThrow();
    } finally {
      if (before === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = before;
      await host.close();
    }
  });

  test("keys in $JADE_HOME/.env turn search on; a bad search order falls back to the default order", async () => {
    const { host, requests } = await scripted([say("one")], { env: "EXA_API_KEY=e\n", config: { "jade/web": { search: "bing" } } });
    try {
      const s = await host.sessions.open();
      await turn(s, msg("hi"));
      expect(requests[0]!.tools.map((t) => t.name)).toContain("web_search");
    } finally {
      await host.close();
    }
  });
});
