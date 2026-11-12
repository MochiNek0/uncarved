// 审批规则（plugins/approval/policy.ts）：从旧 jade 的 test/jade.test.ts "policy" 移植。
// 自动审查（reviewer）、pendingMode、旧模式迁移、子 Agent 共用规则已经去掉，相关测试没有移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolInfo } from "uncarved";
import type { ToolMeta } from "@uncarved/jade-api";
import { bashRules, isSafeCommand, nativePath, policy, shellWords, type Mode } from "../plugins/approval/policy.ts";
import { validate } from "../plugins/approval/schema.ts";
import { fsTools } from "../plugins/fs/fs.ts";
import { shellTool } from "../plugins/shell/shell.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

/** 带 url 参数的只读工具（旧版本的 web_fetch）：策略按主机问 */
const webFetch: ToolInfo = {
  name: "web_fetch",
  description: "fetch a URL",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  effect: "read",
  concurrency: "safe",
  idempotent: true,
};

describe("policy", () => {
  const cwd = path.resolve("/work");
  const tools: (ToolInfo & { meta?: ToolMeta })[] = [...fsTools(cwd), shellTool({ cwd }), webFetch];
  /** 会话里由 ctx.session.tool 查：这里直接看工具的 meta */
  const shell = (name: string) => tools.find((t) => t.name === name)?.meta?.shell;
  const gated =(name: string, input: unknown) => ({ toolUseId: "t", name, input, tool: tools.find((t) => t.name === name)! });
  const decide = (mode: Mode, name: string, input: unknown) => policy({ shell, cwd }).decide(gated(name, input), { mode, rules: [] }).decision;
  const inside = path.join(cwd, "a.ts");
  const outside = path.resolve("/etc/passwd");

  test("modes", () => {
    expect(decide("ask", "read_file", { path: inside })).toBe("allow");
    expect(decide("ask", "read_file", { path: outside })).toBe("ask");
    expect(decide("ask", "write_file", { path: inside, content: "" })).toBe("ask");
    expect(decide("auto", "write_file", { path: inside, content: "" })).toBe("allow");
    expect(decide("auto", "write_file", { path: outside, content: "" })).toBe("ask");
    expect(decide("readonly", "write_file", { path: inside, content: "" })).toBe("deny");
    expect(decide("yolo", "bash", { command: "rm -rf build" })).toBe("allow");
    expect(decide("ask", "bash", { command: "git status" })).toBe("allow");
    expect(decide("ask", "bash", { command: "bun test" })).toBe("ask");
    expect(decide("readonly", "bash", { command: "git log -5" })).toBe("allow");
    expect(decide("plan", "write_file", { path: inside, content: "" })).toBe("deny");
    expect(decide("plan", "bash", { command: "bun test" })).toBe("deny");
  });

  // 旧版本在 tool.before hook 里把路径换成绝对路径，日志里记下的是确定的路径；现在是 absolutePath
  test("edit needs approval in ask mode; absolutePath resolves the path against the working directory", () => {
    const p = policy({ shell, cwd });
    const input = p.absolutePath({ path: "a.txt", old_string: "x", new_string: "y" });
    expect(input).toEqual({ path: path.join(cwd, "a.txt"), old_string: "x", new_string: "y" });
    expect(p.decide(gated("edit_file", input), { mode: "ask", rules: [] }).decision).toBe("ask");
    // 已经是绝对路径的不变；没有 path 参数的原样返回
    expect(p.absolutePath({ path: outside })).toEqual({ path: outside });
    const command = { command: "ls" };
    expect(p.absolutePath(command)).toBe(command);
    expect(p.absolutePath(null)).toBeNull();
  });

  test("plan mode allows reads and read-only commands, and denies changes with a plan-mode reason", () => {
    expect(decide("plan", "bash", { command: "git log -5" })).toBe("allow");
    expect(decide("plan", "read_file", { path: inside })).toBe("allow");
    const reason = policy({ shell, cwd }).decide(gated("edit_file", { path: inside, old_string: "a", new_string: "b" }), { mode: "plan", rules: [] });
    expect(reason.decision === "deny" && reason.reason).toContain("plan mode");
  });

  // 旧版本里 skill 目录经 readRoots 传入：ask 模式下读里面的文件不用问
  test("files under a read root can be read without asking, but not changed", () => {
    const root = path.resolve("/skills/release");
    const p = policy({ shell, cwd, readRoots: [root] });
    const d = (mode: Mode, name: string, input: unknown) => p.decide(gated(name, input), { mode, rules: [] }).decision;
    expect(d("ask", "read_file", { path: path.join(root, "notes.md") })).toBe("allow");
    expect(d("ask", "read_file", { path: path.resolve("/skills/other/notes.md") })).toBe("ask");
    expect(d("auto", "write_file", { path: path.join(root, "notes.md"), content: "" })).toBe("ask");
  });

  // 会话的临时目录（jade/scratch 经 allowWrite 传入）：和工作目录同样对待
  test("files under a write root are treated like the working directory", () => {
    const root = path.resolve("/scratch/s1");
    const p = policy({ shell, cwd, writeRoots: [root] });
    const d = (mode: Mode, name: string, input: unknown) => p.decide(gated(name, input), { mode, rules: [] }).decision;
    const file = path.join(root, "try.py");
    expect(d("auto", "write_file", { path: file, content: "" })).toBe("allow");
    expect(d("ask", "write_file", { path: file, content: "" })).toBe("ask");
    expect(d("ask", "read_file", { path: file })).toBe("allow");
    expect(d("auto", "bash", { command: `mkdir -p "${path.join(root, "out")}"` })).toBe("allow");
    expect(d("plan", "write_file", { path: file, content: "" })).toBe("deny");
    expect(d("auto", "write_file", { path: path.resolve("/scratch/s2/try.py"), content: "" })).toBe("ask");
  });

  test("opening a viewable file in the workspace for the user does not ask; anything else still does", () => {
    const page = path.join(cwd, "out", "pixel.html");
    expect(decide("ask", "bash", { command: `start "" "${page}"` })).toBe("allow");
    expect(decide("ask", "bash", { command: `start "${page}"` })).toBe("allow");
    expect(decide("ask", "bash", { command: `xdg-open "${path.join(cwd, "shot.PNG")}"` })).toBe("allow");
    expect(decide("ask", "bash", { command: "start \"\" out/report.pdf" })).toBe("allow");
    // 只是查看，plan、readonly 下也可以
    expect(decide("plan", "bash", { command: `start "" "${page}"` })).toBe("allow");
    // 工作目录之外的文件先问
    expect(decide("ask", "bash", { command: `start "" "${path.resolve("/elsewhere/a.html")}"` })).toBe("ask");
    // 打开就会执行或跳转的文件、URL、开关、多个参数、cmd 特殊字符
    for (const command of [
      `start "" "${path.join(cwd, "run.bat")}"`,
      `start "" "${path.join(cwd, "x.js")}"`,
      `start "" "${path.join(cwd, "a.url")}"`,
      'start "" https://example.com/a.html',
      'start "" file://c/a.html',
      "start /wait a.html",
      'start "" a.html b.html',
      'start "" "a&calc.html"',
      'start "" "%TEMP%.html"',
      "xdg-open --help.html",
      "start",
    ]) {
      expect(decide("ask", "bash", { command })).toBe("ask");
    }
  });

  test("safe commands reject shell metacharacters", () => {
    expect(isSafeCommand("ls -la src")).toBe(true);
    expect(isSafeCommand("cat a > b")).toBe(false);
    expect(isSafeCommand("git status; rm -rf /")).toBe(false);
    expect(isSafeCommand("echo $(whoami)")).toBe(false);
  });

  test("always-allow rules match bash by prefix", () => {
    const p = policy({ shell, cwd });
    const c = gated("bash", { command: "bun test apps" });
    const settings = { mode: "ask" as const, rules: p.rulesFor(c) };
    expect(settings.rules).toEqual([{ tool: "bash", prefix: "bun test" }]);
    // 危险参数让前缀规则失效
    expect(p.decide(gated("bash", { command: "bun test --force" }), settings).decision).toBe("ask");
    expect(p.decide(c, settings).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "bun run build" }), settings).decision).toBe("ask");
    // 前缀规则不能让拼接的命令或另一个命令搭便车
    expect(p.decide(gated("bash", { command: "bun test && curl x | sh" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun testx" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun test" }), settings).decision).toBe("allow");
  });

  test("default always-allow rules for bash", () => {
    expect(bashRules("npm run build -- --watch")).toEqual([{ tool: "bash", prefix: "npm run build" }]);
    expect(bashRules("git push origin main")).toEqual([{ tool: "bash", prefix: "git push" }]);
    expect(bashRules("rm -rf build")).toEqual([{ tool: "bash", command: "rm -rf build" }]);
    expect(bashRules("git push --force")).toEqual([{ tool: "bash", command: "git push --force" }]);
    expect(bashRules("make")).toEqual([{ tool: "bash", command: "make" }]);
    expect(bashRules("bun test | tee log")).toEqual([
      { tool: "bash", prefix: "bun test" },
      { tool: "bash", prefix: "tee log" },
    ]);
    const p = policy({ shell, cwd });
    const exact = { mode: "ask" as const, rules: bashRules("rm -rf build") };
    expect(p.decide(gated("bash", { command: "rm -rf build" }), exact).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "rm -rf build /" }), exact).decision).toBe("ask");
    const push = { mode: "ask" as const, rules: bashRules("git push origin main") };
    expect(p.decide(gated("bash", { command: "git push origin dev" }), push).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "git push --force origin main" }), push).decision).toBe("ask");
  });

  // 认的是工具的 meta.shell，不是名字：换一个执行命令的工具，按命令判断照样有效，规则记在它自己的名字下
  test("a shell tool with another name is judged by its command, and its rules carry its own name", () => {
    const pwsh = { ...shellTool({ cwd }), name: "pwsh" } as ToolInfo & { meta?: ToolMeta };
    const p = policy({ cwd, shell: (t) => (t === "pwsh" ? pwsh.meta?.shell : undefined) });
    const call = (command: string) => ({ toolUseId: "t", name: "pwsh", input: { command }, tool: pwsh });
    const ask = (rules: { tool: string; prefix: string }[] = []) => ({ mode: "ask" as const, rules });
    expect(p.decide(call("git status"), ask()).decision).toBe("allow");
    expect(p.decide(call("bun test apps"), ask()).decision).toBe("ask");
    expect(p.rulesFor(call("bun test apps"))).toEqual([{ tool: "pwsh", prefix: "bun test" }]);
    expect(p.decide(call("bun test"), ask([{ tool: "pwsh", prefix: "bun test" }])).decision).toBe("allow");
    // bash 的规则不替它放行
    expect(p.decide(call("bun test"), ask([{ tool: "bash", prefix: "bun test" }])).decision).toBe("ask");
  });

  test("always-allow rules for files stay inside the working directory unless they name a directory", () => {
    const p = policy({ shell, cwd });
    const write = (file: string) => gated("write_file", { path: file, content: "" });
    const plain = { mode: "ask" as const, rules: p.rulesFor(write(inside)) };
    expect(plain.rules).toEqual([{ tool: "write_file" }]);
    expect(p.decide(write(inside), plain).decision).toBe("allow");
    // 在项目里允许了 write_file，不等于允许改工作目录之外的文件
    expect(p.decide(write(outside), plain).decision).toBe("ask");
    expect(p.decide(gated("read_file", { path: outside }), { mode: "ask", rules: [{ tool: "read_file" }] }).decision).toBe("ask");

    const elsewhere = path.resolve("/tmp/notes/a.md");
    const dir = { mode: "ask" as const, rules: p.rulesFor(write(elsewhere)) };
    expect(dir.rules).toEqual([{ tool: "write_file", dir: path.dirname(elsewhere) }]);
    expect(p.decide(write(path.resolve("/tmp/notes/b.md")), dir).decision).toBe("allow");
    expect(p.decide(write(path.resolve("/tmp/other.md")), dir).decision).toBe("ask");
    expect(p.decide(write(outside), dir).decision).toBe("ask");
  });

  test("read tools with a url ask per host, even in read-only mode", () => {
    const p = policy({ shell, cwd });
    const docs = gated("web_fetch", { url: "https://docs.example.com/a?q=1" });
    expect(p.decide(docs, { mode: "ask", rules: [] }).decision).toBe("ask");
    expect(p.decide(docs, { mode: "readonly", rules: [] }).decision).toBe("ask");
    expect(p.decide(docs, { mode: "yolo", rules: [] }).decision).toBe("allow");
    const rules = p.rulesFor(docs);
    expect(rules).toEqual([{ tool: "web_fetch", host: "docs.example.com" }]);
    expect(p.decide(gated("web_fetch", { url: "https://DOCS.example.com/b" }), { mode: "ask", rules }).decision).toBe("allow");
    expect(p.decide(gated("web_fetch", { url: "https://evil.example.net/?d=secret" }), { mode: "ask", rules }).decision).toBe("ask");
  });

  test("a url on this machine is not asked about; a name that only looks local is", () => {
    const p = policy({ shell, cwd });
    const ask = (url: string) => p.decide(gated("web_fetch", { url }), { mode: "ask", rules: [] }).decision;
    for (const url of ["http://localhost:3000/products?v=2", "http://127.0.0.1:5173/", "http://[::1]:8080/", "http://app.localhost/"]) expect(ask(url)).toBe("allow");
    for (const url of ["http://localhost.example.com/", "http://127.0.0.1.nip.io/", "http://192.168.1.5/"]) expect(ask(url)).toBe("ask");
  });

  test("safe commands exclude arguments that write files or run programs", () => {
    for (const c of ["git branch -D main", "git branch new", "git diff --output=x", "git log --output x", "rg --pre sh x", "tree -o out", "tree -ao out"]) {
      expect(isSafeCommand(c)).toBe(false);
    }
    for (const c of ["git branch", "git branch -a", "git diff --stat", "rg -o foo", "tree -a src"]) expect(isSafeCommand(c)).toBe(true);
  });

  test("compound read-only commands, harmless redirects and cd run without asking", () => {
    for (const c of [
      "git status && git diff --stat",
      "cat src/a.ts | head -20",
      "ls src 2>/dev/null | wc -l",
      "grep -rn foo src 2>&1 | sort | uniq -c",
      "git --no-pager log -5 --oneline",
      "find . -name '*.ts' -type f",
      "sed -n '10,20p' src/a.ts",
      "cd src && ls -la",
      "git log -3; git status",
      "node --version",
      "git stash list",
      "git config --get user.name",
      // 模型常把工作目录的绝对路径加上引号 cd 进去；Windows 上是反斜杠
      `cd "${cwd}" && git log --oneline -10`,
      `cd "${path.join(cwd, "src")}" && ls`,
      "/usr/bin/grep -n foo src/a.ts",
      "/bin/cat src/a.ts | /usr/bin/head -5",
    ]) {
      expect([c, decide("ask", "bash", { command: c })]).toEqual([c, "allow"]);
      expect([c, decide("plan", "bash", { command: c })]).toEqual([c, "allow"]);
    }
    for (const c of [
      "cat a.ts > b.ts",
      "ls | xargs rm",
      "git status && rm -rf src",
      "find . -name x -delete",
      "find . -exec sh -c x {} +",
      "sed -i 's/a/b/' a.ts",
      "sed -n '1w out' a.ts",
      "sort -o out a.ts",
      "uniq a.ts out.ts",
      "ls &",
      "cat <<EOF",
      "cat <(ls)",
      "ls |& cat",
      "ls >&1x",
      "git branch -D main",
      "git stash drop",
      "git config user.name x",
      "git grep -Ovim foo",
      "date -s 2020-01-01",
      "ls &&",
      "| ls",
      // 双引号里转义引号、$、反斜杠时引号的边界和展开都说不清
      'echo "a\\"; rm -rf src; echo \\""',
      'echo "a\\$HOME"',
      'echo "x\\\\"',
      "/usr/local/bin/cat src/a.ts",
      "./bin/cat src/a.ts",
    ]) {
      expect([c, decide("ask", "bash", { command: c })]).toEqual([c, "ask"]);
    }
    // cd 之后的相对路径按新目录算；cd 到外面的不放行
    expect(decide("ask", "bash", { command: "cd src && cat ../../x" })).toBe("ask");
    expect(decide("ask", "bash", { command: "cd .. && ls" })).toBe("ask");
    expect(decide("ask", "bash", { command: "cd && ls" })).toBe("ask");
    expect(decide("ask", "bash", { command: "cat < /etc/passwd" })).toBe("ask");
    expect(decide("readonly", "bash", { command: "ls > out" })).toBe("deny");
  });

  test("auto mode creates directories and touches files inside the working directory without asking", () => {
    expect(decide("auto", "bash", { command: "mkdir -p src/new && touch src/new/a.ts" })).toBe("allow");
    expect(decide("auto", "bash", { command: "mkdir /tmp/x" })).toBe("ask");
    expect(decide("ask", "bash", { command: "mkdir -p src/new" })).toBe("ask");
    expect(decide("plan", "bash", { command: "mkdir -p src/new" })).toBe("deny");
  });

  test("Git Bash paths like /c/Users are read as Windows drive paths", () => {
    expect(nativePath("/c/Users/me/proj", "win32")).toBe("C:/Users/me/proj");
    expect(nativePath("/d", "win32")).toBe("D:/");
    // MSYS 自己的目录、POSIX 上的路径不换算
    expect(nativePath("/tmp/x", "win32")).toBe("/tmp/x");
    expect(nativePath("/c/Users", "linux")).toBe("/c/Users");
    if (process.platform !== "win32") return;
    const msys = `/${cwd[0]!.toLowerCase()}${cwd.slice(2).replaceAll("\\", "/")}`;
    expect(decide("ask", "bash", { command: `cd ${msys} && sed -n 1,20p a.ts` })).toBe("allow");
    expect(decide("ask", "bash", { command: `ls ${msys}/src` })).toBe("allow");
    // 换算后仍在工作目录之外的照常问
    expect(decide("ask", "bash", { command: "cat /c/Windows/win.ini" })).toBe("ask");
  });

  test("always-allow rules cover their command inside a compound command", () => {
    const p = policy({ shell, cwd });
    const command = "bun test apps 2>&1 | tail -20";
    expect(bashRules(command)).toEqual([{ tool: "bash", prefix: "bun test" }]);
    const settings = { mode: "ask" as const, rules: bashRules(command) };
    expect(p.decide(gated("bash", { command }), settings).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "cd apps && bun test x | grep fail" }), settings).decision).toBe("allow");
    // 其他命令不能搭便车，危险参数仍然让规则失效
    expect(p.decide(gated("bash", { command: "bun test && curl x | sh" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun test --force | tail" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun test > log.txt" }), settings).decision).toBe("ask");
  });

  test("a compound command gets one always-allow rule per command that is not read-only", () => {
    const p = policy({ shell, cwd });
    const first = "git add -A && git commit -m 'one'";
    const rules = bashRules(first);
    expect(rules).toEqual([
      { tool: "bash", prefix: "git add" },
      { tool: "bash", prefix: "git commit" },
    ]);
    const settings = { mode: "ask" as const, rules };
    expect(p.decide(gated("bash", { command: first }), settings).decision).toBe("allow");
    // 换了提交信息、换了组合都不用再问
    expect(p.decide(gated("bash", { command: "git add -A && git commit -m 'two'" }), settings).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "git commit -m 'three'" }), settings).decision).toBe("allow");
    // 没批准过的命令、危险参数、输出重定向照常问
    expect(p.decide(gated("bash", { command: "git add -A && git push" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "git add -A && git commit --no-verify -m x" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "git commit -m x > log.txt" }), settings).decision).toBe("ask");
    // 相同的规则只记一条；有输出重定向时只认整条原文
    expect(bashRules("bun test a && bun test b && npm run build")).toEqual([
      { tool: "bash", prefix: "bun test" },
      { tool: "bash", prefix: "npm run build" },
    ]);
    expect(bashRules("bun install && bun test > out.txt")).toEqual([{ tool: "bash", command: "bun install && bun test > out.txt" }]);
  });

  test("bash commands are split like the shell does; anything not understood is not auto-allowed", () => {
    expect(shellWords(`cat "a b" 'c d' e`)).toEqual([
      { value: "cat", glob: false },
      { value: "a b", glob: false },
      { value: "c d", glob: false },
      { value: "e", glob: false },
    ]);
    expect(shellWords("ls *.ts")).toEqual([{ value: "ls", glob: false }, { value: "*.ts", glob: true }]);
    expect(shellWords(`ls "*.ts"`)).toEqual([{ value: "ls", glob: false }, { value: "*.ts", glob: false }]);
    // 花括号展开、转义、双引号里的变量、未闭合的引号、注释：shell 看到的参数和字面不同
    for (const c of ["cat {/etc/passwd,x}", "cat a\\ b", `cat "$HOME/x"`, `cat "a`, "cat x #y"]) {
      expect(shellWords(c)).toBeUndefined();
      expect(isSafeCommand(c)).toBe(false);
    }
    // 粘在短选项后面的路径、可能匹配 ".." 的通配段也算越界
    expect(decide("ask", "bash", { command: "grep -f/etc/passwd x src" })).toBe("ask");
    expect(decide("ask", "bash", { command: "cat .*/secret" })).toBe("ask");
    expect(decide("ask", "bash", { command: `cat "src/a b.ts"` })).toBe("allow");
    expect(decide("ask", "bash", { command: "ls -la src *.ts" })).toBe("allow");
    expect(decide("ask", "bash", { command: "git log -5 --stat" })).toBe("allow");
    // 前缀规则同样按分词判断
    const rules = [{ tool: "bash", prefix: "bun test" }];
    expect(policy({ shell, cwd }).decide(gated("bash", { command: "bun test {a,b}" }), { mode: "ask", rules }).decision).toBe("ask");
    expect(policy({ shell, cwd }).decide(gated("bash", { command: `bun test "a; b"` }), { mode: "ask", rules }).decision).toBe("allow");
  });

  test("a symlink inside the working directory that points outside counts as outside", async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), "jade-cwd-"));
    const other = await mkdtemp(path.join(os.tmpdir(), "jade-other-"));
    tmp.push(real, other);
    await writeFile(path.join(other, "secret"), "x");
    await mkdir(path.join(real, "src"));
    // Windows 上创建目录联接不需要管理员权限
    await symlink(other, path.join(real, "link"), "junction");
    const local: ToolInfo[] = [...fsTools(real), shellTool({ cwd: real })];
    const p = policy({ shell, cwd: real });
    const ask = (name: string, input: unknown) =>
      p.decide({ toolUseId: "t", name, input, tool: local.find((t) => t.name === name)! }, { mode: "ask", rules: [] }).decision;
    expect(ask("read_file", { path: path.join(real, "link", "secret") })).toBe("ask");
    expect(ask("bash", { command: "cat link/secret" })).toBe("ask");
    expect(ask("read_file", { path: path.join(real, "src", "new.ts") })).toBe("allow");
  });

  test("reading outside the working directory asks, whichever tool does it", () => {
    // 只读命令的参数指向工作目录之外
    for (const c of ["cat ~/.ssh/id_rsa", "cat /etc/passwd", "ls ..", "grep -r key ../other", "rg --file=/etc/x foo"]) {
      expect(decide("ask", "bash", { command: c })).toBe("ask");
      expect(decide("readonly", "bash", { command: c })).toBe("ask");
    }
    expect(decide("ask", "bash", { command: "cat src/a.ts" })).toBe("allow");
    expect(decide("readonly", "bash", { command: "git log origin/main -5" })).toBe("allow");
    // glob 的 pattern 本身越界
    expect(decide("ask", "glob", { pattern: "../*.env" })).toBe("ask");
    expect(decide("ask", "glob", { pattern: path.resolve("/etc") + "/*" })).toBe("ask");
    expect(decide("ask", "glob", { pattern: "src/**/*.ts" })).toBe("allow");
    // 名为 "..foo" 的目录仍在工作目录里
    expect(decide("ask", "read_file", { path: path.join(cwd, "..foo", "a.ts") })).toBe("allow");
  });

  test("schema validation", () => {
    const schema = fsTools(cwd).find((t) => t.name === "read_file")!.inputSchema;
    expect(validate(schema, { path: "a" })).toBeUndefined();
    expect(validate(schema, {})).toBe("input.path is required");
    expect(validate(schema, { path: "a", offset: 1.5 })).toBe("input.offset must be integer, got number");
    expect(validate(schema, { path: "a", x: 1 })).toBe("input.x is not allowed");
    // 参数不合规的调用直接拒绝，不问用户
    expect(decide("auto", "bash", { nope: 1 })).toBe("deny");
  });
});
