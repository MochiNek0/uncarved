// 五字段 cron（分 时 日 月 星期），按本机时区计算。支持 *、数字、a-b、/步长和逗号列表；
// 星期 0 和 7 都是周日。日和星期都受限时任一匹配即可（Vixie cron 的规则），有一个以 * 开头时两者都要匹配。

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** 日、星期字段以 * 开头 */
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
] as const;

function field(text: string, [name, min, max]: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!m) throw new Error(`invalid ${name} field "${text}"`);
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name} field "${text}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day-of-month month day-of-week), got "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]!));
  if (dow!.delete(7)) dow!.add(0);
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domStar: parts[2]!.startsWith("*"), dowStar: parts[4]!.startsWith("*") };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  return c.domStar || c.dowStar ? dom && dow : dom || dow;
}

/** from 之后（不含）第一个匹配的整分钟；五年内没有（例如 2 月 30 日）时 undefined */
export function nextRun(expr: string | Cron, from: Date): Date | undefined {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 86_400_000;
  while (d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d;
    }
  }
  return undefined;
}
