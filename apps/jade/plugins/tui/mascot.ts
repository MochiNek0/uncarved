// 标题左边的吉祥物：一个玉做的团子，按当前在做的事换表情、带一点动画；还有终端标签页标题上的 jade 标志。
// 不碰 Ink：动画由 App 统一重画推动（见 tui.ts 的 tick），这里每次按时间算出这一帧。
//
// 画布 15×6 个像素，每格字符上下两个像素（▀ 前景是上面、背景是下面），6 个像素高正好三行，和右边三行文字并排。
// 左边 9 列是身体，空一列，右边 5 列放表情以外的小东西（思考的三个点、工具的转圈、提问的感叹号、做完的 ✓……都用像素画）。画布宽度不随表情变，标题右边的文字不会跟着左右跳。
//
// 精度只有这么多，细节靠颜色：身体按光照着色（左上亮、边缘暗、一点高光），眼睛是深色的形状，
// 每个像素按 4×4 次采样算出眼睛盖住了多少、和身体的颜色混合，所以眼睛可以不按整格移动、眨眼也有中间的几帧。
// 身体外面是终端背景，颜色未知、没法混合，所以轮廓只按整格变（只有做完后蹦那一下会变）、混色只在身体里面做。
// 视线、睁眼的程度、颜色在状态之间缓动（Mascot），不会一下跳过去。

export const JADE = "#00a86b";

/** 正在做的事，决定吉祥物的样子 */
export type Mood =
  | "idle" // 空闲：偶尔眨眼、往旁边瞟一眼
  | "waiting" // 等模型、泛泛的工作中：眼睛左右看
  | "thinking" // 思考：眯眼望左上方琢磨、身体慢慢亮起来；想到了就转头看右上角，三个点一个个冒出来
  | "writing" // 输出正文或工具参数：低头，眼睛随打字左右移，旁边打字的点
  | "tool" // 运行工具：看向右边转着的圈，身上扫过一道光
  | "asking" // 弹出对话框等用户：睁大眼，头上一个闪烁的感叹号
  | "stopping" // 正在中断：眯眼，变成琥珀色，冒一滴汗
  | "happy"; // 刚做完：^ ^ 地原地蹦一下，落地一亮，转头看右边画出一个 ✓，再回过头冲你眨一只眼

/** 做完后笑多久 */
export const HAPPY_MS = 4000;

export interface MoodInput {
  /** 运行状态的标签（screen.busy）；不在运行时 undefined */
  busy?: string;
  /** 有对话框在等用户 */
  asking: boolean;
  /** 上一次正常做完的时间 */
  doneAt?: number;
}

export function moodOf(s: MoodInput, now: number): Mood {
  if (s.asking) return "asking";
  const b = s.busy;
  if (b === undefined) return s.doneAt !== undefined && now - s.doneAt < HAPPY_MS ? "happy" : "idle";
  if (b === "Interrupting") return "stopping";
  if (b === "Thinking") return "thinking";
  if (b.startsWith("Writing")) return "writing";
  if (b.startsWith("Running ")) return "tool";
  return "waiting";
}

// ---------- 颜色 ----------

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const hex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** 按 t（0–1）在一串颜色之间插值 */
const ramp = (stops: RGB[], t: number): RGB => {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i]!, stops[i + 1]!, x - i);
};

/** 从暗到亮的玉色；中断时换成琥珀色那一套 */
const JADE_RAMP = ["#004a33", "#00744c", JADE, "#2ccc8a", "#8eeec0"].map(rgb);
const AMBER_RAMP = ["#5a3a00", "#9a6500", "#e0a526", "#f4c75a", "#fde4a0"].map(rgb);
const SPECULAR = rgb("#effff6");
const EYE = rgb("#0b2219");
const PALE = rgb("#b6f2d4");
const DEEP = rgb("#00744c");
const BANG = [rgb("#f5c518"), rgb("#fff1a8")];
const SWEAT = rgb("#8fd3ff");
/** 蹦起来时地上的影子：身体外面没法和终端背景混合，用一个暗的玉色 */
const SHADOW = mix(DEEP, EYE, 0.55);

// ---------- 形状 ----------

