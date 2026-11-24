import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { wrapRows, visibleRow } from "../plugins/tui/markdown.ts";
import { standalone, visibleWidth, wrapText } from "../plugins/tui/width.ts";

const WRAP = { hard: true, trim: false } as const;

/** 可重复的伪随机数 */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

const CJK = "这是一段用来测试折行的中文文本，包含标点。“引号”‘单引号’……——《书名》、【括号】！？：；（全角）ａｂ１２";
const OTHER = "ひらがなカタカナ한국어문장é·×÷│─┌┐•▸▾✻⎿☐☑→≤";
/** 快路径不管的：emoji、组合附加符号、变体选择符、零宽字符、制表位之外的控制字符 */
const FALLBACK = ["😀", "é", "✔️", "a​b", "👍🏽", "゙"];
/** jade 的样式（screen.ts 的 paint） */
const STYLES: [number, number][] = [[1, 22], [2, 22], [3, 23], [4, 24], [9, 29], [31, 39], [32, 39], [36, 39]];

function randomText(r: () => number, fallback: boolean): string {
  const pick = (s: string) => [...s][Math.floor(r() * [...s].length)]!;
  const piece = (): string => {
    const x = r();
    if (x < 0.25) return " ".repeat(1 + Math.floor(r() * 3));
    if (x < 0.5) return Array.from({ length: 1 + Math.floor(r() * 12) }, () => pick("abcdefghijklmnopqrstuvwxyz0123456789.,-_/")).join("");
    if (x < 0.75) return Array.from({ length: 1 + Math.floor(r() * 20) }, () => pick(CJK)).join("");
    if (x < 0.85) return Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(OTHER)).join("");
    if (x < 0.95) {
      const [open, close] = STYLES[Math.floor(r() * STYLES.length)]!;
      const inner = piece();
      return `\x1b[${open}m${inner.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m`;
    }
    return fallback ? FALLBACK[Math.floor(r() * FALLBACK.length)]! : "\n";
  };
  return Array.from({ length: 1 + Math.floor(r() * 12) }, piece).join("");
}

describe("width fast path", () => {
  test("every code point it handles is its own grapheme cluster, survives NFC, and has string-width's width", () => {
    const chars: string[] = [];
    for (let c = 0; c < 0x10000; c++) {
      if (!standalone(c)) continue;
      const ch = String.fromCharCode(c);
      expect(ch.normalize()).toBe(ch);
      expect(/\p{M}|\p{Cc}|\p{Cf}|\p{Cs}|\p{Zl}|\p{Zp}/u.test(ch)).toBe(false);
      expect(visibleWidth(ch)).toBe(stringWidth(ch));
      chars.push(ch);
    }
    // 相邻的两个也不会连成一个字素簇
    const all = chars.join("");
    expect([...new Intl.Segmenter().segment(all)].length).toBe(chars.length);
  });

  test("matches string-width and wrap-ansi byte for byte on random text", () => {
    for (const fallback of [false, true]) {
      const r = rng(fallback ? 7 : 42);
      for (let n = 0; n < 1000; n++) {
        const text = randomText(r, fallback);
        expect(visibleWidth(text)).toBe(stringWidth(text));
        const width = 1 + Math.floor(r() * 40);
        expect(wrapText(text, width)).toEqual(wrapAnsi(text, width, WRAP).split("\n"));
      }
    }
  }, 20_000);

  test("wrapRows marks continuation rows of wrapped Chinese lines", () => {
    const rows = wrapRows("中文中文中文\n短", 8);
    expect(rows.map(visibleRow)).toEqual(["中文中文", "中文", "短"]);
    expect(rows[1]).not.toBe(visibleRow(rows[1]!));
    expect(rows[2]).toBe("短");
  });
});
