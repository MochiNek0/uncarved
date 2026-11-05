// 显示用的小工具：截断和 ANSI 颜色。从旧 jade 的 ui/render.ts、ui/screen.ts 复制过来：
// 插件之间不共享代码（只能共享类型），所以 shell 插件也有一份。

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// 设了 NO_COLOR（非空）或标准输出不是终端时不输出颜色，见 https://no-color.org
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
/**
 * 每种样式用自己的关闭码，不用 \x1b[0m 全部重置：外面套着别的样式时，后面的文字仍保持外层样式。
 * 里面出现同一个关闭码（例如 dim 里套 bold，两者都用 22 关闭）时紧接着重新打开外层的样式
 */
const paint = (open: string, close: string) => (s: string) =>
  colors ? `\x1b[${open}m${s.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m` : s;
export const dim = paint("2", "22");
export const red = paint("31", "39");
export const green = paint("32", "39");
export const yellow = paint("33", "39");
export const bold = paint("1", "22");