const W = 15;
/** 右边小东西的第一列：和身体之间空一列，不贴着 */
const SIDE = 10;
const H = 6;
/** 身体的轮廓（9 列），轮廓外是终端背景 */
const MASK = ["..#####..", ".#######.", "#########", "#########", "#########", ".#######."];
const CX = 4.5;

/**
 * 身体的几种样子：平时、蹲下（压扁，头顶低一格）、跳在空中（离地一格，脚下一块影子）。
 * top/bottom 是身体占的像素行 [top, bottom)，光照按它算；dy 是眼睛跟着上下挪多少
 */
interface Shape {
  mask: string[];
  top: number;
  bottom: number;
  dy: number;
}
const SHAPES = {
  rest: { mask: MASK, top: 0, bottom: 6, dy: 0 },
  crouch: { mask: [".........", ".#######.", "#########", "#########", "#########", ".#######."], top: 1, bottom: 6, dy: 1 },
  air: { mask: ["..#####..", ".#######.", "#########", "#########", ".#######.", "........."], top: 0, bottom: 5, dy: -1 },
} satisfies Record<string, Shape>;

/** 做完后的一跳：蹲下蓄力 → 跳起 → 落地压扁一下 → 站好（t 是进入 happy 之后的毫秒） */
const HOP = { crouch: 90, air: 380, land: 470 };
function shapeAt(mood: Mood, t: number): Shape {
  if (mood !== "happy" || t >= HOP.land) return SHAPES.rest;
  return t < HOP.crouch || t >= HOP.air ? SHAPES.crouch : SHAPES.air;
}
/**
 * 两只眼睛：中心的 x、下沿的 y（像素坐标，像素 (x, y) 覆盖 [x, x+1)×[y, y+1)），宽 1、高 2 个像素。
 * 停住的位置都正好对齐像素，眼睛是清楚的两块；只有移动、眨眼的中间几帧才会混出过渡色
 */
const EYES_X = [2.5, 6.5];
const EYE_BOTTOM = 4;
const EYE_H = 2;

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
const gauss = (dx: number, dy: number, s: number) => Math.exp(-(dx * dx + dy * dy) / (2 * s * s));

/** 会在状态之间缓动的量 */
export interface Pose {
  /** 视线：x 向右、y 向下，单位是像素（停住时取整数，眼睛才清楚） */
  gx: number;
  gy: number;
  /** 睁眼的程度，1 正常（2 像素高），1.5 睁大，0 闭上（剩 1 像素的一条线） */
  open: number;
  /** 0 普通的眼睛，1 笑眯眯的 ^ ^ */
  happy: number;
  /** 只有左眼变成 ^：眨一只眼 */
  wink: number;
  /** 0 玉色，1 琥珀色 */
  tint: number;
  /** 整体提亮（思考时一闪一闪） */
  glow: number;
}

const REST: Pose = { gx: 0, gy: 0, open: 1, happy: 0, wink: 0, tint: 0, glow: 0 };

// ---------- 时间轴 ----------

const ease = (now: number, keys: [number, number][], period: number): number => {
  // keys：[时刻, 值]，时刻在 [0, period) 里递增；相邻两个之间平滑过渡，最后一个过渡回第一个
  const t = now % period;
  for (let i = 0; i < keys.length; i++) {
    const [t0, v0] = keys[i]!;
    const [t1raw, v1] = keys[(i + 1) % keys.length]!;
    const t1 = i + 1 < keys.length ? t1raw : t1raw + period;
    if (t >= t0 && t < t1) return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
  }
  return keys[0]![1];
};
/** 关键帧之间停一会儿再动：每个值先停 hold 毫秒，再用 move 毫秒移到下一个 */
const steps = (values: number[], hold: number, move: number): [[number, number][], number] => {
  const keys: [number, number][] = [];
  values.forEach((v, i) => {
    keys.push([i * (hold + move), v], [i * (hold + move) + hold, v]);
  });
  return [keys, values.length * (hold + move)];
};

