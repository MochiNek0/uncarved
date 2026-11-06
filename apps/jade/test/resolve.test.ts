import { describe, expect, test } from "bun:test";
import { API_VERSION, resolve, type Manifest, type PluginLayer, type PluginSource } from "../src/index.ts";

const src = (layer: PluginLayer, m: Partial<Manifest> & { id: string }): PluginSource => ({
  manifest: { version: "1.0.0", api: "^1", entry: "index.js", ...m },
  dir: `/${layer}/${m.id}`,
  layer,
});
const plan = (sources: PluginSource[], opts: Partial<Parameters<typeof resolve>[1]> = {}) => resolve(sources, { apiVersion: API_VERSION, ...opts });
const state = (p: ReturnType<typeof plan>, id: string) => {
  const e = p.entries.find((x) => x.source.manifest.id === id)!;
  return [e.state, e.reason ?? ""] as const;
};
const order = (p: ReturnType<typeof plan>) => p.order.map((s) => s.manifest.id);

describe("dependencies", () => {
  test("providers activate before their dependents", () => {
    const p = plan([
      src("bundled", { id: "a", requires: ["b@1"], optional: ["c@1"] }),
      src("bundled", { id: "c", provides: ["c@1"] }),
      src("bundled", { id: "b", provides: ["b@1"], requires: ["c@1"] }),
    ]);
    expect(order(p)).toEqual(["c", "b", "a"]);
    expect(p.providers.get("b@1")).toBe("b");
  });

  test("a missing service skips the plugin and everything that requires it, naming the service", () => {
    const p = plan([src("bundled", { id: "a", provides: ["a@1"], requires: ["x@1"] }), src("bundled", { id: "b", requires: ["a@1"] }), src("bundled", { id: "c", optional: ["a@1"] })]);
    expect(state(p, "a")).toEqual(["skipped", "requires x@1, which no plugin provides"]);
    expect(state(p, "b")).toEqual(["skipped", "requires a@1: its provider a is skipped"]);
    expect(state(p, "c")[0]).toBe("active"); // 可选依赖缺了照样激活
  });

  test("service majors must match exactly", () => {
    const p = plan([src("bundled", { id: "a", provides: ["ui@2"] }), src("bundled", { id: "b", requires: ["ui@1"] })]);
    expect(state(p, "b")[0]).toBe("skipped");
  });

  test("a dependency cycle skips its members", () => {
    const p = plan([src("bundled", { id: "a", provides: ["a@1"], requires: ["b@1"] }), src("bundled", { id: "b", provides: ["b@1"], requires: ["a@1"] }), src("bundled", { id: "c" })]);
    expect(state(p, "a")[1]).toContain("dependency cycle");
    expect(order(p)).toEqual(["c"]);
  });

  test("a cycle through an optional dependency is broken there instead of skipping its members", () => {
    // approval 可选用 ui，ui 可选用 modes，modes 必需 approval：approval 先激活，那时还拿不到 ui
    const p = plan([
      src("bundled", { id: "approval", provides: ["approval@1"], optional: ["ui@1"] }),
      src("bundled", { id: "modes", provides: ["modes@1"], requires: ["approval@1"] }),
      src("bundled", { id: "tui", provides: ["ui@1"], optional: ["modes@1"] }),
    ]);
    expect(order(p)).toEqual(["approval", "modes", "tui"]);
  });

  test("core services satisfy requires, and no plugin may provide one", () => {
    const p = plan(
      [
        src("bundled", { id: "diagnose", requires: ["jade@1"] }),
        src("user", { id: "fake-core", provides: ["jade@1"] }),
      ],
      { coreServices: ["jade@1"] },
    );
    expect(state(p, "diagnose")[0]).toBe("active");
    expect(p.providers.get("jade@1")).toBe("jade");
    expect(state(p, "fake-core")).toEqual(["conflict", "jade@1 is provided by jade itself"]);
  });
});

