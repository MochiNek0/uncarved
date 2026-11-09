// 吉祥物：按运行状态选表情，按状态缓动、着色，像素合成半格字符，终端标题

import { expect, test } from "bun:test";
import { cells, goal, HAPPY_MS, LOGO, Mascot, moodOf, nextChange, paint, title, type Mood } from "../plugins/tui/mascot.ts";

const MOODS: Mood[] = ["idle", "waiting", "thinking", "writing", "tool", "asking", "stopping", "happy"];
const text = (grid: (string | undefined)[][]) => cells(grid).map((row) => row.map((r) => r.text).join(""));
/** 停在这个状态足够久之后的一帧 */
const settled = (mood: Mood, now: number) => {
  const m = new Mascot();
  for (let t = now; t < now + 2000; t += 50) m.frame(mood, t);
  return m.frame(mood, now + 2000);
};
const lum = (c: string | undefined) => (c ? parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16) : -1);

test("the busy label picks the mood", () => {
  const at = (busy: string | undefined, o: { asking?: boolean; doneAt?: number } = {}) =>
    moodOf({ busy, asking: o.asking ?? false, doneAt: o.doneAt }, 10_000);
  expect(at(undefined)).toBe("idle");
  expect(at("Working")).toBe("waiting");
  expect(at("Waiting for the model")).toBe("waiting");
  expect(at("Thinking")).toBe("thinking");
  expect(at("Writing (3k chars)")).toBe("writing");
  expect(at("Running shell")).toBe("tool");
  expect(at("Interrupting")).toBe("stopping");
  expect(at("Running shell", { asking: true })).toBe("asking");
  expect(at(undefined, { doneAt: 10_000 - 100 })).toBe("happy");
  expect(at(undefined, { doneAt: 10_000 - HAPPY_MS })).toBe("idle");
});

test("every frame is three rows of fifteen cells with the same outline", () => {
  // happy 的轮廓只在刚进入的那一跳里变（见下面的测试），settled 已经站好了
  for (const m of MOODS)
    for (let now = 0; now < 5000; now += 130) {
      const rows = text(settled(m, now));
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r).toHaveLength(15);
      // 身体的轮廓不变，只有身体里的颜色在变
      expect(rows.map((r) => r.slice(0, 9).replace(/[▀▄█]/g, "#"))).toEqual([" ####### ", "#########", "#########"]);
    }
});

test("resting eyes are crisp: two dark pixels tall, the same color", () => {
  const grid = settled("idle", 0); // 停在 2000ms：不在眨眼
  const eye = grid[2]![2];
  expect([grid[3]![2], grid[2]![6], grid[3]![6]]).toEqual([eye, eye, eye]);
  expect(lum(eye)).toBeLessThan(lum(grid[2]![4]) / 3);
});

test("a blink closes the eyes from the top, leaving a line", () => {
  const p = { ...goal("idle", 110), gx: 0, gy: 0, happy: 0, tint: 0, glow: 0 };
  expect(p.open).toBeLessThan(0.1);
  const grid = paint(p, "idle", 110);
  expect(lum(grid[2]![2])).toBeGreaterThan(lum(grid[3]![2]) * 3);
});

test("changing mood glides the eyes through in-between frames", () => {
  const m = new Mascot();
  for (let t = 0; t < 1000; t += 50) m.frame("idle", t);
  m.frame("tool", 1050);
  expect(m.pose.gx).toBeGreaterThan(0);
  expect(m.pose.gx).toBeLessThan(1);
  expect(m.moving("tool", 1050)).toBe(true);
  for (let t = 1100; t < 2500; t += 50) m.frame("tool", t);
  expect(m.moving("tool", 2500)).toBe(false);
});

test("stopping turns the bot amber", () => {
  const grid = settled("stopping", 1000);
  const c = grid[4]![4]!;
  expect(parseInt(c.slice(1, 3), 16)).toBeGreaterThan(parseInt(c.slice(3, 5), 16));
});

test("idle wakes up per frame only while blinking or gliding", () => {
  expect(nextChange("idle", 1000)).toBe(3200);
  expect(nextChange("idle", 4250)).toBe(50);
  expect(nextChange("idle", 1000, undefined, true)).toBe(50);
  expect(nextChange("happy", 1000, 1000 - HAPPY_MS + 20)).toBe(20);
});

test("the terminal title shows the logo, a spinner while busy, and ! when asking", () => {
  expect(title("idle", "uncarved", 0)).toBe(`${LOGO} jade · uncarved`);
  expect(title("asking", "uncarved", 0)).toBe(`${LOGO}! jade · uncarved`);
  expect(title("thinking", "uncarved", 0)).not.toBe(title("thinking", "uncarved", 250));
});

/** 从空闲进入 happy，按帧推进，返回进入后 at 毫秒那一帧（和停下时的 Mascot） */
const doneAfter = (at: number, from: Mood = "idle") => {
  const m = new Mascot();
  for (let t = 0; t < 2000; t += 50) m.frame(from, t);
  let grid = m.frame("happy", 2000);
  for (let t = 2050; t <= 2000 + at; t += 50) grid = m.frame("happy", t);
  return { m, grid, dark: (x: number, y: number) => lum(grid[y]![x]) < 150 };
};
const outline = (grid: (string | undefined)[][]) => grid.map((r) => r.slice(0, 9).map((c) => (c ? "#" : ".")).join(""));