/** 每隔多久眨一次眼，眨一下多久 */
const BLINK_EVERY = 4200;
const BLINK_MS = 220;
/** 空闲时每隔多久往旁边瞟一眼，从什么时候到什么时候 */
const GLANCE_EVERY = 11_000;
const GLANCE: [number, number] = [7000, 8600];

/** 眨眼：返回睁眼程度的系数。每第三次连眨两下 */
function blink(now: number): number {
  const n = Math.floor(now / BLINK_EVERY);
  const t = now % BLINK_EVERY;
  const one = (t0: number) => (t >= t0 && t < t0 + BLINK_MS ? 1 - Math.sin((Math.PI * (t - t0)) / BLINK_MS) : 1);
  return Math.min(one(0), n % 3 === 2 ? one(BLINK_MS + 90) : 1);
}

/** 做完后什么时候回过头眨眼（落地后先看着 ✓ 画出来） */
const WINK_AT = 1500;

/** 这个状态此刻想要的样子（Mascot 往这里缓动）；t 是进入这个状态之后的毫秒，只有 happy 用 */
export function goal(mood: Mood, now: number, t = HAPPY_MS / 2): Pose {
  switch (mood) {
    case "idle": {
      const t = now % GLANCE_EVERY;
      const look = t >= GLANCE[0] && t < GLANCE[1] ? -1 : 0;
      return { ...REST, gx: look, open: blink(now) };
    }
    case "waiting": {
      const [keys, period] = steps([0, -1, 0, 1], 600, 350);
      return { ...REST, gx: ease(now, keys, period), open: blink(now) };
    }
    case "thinking": {
      // 琢磨：眯起眼往左上方望，身体一点点亮起来（在攒想法）；
      // 想到了：睁开眼转向右上角，看着三个点一个个冒出来，攒的亮光随着点冒出来慢慢退掉
      const gx = ease(now, [[0, -1], [THINK.ponder - 350, -1], [THINK.ponder, 1], [THINK.period - 350, 1]], THINK.period);
      const open = ease(now, [[0, 0.5], [THINK.ponder - 350, 0.5], [THINK.ponder, 1], [THINK.period - 350, 1]], THINK.period);
      const glow = ease(now, [[0, 0], [THINK.ponder, 0.75], [THINK.dot(2), 0]], THINK.period);
      return { ...REST, gx, gy: -1, open: open * blink(now + 1700), glow };
    }
    case "writing": {
      // 读着刚写的字：一行里从左往右扫，到头回来
      const [keys, period] = steps([-1, 0, 1], 260, 140);
      return { ...REST, gx: ease(now, keys, period), gy: 1, open: 0.5 + 0.5 * blink(now + 600) };
    }
    case "tool":
      return { ...REST, gx: 1, open: blink(now + 900) };
    case "asking":
      return { ...REST, open: 1.5 * blink(now + 2500) };
    case "stopping":
      return { ...REST, open: 0, tint: 1 };
    case "happy": {
      // 只有眼睛，不加嘴和脸红：别的表情都只靠眼睛，加了反而不像同一个。
      // 蹦的时候 ^ ^；落地那一下身体一亮，睁眼看右边的 ✓ 画出来；然后回过头，左眼 ^ 冲你眨一下
      const glow = t >= HOP.air ? Math.exp(-(t - HOP.air) / 260) : 0;
      if (t < HOP.land) return { ...REST, happy: 1, glow };
      if (t < WINK_AT) return { ...REST, gx: 1, glow };
      return { ...REST, wink: 1 };
    }
  }
}