describe("service conflicts", () => {
  test("a user plugin overrides the bundled provider", () => {
    const p = plan([src("bundled", { id: "jade/tui", provides: ["ui@1"] }), src("user", { id: "me/ui", provides: ["ui@1"] })]);
    expect(p.providers.get("ui@1")).toBe("me/ui");
    expect(state(p, "jade/tui")).toEqual(["replaced", "ui@1 is provided by me/ui (user)"]);
  });

  test("a project plugin cannot override a user or bundled provider", () => {
    const p = plan([src("bundled", { id: "jade/approval", provides: ["approval@1"] }), src("project", { id: "repo/yes", provides: ["approval@1"] })]);
    expect(p.providers.get("approval@1")).toBe("jade/approval");
    expect(state(p, "repo/yes")[0]).toBe("conflict");
  });

  test("a project plugin can provide a service nobody else provides", () => {
    const p = plan([src("project", { id: "repo/tool", provides: ["repo@1"] })]);
    expect(p.providers.get("repo@1")).toBe("repo/tool");
  });

  test("same-layer providers are both excluded instead of picking one by discovery order", () => {
    const p = plan([src("user", { id: "a", provides: ["ui@1"] }), src("user", { id: "b", provides: ["ui@1"] }), src("user", { id: "c", requires: ["ui@1"] })]);
    expect(state(p, "a")[0]).toBe("conflict");
    expect(state(p, "b")[0]).toBe("conflict");
    expect(state(p, "c")[0]).toBe("skipped");
    expect(p.providers.has("ui@1")).toBe(false);
  });

  test("losing one service excludes the whole plugin, and its other services become free", () => {
    const p = plan([
      src("bundled", { id: "big", provides: ["ui@1", "keys@1"] }),
      src("user", { id: "ui", provides: ["ui@1"] }),
      src("user", { id: "keys", provides: ["keys@1"] }),
    ]);
    expect(state(p, "big")[0]).toBe("replaced");
    expect(p.providers.get("keys@1")).toBe("keys");
  });
});

describe("replaces", () => {
  test("replaces removes the target", () => {
    const p = plan([src("bundled", { id: "jade/compact" }), src("user", { id: "me/compact", replaces: ["jade/compact"] })]);
    expect(state(p, "jade/compact")).toEqual(["replaced", "replaced by me/compact"]);
  });

  test("a project plugin cannot replace a bundled one", () => {
    const p = plan([src("bundled", { id: "jade/approval" }), src("project", { id: "repo/x", replaces: ["jade/approval"] })]);
    expect(state(p, "jade/approval")[0]).toBe("active");
    expect(p.warnings.join()).toContain("cannot replace");
  });
});

describe("frontends", () => {
  const fronts = [src("bundled", { id: "tui", provides: ["frontend@1"], frontend: { name: "tui", default: true } }), src("bundled", { id: "print", provides: ["frontend@1"], frontend: { name: "print", flag: "-p" } })];

  test("the default frontend without flags", () => {
    const p = plan(fronts);
    expect(p.frontend).toBe("tui");
    expect(state(p, "print")[0]).toBe("skipped");
  });

  test("a flag selects its frontend", () => {
    const p = plan(fronts, { flags: ["-p"] });
    expect(p.frontend).toBe("print");
    expect(state(p, "tui")[0]).toBe("skipped");
  });
});

describe("filters", () => {
  test("disabled, safe mode, incompatible API and duplicate ids", () => {
    const p = plan(
      [src("bundled", { id: "a" }), src("bundled", { id: "b", api: "^2" }), src("user", { id: "c" }), src("user", { id: "a" }), src("bundled", { id: "d" })],
      { safe: true, disabled: new Set(["d"]) },
    );
    expect(state(p, "a")[0]).toBe("active");
    expect(state(p, "b")).toEqual(["incompatible", `requires plugin API ^2, running ${API_VERSION}`]);
    expect(state(p, "c")).toEqual(["disabled", "safe mode"]);
    expect(p.entries[3]!.state).toBe("duplicate");
    expect(state(p, "d")[0]).toBe("disabled");
  });
});
