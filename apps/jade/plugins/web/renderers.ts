// web_fetch、web_search 在对话里怎么显示（登记到 renderers@1）。从旧 jade 的 ui/renderers.ts 移植。

import type { ToolRenderer } from "@uncarved/jade-api/services";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const args = (input: unknown) => (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;

export const webRenderers: ToolRenderer[] = [
  { tool: "web_fetch", summary: (input) => clip(String(args(input).url ?? ""), 120) },
  { tool: "web_search", summary: (input) => clip(String(args(input).query ?? ""), 120) },
];