/** 画一帧：返回 6 行、每行 15 个颜色（"#rrggbb"），undefined 是透明（终端背景）；t 同 goal */
export function paint(p: Pose, mood: Mood, now: number, t = HAPPY_MS / 2): (string | undefined)[][] {
  const shape = shapeAt(mood, t);
  const cy = (shape.top + shape.bottom) / 2;
  const half = (shape.bottom - shape.top) / 2;
  const ramp_ = (t: number) => mix(ramp(JADE_RAMP, t), ramp(AMBER_RAMP, t), p.tint);
  const grid: (RGB | undefined)[][] = Array.from({ length: H }, () => Array<RGB | undefined>(W).fill(undefined));
  // 工具运行时，一道光从左往右扫过身体
  const sweep = mood === "tool" ? ((now % 1400) / 1400) * 16 - 4 : undefined;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < 9; x++) {
      if (shape.mask[y]?.[x] !== "#") continue;
      const nx = (x + 0.5 - CX) / 4.5;
      const ny = (y + 0.5 - cy) / half;
      const r = Math.max(Math.abs(nx), Math.abs(ny) * 0.9, Math.hypot(nx, ny) * 0.82);
      let light = 0.62 - 0.3 * ny - 0.14 * nx - 0.32 * smooth((r - 0.55) / 0.45) + 0.18 * p.glow;
      if (sweep !== undefined) light += 0.22 * Math.exp(-(((x - y * 0.5 - sweep) / 0.8) ** 2));
      let c = ramp_(light);
      // 高光：左上角一个像素，旁边一圈淡淡的
      c = mix(c, SPECULAR, 0.9 * gauss(x - 2, y - shape.top - 1, 0.45));
      // 眼睛：4×4 次采样，算出盖住了多少
      let cover = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          cover += eyeAt(p, px, py - shape.dy) / 16;
        }
      c = mix(c, mix(EYE, ramp_(0.05), p.tint * 0.4), Math.min(1, cover));
      grid[y]![x] = c;
    }
  // 跳在空中时脚下一块影子
  if (shape === SHAPES.air) for (let x = 3; x < 6; x++) grid[5]![x] = SHADOW;
  for (const [x, y, c] of extras(mood, now, t)) grid[y]![x] = c;
  return grid.map((row) => row.map((c) => (c ? hex(c) : undefined)));
}

/** 眼睛在 (px, py) 处的覆盖（0 或 1）：普通的眼睛和 ^ 形的笑眼按 happy 混合（左眼还算上 wink） */
function eyeAt(p: Pose, px: number, py: number): number {
  let best = 0;
  for (const [i, bx] of EYES_X.entries()) {
    const happy = i === 0 ? Math.max(p.happy, p.wink) : p.happy;
    // 笑分两步：先是下眼皮往上推，眼睛压成上面一格的一条线（连续的）；
    // 推到头之后一下子变成 ^（像素画按帧换形状，滑过去的中间几帧是糊的）
    const smile = happy > 0.6;
    // 变成 ^ 时两只眼睛各往外一格：^ 有三格宽，不挪开的话两只里边的眼角只隔一格，连成一排锯齿
    // ^ 对齐整格：从别的表情缓过来时视线还没回正，不对齐的话 ^ 是糊的
    const ex = smile ? Math.round(bx + p.gx - 0.5) + 0.5 + (i === 0 ? -1 : 1) : bx + p.gx;
    const bottom = smile ? Math.round(EYE_BOTTOM + p.gy) : EYE_BOTTOM + p.gy;
    if (Math.abs(px - ex) < 0.5) {
      // 闭眼是上眼皮往下：下沿不动，高度变小，最少留 1 像素的一条线
      const lower = bottom - Math.min(1, happy / 0.6);
      const upper = Math.min(bottom - Math.max(1, EYE_H * p.open), lower - 1);
      if (py >= upper && py < lower) best = 1;
    }
    if (smile && Math.abs(Math.abs(px - ex) - 1) < 0.5 && py >= bottom - 1 && py < bottom) best = 1;
  }
  return best;
}

/** 右边的小东西：[列, 行, 颜色]，列是 SIDE 起的 0–4 */
function extras(mood: Mood, now: number, t: number): [number, number, RGB][] {
  return side(mood, now, t).map(([x, y, c]) => [SIDE + x, y, c]);
}

/** ✓ 的五个像素，按笔画的顺序：短的一笔往右下，长的一笔往右上 */
const CHECK: [number, number][] = [
  [0, 3],
  [1, 4],
  [2, 3],
  [3, 2],
  [4, 1],
];
/** ✓ 落地后一笔画出来，每个像素隔多久；画完过一会儿一道光沿着笔画走一遍；最后按笔画的顺序暗下去消失 */
const CHECK_STEP = 55;
const CHECK_SHINE = 1900;
const CHECK_FADE = HAPPY_MS - 600;