test("finishing hops: crouch, up in the air over a shadow, land squashed, then stand", () => {
  const crouch = [".........", ".#######.", "#########", "#########", "#########", ".#######."];
  expect(outline(doneAfter(0).grid)).toEqual(crouch);
  const air = doneAfter(200).grid;
  expect(outline(air)).toEqual(["..#####..", ".#######.", "#########", "#########", ".#######.", "...###..."]);
  // 脚下那块是暗的影子，不是身体
  expect(lum(air[5]![4])).toBeLessThan(lum(air[4]![4]));
  expect(outline(doneAfter(400).grid)).toEqual(crouch);
  expect(outline(doneAfter(600).grid)).toEqual(["..#####..", ".#######.", "#########", "#########", "#########", ".#######."]);
});

test("the eyes squeeze into a line on the crouch and are crisp ^ ^ in the air", () => {
  // 蹲下：身体矮了一格，眼睛跟着往下一格，下眼皮推上来只剩上面一格
  const crouch = doneAfter(0);
  expect([crouch.dark(2, 3), crouch.dark(6, 3), crouch.dark(2, 4), crouch.dark(6, 4)]).toEqual([true, true, false, false]);
  // 空中：眼睛跟着往上一格，两只 ^ 各往外挪一格
  const { dark, grid } = doneAfter(200);
  expect([dark(1, 1), dark(0, 2), dark(2, 2), dark(1, 2)]).toEqual([true, true, true, false]);
  expect([dark(7, 1), dark(6, 2), dark(8, 2), dark(7, 2)]).toEqual([true, true, true, false]);
  for (const y of [1, 2]) for (let x = 0; x < 9; x++) expect(lum(grid[y]![x]) < 100 || lum(grid[y]![x]) > 160).toBe(true);
  // 从低头的 writing 缓过来时视线还没回正，^ ^ 也要在
  const g = doneAfter(200, "writing");
  expect(g.m.pose.gy).not.toBe(0);
  expect([g.dark(1, 1), g.dark(0, 2), g.dark(2, 2), g.dark(7, 1), g.dark(6, 2), g.dark(8, 2)]).toEqual([true, true, true, true, true, true]);
});

test("after landing it watches a ✓ draw itself on the right, then winks", () => {
  const SIDE = 10;
  const tick = (grid: (string | undefined)[][]) => grid.flatMap((row, y) => row.slice(SIDE).flatMap((c, x) => (c ? [`${x},${y}`] : [])));
  const CHECK = ["4,1", "3,2", "0,3", "2,3", "1,4"];
  // 一笔一笔画出来：先是短的那一笔
  expect(tick(doneAfter(500).grid)).toEqual(["0,3"]);
  const watching = doneAfter(1000);
  expect(tick(watching.grid)).toEqual(CHECK);
  // 画的时候眼睛看着右边
  expect(watching.m.pose.gx).toBeGreaterThan(0.9);
  // 眨眼：左眼 ^，右眼照常睁着，没有嘴和脸红
  const { dark, grid } = doneAfter(2500);
  expect([dark(1, 2), dark(0, 3), dark(2, 3), dark(1, 3)]).toEqual([true, true, true, false]);
  expect([dark(6, 2), dark(6, 3), dark(7, 2)]).toEqual([true, true, false]);
  for (const y of [4, 5]) for (let x = 2; x <= 6; x++) expect(dark(x, y)).toBe(false);
  for (const row of grid) for (const c of row.slice(0, 9)) if (c) expect(parseInt(c.slice(1, 3), 16)).toBeLessThan(parseInt(c.slice(3, 5), 16));
  expect(tick(grid)).toEqual(CHECK);
  // 快结束时 ✓ 按笔画顺序消失
  expect(tick(doneAfter(HAPPY_MS - 50).grid).length).toBeLessThan(CHECK.length);
});

test("thinking ponders up-left, then three pixel dots appear one by one in a row", () => {
  // 琢磨：眯眼看左上方、身体越来越亮，旁边什么都没有
  const ponder = goal("thinking", 1000);
  expect([ponder.gx, ponder.gy, ponder.open]).toEqual([-1, -1, 0.5]);
  expect(goal("thinking", 1300).glow).toBeGreaterThan(goal("thinking", 200).glow);
  // 想到了：转向右上角
  const look = goal("thinking", 2600);
  expect([look.gx, look.gy]).toEqual([1, -1]);
  // 右边的点（settled 画的是 now + 2000 那一帧，往前挪一圈）
  const dots = (now: number) =>
    settled("thinking", now + 2800).flatMap((row, y) => row.flatMap((c, x) => (x >= 10 && c ? [`${x - 10},${y}`] : [])));
  expect(dots(1000)).toEqual([]);
  expect(dots(2100)).toEqual(["0,1"]);
  expect(dots(2600)).toEqual(["0,1", "2,1"]);
  expect(dots(3300)).toEqual(["0,1", "2,1", "4,1"]);
  expect(dots(4700)).toEqual([]);
  // 只有像素，标题行里没有别的字符
  expect(text(settled("thinking", 3300)).every((row) => /^[ ▀▄█]*$/.test(row))).toBe(true);
});

test("side effects keep a blank column away from the body", () => {
  for (const m of ["thinking", "writing", "tool", "asking", "happy"] as Mood[])
    for (let now = 0; now < 3000; now += 40) for (const row of settled(m, now)) expect(row[9]).toBeUndefined();
});
