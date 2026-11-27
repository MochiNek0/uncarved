// Windows 上的截屏和键鼠：一个常驻的 PowerShell 进程，用 Add-Type 编译一段 C#，按行收命令、按行回结果。
// 不需要装任何东西。命令一次一条（工具是 exclusive 的）；等待中被取消或超时就结束进程，下次再启动，
// 免得迟到的回复和下一条命令对不上。
//
// DPI：进程先声明 per-monitor DPI aware，截屏和 SetCursorPos 都按物理像素算；不声明的话在缩放 125%/150% 的屏幕上
// 截到的图和点击的位置对不上。只截主屏。
//
// 急停：每个键鼠动作之前看鼠标是不是在屏幕左上角，是的话不执行，回 STOP（用户把鼠标甩到角上就能让它停）。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface Screen {
  png: Buffer;
  /** 屏幕的物理像素 */
  width: number;
  height: number;
  /** 交给模型的图的大小（按 maxSide 缩小后） */
  shotWidth: number;
  shotHeight: number;
}

export type Button = "left" | "right" | "middle";

export interface Driver {
  screenshot(maxSide: number, signal: AbortSignal): Promise<Screen>;
  /** 坐标是屏幕的物理像素 */
  click(x: number, y: number, button: Button, count: number, signal: AbortSignal): Promise<void>;
  type(text: string, signal: AbortSignal): Promise<void>;
  /** 虚拟键码，按顺序按下、倒序松开 */
  key(vks: number[], signal: AbortSignal): Promise<void>;
  /** notches > 0 往下滚 */
  scroll(x: number, y: number, notches: number, signal: AbortSignal): Promise<void>;
  close(): void;
}

/** 用户把鼠标移到了左上角 */
export class StoppedError extends Error {}

const READY_MS = 30_000;
const COMMAND_MS = 15_000;

const CSHARP = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class JadeComputer {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

  struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }

  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT { type = 0 };
    i.u.mi.dwFlags = flags; i.u.mi.mouseData = data;
    return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
    return i;
  }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "); a window running as administrator may have focus");
  }
  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C;
  }

  static string Shot(int maxSide) {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    using (var full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
      double s = Math.Min(1.0, (double)maxSide / Math.Max(w, h));
      int sw = Math.Max(1, (int)Math.Round(w * s)), sh = Math.Max(1, (int)Math.Round(h * s));
      using (var small = new Bitmap(sw, sh, PixelFormat.Format24bppRgb))
      using (var ms = new MemoryStream()) {
        using (var g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(full, 0, 0, sw, sh);
        }
        small.Save(ms, ImageFormat.Png);
        return "OK " + w + " " + h + " " + sw + " " + sh + " " + Convert.ToBase64String(ms.ToArray());
      }
    }
  }

  public static string Run(string line) {
    var a = line.Split(' ');
    if (a[0] == "shot") return Shot(int.Parse(a[1]));
    POINT p;
    if (GetCursorPos(out p) && p.X <= 2 && p.Y <= 2) return "STOP";
    switch (a[0]) {
      case "click": {
        SetCursorPos(int.Parse(a[1]), int.Parse(a[2]));
        Thread.Sleep(30);
        uint down = a[3] == "right" ? 0x8u : a[3] == "middle" ? 0x20u : 0x2u;
        int n = int.Parse(a[4]);
        for (int k = 0; k < n; k++) Send(Mouse(down, 0), Mouse(down << 1, 0));
        return "OK";
      }
      case "scroll": {
        SetCursorPos(int.Parse(a[1]), int.Parse(a[2]));
        Thread.Sleep(30);
        Send(Mouse(0x800, unchecked((uint)(-120 * int.Parse(a[3])))));
        return "OK";
      }
      case "type": {
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(a[1]));
        foreach (char c in text) {
          if (c == '\r') continue;
          if (c == '\n') Send(Key(0x0D, 0, 0), Key(0x0D, 0, 2));
          else Send(Key(0, c, 4), Key(0, c, 4 | 2));
          Thread.Sleep(5);
        }
        return "OK";
      }
      case "key": {
        var vks = new ushort[a.Length - 1];
        for (int k = 1; k < a.Length; k++) vks[k - 1] = ushort.Parse(a[k]);
        foreach (var vk in vks) Send(Key(vk, 0, Extended(vk) ? 1u : 0u));
        for (int k = vks.Length - 1; k >= 0; k--) Send(Key(vks[k], 0, (Extended(vks[k]) ? 1u : 0u) | 2));
        return "OK";
      }
    }
    return "ERR unknown command";
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${CSHARP}
'@
[JadeComputer]::Init()
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $r = [JadeComputer]::Run($line) } catch { $r = 'ERR ' + ($_.Exception.GetBaseException().Message -replace '\\s+', ' ') }
  [Console]::Out.WriteLine($r)
}
`;

export function windowsDriver(): Driver {
  let proc: { child: ChildProcess; lines: AsyncIterator<string> } | undefined;

  const kill = () => {
    proc?.child.kill();
    proc = undefined;
  };

  /** 等一行输出；取消或超时就结束进程 */
  async function next(p: NonNullable<typeof proc>, ms: number, signal: AbortSignal): Promise<string> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.aborted ? signal.reason : new Error(`the PowerShell helper did not answer within ${ms / 1000}s`));
      stop.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const r = await Promise.race([p.lines.next(), aborted]);
      if (r.done) throw new Error("the PowerShell helper exited");
      return r.value;
    } catch (err) {
      kill();
      throw err;
    } finally {
      stop.removeEventListener("abort", onAbort);
    }
  }

  async function start(signal: AbortSignal) {
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", () => {});
    const p = { child, lines: createInterface({ input: child.stdout! })[Symbol.asyncIterator]() };
    proc = p;
    let first: string;
    try {
      first = await next(p, READY_MS, signal);
    } catch (err) {
      throw stderr ? new Error(`could not start the PowerShell helper: ${stderr.trim()}`) : err;
    }
    if (first !== "READY") {
      kill();
      throw new Error(`could not start the PowerShell helper: ${first} ${stderr.trim()}`);
    }
    return p;
  }

  async function run(cmd: string, signal: AbortSignal): Promise<string> {
    const p = proc ?? (await start(signal));
    p.child.stdin!.write(cmd + "\n");
    const r = await next(p, COMMAND_MS, signal);
    if (r === "STOP") throw new StoppedError("stopped by the user");
    if (r.startsWith("ERR ")) throw new Error(r.slice(4));
    return r;
  }

  return {
    async screenshot(maxSide, signal) {
      const [, w, h, sw, sh, data] = (await run(`shot ${maxSide}`, signal)).split(" ");
      return { png: Buffer.from(data!, "base64"), width: +w!, height: +h!, shotWidth: +sw!, shotHeight: +sh! };
    },
    async click(x, y, button, count, signal) {
      await run(`click ${x} ${y} ${button} ${count}`, signal);
    },
    async type(text, signal) {
      await run(`type ${Buffer.from(text, "utf8").toString("base64")}`, signal);
    },
    async key(vks, signal) {
      await run(`key ${vks.join(" ")}`, signal);
    },
    async scroll(x, y, notches, signal) {
      await run(`scroll ${x} ${y} ${notches}`, signal);
    },
    close: kill,
  };
}