function check(t: number): [number, number, RGB][] {
  const white = rgb("#ffffff");
  return CHECK.flatMap(([x, y], i) => {
    const age = t - (HOP.land + i * CHECK_STEP);
    if (age < 0) return [];
    // 刚画上的是白的笔尖，很快沉成淡玉色
    let c = mix(PALE, white, Math.exp(-age / 120));
    // 一道光：亮点沿着笔画走过去
    c = mix(c, white, 0.85 * Math.exp(-(((t - CHECK_SHINE) / 60 - i) ** 2)));
    // 消失：一个个暗下去再拿掉（外面是终端背景，没法渐隐）
    const out = (t - CHECK_FADE - i * 70) / 280;
    if (out >= 1) return [];
    if (out > 0) c = mix(c, DEEP, out);
    return [[x, y, c] as [number, number, RGB]];
  });
}

const fade = (t: number) => ramp([DEEP, rgb(JADE), PALE], t);

/**
 * 思考的节奏（一圈的毫秒数）：先琢磨 ponder，然后三个点隔 gap 一个个冒出来；
 * 三个都在了停一会儿，从 dim 起一起暗下去、拿掉，再接着琢磨
 */
const THINK = {
  period: 4800,
  ponder: 1700,
  gap: 550,
  /** 第 i 个点冒出来的时刻 */
  dot: (i: number) => THINK.ponder + 250 + i * THINK.gap,
  dim: 4200,
  /** 暗下去用多久：之后拿掉（外面是终端背景，没法渐隐） */
  fade: 400,
};
/** 三个点：在右上方从左往右排成一排，和往右上看的眼睛同一高度附近，像省略号 */
const DOTS: [number, number][] = [
  [0, 1],
  [2, 1],
  [4, 1],
];

function dots(now: number): [number, number, RGB][] {
  const t = now % THINK.period;
  const out = (t - THINK.dim) / THINK.fade;
  if (out >= 1) return [];
  return DOTS.flatMap(([x, y], i) => {
    const age = t - THINK.dot(i);
    if (age < 0) return [];
    // 冒出来时白一下，很快沉成淡玉色
    let c = mix(fade(0.85), rgb("#ffffff"), Math.exp(-age / 140));
    if (out > 0) c = mix(c, DEEP, out);
    return [[x, y, c] as [number, number, RGB]];
  });
}

function side(mood: Mood, now: number, t: number): [number, number, RGB][] {
  switch (mood) {
    case "happy":
      return check(t);
    case "thinking":
      return dots(now);
    case "writing": {
      // 打字的点：一个个亮起来，亮过之后慢慢暗下去
      const t = (now % 1200) / 1200;
      return [0, 1, 2].flatMap((x) => {
        const age = t - x * 0.18;
        return age >= 0 && age < 0.75 ? [[x, 5, fade(1 - Math.max(0, age - 0.25) * 2)] as [number, number, RGB]] : [];
      });
    }
    case "tool": {
      // 彗星一样转圈：亮的头，后面跟着越来越暗的尾巴
      const ring: [number, number][] = [
        [1, 1],
        [2, 2],
        [2, 3],
        [1, 4],
        [0, 3],
        [0, 2],
      ];
      const head = Math.floor(now / 90) % ring.length;
      return [0, 1, 2, 3].map((k) => {
        const [x, y] = ring[(head - k + ring.length) % ring.length]!;
        return [x, y, fade(1 - k / 3.2)];
      });
    }
    case "asking": {
      // 感叹号在两种黄之间呼吸
      const c = mix(BANG[0]!, BANG[1]!, 0.5 + 0.5 * Math.sin(now / 160));
      return [0, 1, 2, 4].map((y) => [1, y, c]);
    }
    case "stopping":
      // 汗珠挂在头的右上角，贴着身体
      return [
        [-1, 0, SWEAT],
        [-1, 1, mix(SWEAT, rgb("#ffffff"), 0.4)],
      ];
    default:
      return [];
  }
}

/**
 * 有状态的动画：每次 frame 把 Pose 往当前状态想要的样子缓动一点，所以换状态时眼睛是滑过去的。
 * 眨眼这种很快的动作直接用目标值，不缓动
 */
