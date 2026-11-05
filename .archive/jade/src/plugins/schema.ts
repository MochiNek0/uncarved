// 最小的 JSON Schema 校验：工具参数常用的 type / required / properties / additionalProperties / enum / items。
// 内核不按 schema 校验参数（4.6 第 3 款），由关卡插件做。

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  enum?: unknown[];
  items?: Schema;
};

/** 返回第一个问题的描述，没有问题返回 undefined */
export function validate(schema: unknown, value: unknown, at = "input"): string | undefined {
  const s = schema as Schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => is(t, value))) return `${at} must be ${types.join(" or ")}, got ${kind(value)}`;
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return `${at} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (obj[r] === undefined) return `${at}.${r} is required`;
    for (const [k, v] of Object.entries(obj)) {
      const prop = s.properties?.[k];
      if (prop) {
        const problem = validate(prop, v, `${at}.${k}`);
        if (problem) return problem;
      } else if (s.additionalProperties === false) {
        return `${at}.${k} is not allowed`;
      } else if (typeof s.additionalProperties === "object") {
        const problem = validate(s.additionalProperties, v, `${at}.${k}`);
        if (problem) return problem;
      }
    }
  }
  if (Array.isArray(value) && s.items) {
    for (const [i, v] of value.entries()) {
      const problem = validate(s.items, v, `${at}[${i}]`);
      if (problem) return problem;
    }
  }
  return undefined;
}

function is(type: string, v: unknown): boolean {
  switch (type) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "null":
      return v === null;
    default:
      return typeof v === type;
  }
}

function kind(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
