// 冻结代替拷贝：交给 hook 的值都是深度冻结的，hook 改不动，所以不必每个 hook 各拷一份（I-5）。
// 状态只靠 step() 生成新对象来更新，从不原地修改，冻结后可以放心地在 hook 之间共享。

/** hook 的输出里有不是普通数据的值（函数、类实例、Map 等），日志写不进去，也冻结不了 */
export class NotPlainData extends Error {
  constructor(what: string) {
    super(`hook output must be plain data (objects, arrays, strings, numbers, booleans, null), got ${what}`);
    this.name = "NotPlainData";
  }
}

/**
 * 深度冻结 v 并原样返回。已经冻结的子树跳过：状态和历史只追加，每次只需走新增的部分。
 * check 为 true 时，同时检查新增部分是不是普通数据（hook 的输出用它；以前靠 structuredClone 报错）
 */
export function deepFreeze<T>(v: T, check = false): T {
  if (typeof v !== "object" || v === null) {
    if (check && (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint")) throw new NotPlainData(typeof v);
    return v;
  }
  if (Object.isFrozen(v)) return v;
  if (check && !Array.isArray(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new NotPlainData(proto?.constructor?.name ?? "object");
  }
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k], check);
  return v;
}