export class Mascot {
  pose: Pose = { ...REST };
  #last?: number;
  #mood?: Mood;
  /** 进入当前状态的时刻：做完后那一套动作按它排时间 */
  #since = 0;

  frame(mood: Mood, now: number): (string | undefined)[][] {
    if (mood !== this.#mood) {
      this.#mood = mood;
      this.#since = now;
    }
    const t = now - this.#since;
    const want = goal(mood, now, t);
    const dt = this.#last === undefined ? 1e9 : Math.max(0, now - this.#last);
    this.#last = now;
    const k = 1 - Math.exp(-dt / 110);
    const p = this.pose;
    for (const key of ["gx", "gy", "happy", "wink", "tint"] as const) p[key] += (want[key] - p[key]) * k;
    p.open = want.open < p.open ? want.open : p.open + (want.open - p.open) * (1 - Math.exp(-dt / 50));
    p.glow = want.glow;
    return paint(p, mood, now, t);
  }

  /** 还在往目标缓动（空闲时也要接着重画几帧） */
  moving(mood: Mood, now: number): boolean {
    const want = goal(mood, now, mood === this.#mood ? now - this.#since : 0);
    const p = this.pose;
    return (["gx", "gy", "happy", "wink", "tint", "open"] as const).some((k) => Math.abs(want[k] - p[k]) > 0.02);
  }
}

/** 一段同样颜色的字符；fg、bg 是颜色，没有就是终端默认 */
export interface Run {
  text: string;
  fg?: string;
  bg?: string;
}

/** 把像素合成半格字符，每一行是若干段同色的字符 */
export function cells(grid: (string | undefined)[][]): Run[][] {
  const out: Run[][] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y]!;
    const bottom = grid[y + 1] ?? [];
    const line: Run[] = [];
    for (let x = 0; x < top.length; x++) {
      const t = top[x];
      const b = bottom[x];
      const cell: Run =
        !t && !b ? { text: " " }
        : t === b ? { text: "█", fg: t }
        : !t ? { text: "▄", fg: b }
        : !b ? { text: "▀", fg: t }
        : { text: "▀", fg: t, bg: b };
      const last = line.at(-1);
      if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text;
      else line.push(cell);
    }
    out.push(line);
  }
  return out;
}

/** 动画帧之间隔多久 */
export const FRAME_MS = 50;

/**
 * 不在运行时，下一次需要重画还要多久（毫秒）：缓动没结束、正在眨眼或瞟眼时按帧画，
 * 否则等到下一次眨眼、瞟眼或笑完。运行中由 App 定时重画，用不到这个
 */
export function nextChange(mood: Mood, now: number, doneAt?: number, moving = false): number {
  if (moving) return FRAME_MS;
  if (mood === "asking" || mood === "happy") {
    const end = mood === "happy" && doneAt !== undefined ? doneAt + HAPPY_MS - now : Infinity;
    return Math.max(16, Math.min(FRAME_MS, end));
  }
  const tb = now % BLINK_EVERY;
  // 眨眼（含连眨的第二下）期间按帧画
  if (tb < 2 * BLINK_MS + 90) return FRAME_MS;
  const tg = now % GLANCE_EVERY;
  const toGlance = tg < GLANCE[0] ? GLANCE[0] - tg : tg < GLANCE[1] ? GLANCE[1] - tg : GLANCE_EVERY - tg + GLANCE[0];
  return Math.max(16, Math.min(BLINK_EVERY - tb, toGlance));
}

// ---------- 终端标题 ----------

/** jade 的标志：一块玉 */
export const LOGO = "◆";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 终端标签页标题：空闲时是标志，运行中换成转圈，等用户时加感叹号，在别的标签页里也能看出 jade 在做什么。
 * dir 是当前目录的名字
 */
export function title(mood: Mood, dir: string, now: number): string {
  const mark =
    mood === "asking" ? `${LOGO}!`
    : mood === "idle" || mood === "happy" ? LOGO
    : SPIN[Math.floor(now / 250) % SPIN.length]!;
  return `${mark} jade · ${dir}`;
}
