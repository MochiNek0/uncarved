// jade/approval：审批。tool.before 把路径统一成绝对路径，tool.gate 按模式和规则决定：允许、拒绝，或者要问用户（ask）。
// 关卡不等用户：所有关卡合并的结果是 ask 时（日志里的 tool.decided），内核停下来等人工审批，这里才经 ui@1 问用户，
// 把回答作为 approval 输入交给会话。别的插件的关卡要问时也由这里问。谁回答的、选了什么记成 jade/approval/answered 事件。
// auto 模式下规则判断不了、本来要问的调用让模型审一次（review.ts）：放行或拦下，拦下时模型用 ask_user 问用户；
// 审查没做成（超时、出错）时直接问用户；放行过的 shell 命令按命令和它跑的脚本内容缓存，没变就不再审查。
// 连续拦下几次、或者没有审查时（review: false）才由这里问。
//
// 没有这个插件（停用、坏掉、被隔离）时，核心的兜底关卡拒绝所有非只读工具（第 7 节），所以这里出错不会放行。
// 用户选的"总是允许"记进日志（derived），恢复会话后仍然有效；选"在这个目录里总是允许"的记在
// $JADE_HOME/state/approvals.json（按工作目录），以后在这个目录里开的会话都有效。模式是进程级的，来自配置，可以经 approval@1 改。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventDataMap, GatedToolCall, Message } from "uncarved";
import { definePlugin, type Caller, type SelectRequest, type Text, type UI } from "@uncarved/jade-api";
import type { Answer, Approval, Approver, Models, Renderers } from "@uncarved/jade-api/services";
import { describeRule, MODES, policy, type AllowRule, type Mode } from "./policy.ts";
import { ASK_USER, commandFiles, commandOf, reviewer, type Review } from "./review.ts";

const ANSWERS: readonly string[] = ["once", "always", "forever", "deny"] satisfies Answer[];
/** 只有终端里有的一项：拒绝，并写一句话告诉模型该怎么做 */
const EXPLAIN = "explain";

/** derived 里保存"总是允许"规则的键 */
const RULES_KEY = "jade/approval/rules";
/** 等用户回答的默认时限，过了按拒绝处理。配置 askTimeoutMinutes 可以改 */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** askTimeoutMinutes 的上限：定时器最长约 24.8 天 */
const MAX_ASK_TIMEOUT_MINUTES = 7 * 24 * 60;
/** 关卡的时限：auto 模式的审查连排队、等限流最长 4 分钟（review.ts），比 hook 默认的 30 秒长 */
const GATE_TIMEOUT_MS = 5 * 60_000;
const MAX_DETAIL_CHARS = 2000;
/** auto 模式的审查连续拦下几次、一个会话里累计拦下几次后，转回问用户一次（同 Claude Code 的 auto 模式） */
const BLOCKS_IN_A_ROW = 3;
const BLOCKS_TOTAL = 20;
/** jade/ask 记下用户回答的事件 */
const ASK_ANSWERED = "jade/ask/answered";
/** 等工具的审批预览的时限，过了就用默认的 detail */
const PREVIEW_TIMEOUT_MS = 5000;

/**
 * 带 URL 的只读工具审查放行之后，完全相同的调用不再审查。不按主机记：同一主机上换一个路径或查询参数
 * 就能把本地数据带出去，正是审查要拦的
 */
const reviewedKey = (call: GatedToolCall): string | undefined => {
  const url = (call.input as { url?: unknown } | null)?.url;
  if (call.tool.effect !== "read" || typeof url !== "string") return undefined;
  return `${call.name} ${JSON.stringify(call.input)}`;
};

let mode: Mode = "ask";
/** 配置里写错的模式：第一个会话打开时告诉用户（process 里可能还拿不到 ui@1：它的提供者可能排在后面激活） */
let badMode: string | undefined;
let askTimeoutMs = ASK_TIMEOUT_MS;
/** 配置里写错的 askTimeoutMinutes，和 badMode 一样在第一个会话打开时告诉用户 */
let badTimeout: string | undefined;
/** 经 allowRead 登记的目录；policy 每次判断时读它 */
const readRoots: string[] = [];
/** 经 allowWrite 登记的目录；policy 每次判断时读它 */
const writeRoots: string[] = [];
/** 经 addApprover 登记的审批渠道 → 登记它的插件 */
const approvers = new Map<Approver, string>();
/** 打开着的会话：会话 id → 判断只读调用能不能不问就执行（allows） */
const sessionChecks = new Map<string, (call: GatedToolCall) => boolean>();
/** 打开着的会话：会话 id → 它现在的"总是允许"规则。子会话（子 Agent）照父会话的规则办：主会话里选过"总是允许"的，子 Agent 不再问 */
const sessionRules = new Map<string, () => AllowRule[]>();
/** 会话 id → 用户的请求在哪些消息里：主会话是它自己的，子会话沿用父会话的（一直到主会话），auto 模式的审查用 */
const sessionUserMessages = new Map<string, () => readonly Message[]>();
/** 会话 id → jade/ask 记下的用户回答（ask_user 的 toolUseId → 回答）：子会话沿用父会话的，同 sessionUserMessages */
const sessionAnswers = new Map<string, () => ReadonlyMap<string, readonly string[]>>();
/** 经 readOnly 登记、只能做不改东西的事的会话（只读的子 Agent） */
const readOnlySessions = new Set<string>();

export default definePlugin({
  process(ctx) {
    const configured = ctx.config.mode;
    if (typeof configured === "string" && (MODES as readonly string[]).includes(configured)) mode = configured as Mode;
    else if (configured !== undefined) badMode = JSON.stringify(configured);
    const minutes = ctx.config.askTimeoutMinutes;
    askTimeoutMs = ASK_TIMEOUT_MS;
    badTimeout = undefined;
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_ASK_TIMEOUT_MINUTES) askTimeoutMs = minutes * 60_000;
    else if (minutes !== undefined) badTimeout = JSON.stringify(minutes);
    ctx.provide("approval@1", (caller): Approval => ({
      mode: () => mode,
      setMode(next: Mode) {
        if (!(MODES as readonly string[]).includes(next)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
        mode = next;
      },
      allowRead: (dir: string) => allow(caller, "allowRead", readRoots, dir),
      allowWrite: (dir: string) => allow(caller, "allowWrite", writeRoots, dir),
      addApprover(approver: Approver) {
        if (caller.layer === "project") throw new Error("approval.addApprover: project plugins cannot answer approvals");
        if (typeof approver !== "function") throw new Error("approval.addApprover: approver must be a function");
        approvers.set(approver, caller.plugin);
        const remove = () => void approvers.delete(approver);
        caller.onDispose(remove);
        return remove;
      },
      allows: (session: string, call: GatedToolCall) => call.tool !== undefined && (sessionChecks.get(session)?.(call) ?? false),
      readOnly(session: string) {
        readOnlySessions.add(session);
        return () => void readOnlySessions.delete(session);
      },
    }));
  },

  async session(ctx) {
    const rules = policy({ cwd: ctx.cwd, readRoots, writeRoots, secretRoots: [ctx.home], shell: (t) => ctx.session.tool(t)?.meta?.shell });
    const ui = ctx.service<UI>("ui@1");
    if (badMode !== undefined) {
      ui?.notify(`jade/approval: mode must be one of ${MODES.join(", ")}, got ${badMode}; using ask`, "warning");
      badMode = undefined;
    }
    if (badTimeout !== undefined) {
      ui?.notify(`jade/approval: askTimeoutMinutes must be a number of minutes between 0 and ${MAX_ASK_TIMEOUT_MINUTES}, got ${badTimeout}; using 24 hours`, "warning");
      badTimeout = undefined;
    }
    const renderers = ctx.service<Renderers>("renderers@1");
    // auto 模式的审查用当前配置的模型；没有 models@1（模型插件被停用）或者配置里关掉时不做审查
    const models = ctx.service<Models>("models@1");
    const reviewing = models !== undefined && ctx.config.review !== false;
    /** 最近一次请求里的消息：auto 模式的审查从中取用户最近的请求 */
    const recent: { messages: readonly Message[] } = { messages: [] };
    if (reviewing) {
      ctx.kernel.hook({
        kind: "transform",
        point: "context.build",
        fn: (req) => {
          recent.messages = req.messages;
          return req;
        },
      });
    }
    // 子 Agent 的会话里没有用户的消息：审查从主会话取用户的请求和 ask_user 回答
    const parentId = ctx.session.parent?.sessionId;
    const userMessages = parentId === undefined ? () => recent.messages : () => sessionUserMessages.get(parentId)?.() ?? [];
    sessionUserMessages.set(ctx.session.id, userMessages);
    /** 本会话里 jade/ask 记下的回答（jade/ask/answered 事件，只认来源是 jade/ask 插件的） */
    const ownAnswers = new Map<string, readonly string[]>();
    const answers = parentId === undefined ? () => ownAnswers : () => sessionAnswers.get(parentId)?.() ?? new Map();
    sessionAnswers.set(ctx.session.id, answers);
    await ctx.effect(() => () => {
      if (sessionUserMessages.get(ctx.session.id) === userMessages) sessionUserMessages.delete(ctx.session.id);
      if (sessionAnswers.get(ctx.session.id) === answers) sessionAnswers.delete(ctx.session.id);
    });
    const reviewOptions = {
      cwd: ctx.cwd,
      writeRoots: () => writeRoots,
      messages: () => recent.messages,
      meta: (t: string) => ctx.session.tool(t)?.meta,
    };
    // reviewModel：审查用 /model 保存过的另一个模型（更快、更便宜，限速也和会话分开）
    const reviewModel = ctx.config.reviewModel;
    if (reviewModel !== undefined && (typeof reviewModel !== "string" || !reviewModel.trim())) {
      ui?.notify(`jade/approval: reviewModel must be the name of a model saved with /model, got ${JSON.stringify(reviewModel)}; using the current model`, "warning");
    }
    const model = typeof reviewModel === "string" && reviewModel.trim() ? reviewModel.trim() : undefined;
    const review = reviewing
      ? reviewer({ ...reviewOptions, models: models!, ...(parentId !== undefined ? { userMessages } : {}), answers, ...(model ? { model: () => model } : {}) })
      : undefined;
    /** 本会话里审查过一次、放行了的调用 */
    const reviewedCalls = new Set<string>();
    /**
     * 审查要看的文件（shell 命令）和放行后的缓存键。带 URL 的只读调用按完整的输入记；
     * shell 命令按完整的输入加上它跑的脚本的内容记：同一条 pnpm run build、没改过的临时脚本不再审查，脚本改了就重审
     */
    const reviewKey = async (call: GatedToolCall): Promise<{ key?: string; files?: string[] }> => {
      const url = reviewedKey(call);
      if (url !== undefined) return { key: url };
      const command = commandOf(call, reviewOptions.meta);
      if (command === undefined) return {};
      const files = await commandFiles(reviewOptions, command);
      const digest = createHash("sha256").update(files.join("\0")).digest("hex");
      return { key: `${call.name} ${JSON.stringify(call.input)} ${digest}`, files };
    };
    /** auto 模式里审查连续拦下、累计拦下的次数（审查失败不算）；到了上限这一次转回问用户，免得模型不问、一直被拦在原地 */
    let blocksInARow = 0;
    let blocksTotal = 0;
    let warned = false;
    /** 本进程里刚选的"总是允许"：记进日志之前（要等看到那条 approval 输入）就要生效 */
    const added: AllowRule[] = [];
    /** 一次只问一个问题；排在后面的问之前重新判断，前面刚选的"总是允许"可能已经覆盖它 */
    let asking: Promise<unknown> = Promise.resolve();
    /** 日志里记下的"总是允许"规则，每次调用工具前取一次：子 Agent 在工具执行期间经 allows 用它 */
    let logged: AllowRule[] = [];
    const merged = (from: readonly AllowRule[]) => [...from, ...added.filter((r) => !from.some((l) => JSON.stringify(l) === JSON.stringify(r)))];
    /** "在这个目录里总是允许"的规则：会话打开时从文件读，本会话里新选的也加进来 */
    const foreverFile = path.join(ctx.home, "state", "approvals.json");
    const forever: AllowRule[] = (await readForever(foreverFile))[ctx.cwd] ?? [];
    /** 父会话现在的规则（子会话才有） */
    const parent = ctx.session.parent?.sessionId;
    const inherited = () => (parent ? (sessionRules.get(parent)?.() ?? []) : []);
    const saved = () => [...forever, ...merged(logged), ...inherited()];
    /** 这一轮里关卡看过、还没有决定的调用 */
    const seen = new Map<string, Asked>();
    /** 已经交给会话的回答：在日志里看到那条 approval 输入时记一条 answered 事件 */
    const answered = new Map<string, { answer: string; by: string }>();
    /** 这一轮里已经在问、或者问过的调用 */
    const handled = new Set<string>();
    /** 这一轮结束（包括被中断）时中止还开着的问题 */
    let turn = new AbortController();
    const canAsk = () => ui?.interactive === true || approvers.size > 0;
    const nobody = (name: string) => `${name} needs the user's approval, but nobody can approve it in this non-interactive run. Do not retry it; tell the user what you wanted to do.`;

    const id = ctx.session.id;
    const check = (call: GatedToolCall) =>
      rules.decide(call, { mode: mode === "yolo" && call.tool.effect === "read" ? "yolo" : "readonly", rules: [...forever, ...logged, ...added, ...inherited()] }).decision === "allow";
    sessionChecks.set(id, check);
    sessionRules.set(id, saved);
    await ctx.effect(() => () => {
      if (sessionChecks.get(id) === check) sessionChecks.delete(id);
      if (sessionRules.get(id) === saved) sessionRules.delete(id);
    });

    ctx.kernel.hook({
      kind: "transform",
      point: "tool.before",
      fn: (call, hook) => {
        logged = (hook.derived[RULES_KEY] as AllowRule[] | undefined) ?? [];
        return { ...call, input: rules.absolutePath(call.input) };
      },
    });
    ctx.kernel.hook({
      kind: "gate",
      point: "tool.gate",
      timeoutMs: GATE_TIMEOUT_MS,
      fn: async (call, hook) => {
        seen.set(call.toolUseId, { call });
        // 只读的会话：只读规则放行的照常放行；其余的 auto 模式下由审查按只读的标准判断，被拦下不转回问用户，
        // 其他模式、没有审查时拒绝（静态规则认不出的命令，例如 for 循环、python -c，常常其实只读）
        if (readOnlySessions.has(id) && call.tool.effect !== "read") {
          if (check(call)) return { decision: "allow" };
          if (!review || mode !== "auto") return { decision: "deny", reason: READ_ONLY(call.name) };
          const { key, files } = await reviewKey(call);
          if (key !== undefined && reviewedCalls.has(key)) return { decision: "allow", reason: "This exact call was already approved in this session." };
          const verdict: Review = await review(call, hook.signal, { readOnly: true, ...(files ? { files } : {}) });
          if (verdict.usage) await hook.emit("reviewed", { toolUseId: call.toolUseId, usage: verdict.usage });
          if (verdict.decision === "allow") {
            if (key !== undefined) reviewedCalls.add(key);
            return { decision: "allow", reason: verdict.reason };
          }
          return { decision: "deny", reason: blocked(call.name, verdict, "report") };
        }
        const result = rules.decide(call, { mode, rules: saved() });
        if (result.decision !== "ask") return result;
        // auto 模式：规则判断不了、本来要问的调用让模型审一次，审查的结论就是决定，不问用户。
        // 拦下时把理由告诉模型：要做就先用 ask_user 问用户，用户同意后重试，审查看到回答会放行。
        // 连续拦下 BLOCKS_IN_A_ROW 次或累计 BLOCKS_TOTAL 次时，这一次转回问用户
        let why: string | undefined;
        if (review && mode === "auto") {
          const { key, files } = await reviewKey(call);
          if (key !== undefined && reviewedCalls.has(key)) return { decision: "allow", reason: "This exact call was already approved in this session." };
          const verdict: Review = await review(call, hook.signal, files ? { files } : undefined);
          // 审查调用不经过 model.responded，用量只能记在这里，界面据此计入会话用量
          if (verdict.usage) await hook.emit("reviewed", { toolUseId: call.toolUseId, usage: verdict.usage });
          if (verdict.decision === "allow") {
            blocksInARow = 0;
            if (key !== undefined) reviewedCalls.add(key);
            return { decision: "allow", reason: verdict.reason };
          }
          if (verdict.failed) {
            // 审查没做成（超时、出错、答非所问）不是判断有风险：能问就直接问用户，免得模型重试、再等一轮审查
            if (!canAsk()) return { decision: "deny", reason: blocked(call.name, verdict, "reply") };
            why = `${verdict.reason ?? "The automatic review failed."} So auto mode asks you this time.`;
          } else {
            blocksInARow++;
            blocksTotal++;
            if (!canAsk() || (blocksInARow < BLOCKS_IN_A_ROW && blocksTotal < BLOCKS_TOTAL))
              return { decision: "deny", reason: blocked(call.name, verdict, parentId !== undefined ? "report" : ctx.session.tool(ASK_USER) !== undefined ? "ask_user" : "reply") };
            blocksInARow = 0;
            blocksTotal = 0;
            why = `Auto mode has blocked several actions, so it asks you this time. The review's reason: ${verdict.reason ?? "none given"}`;
          }
        }
        if (!canAsk()) {
          if (!warned) {
            warned = true;
            ui?.notify(
              `${call.name} needs approval, but this jade cannot ask. To let it make changes in the working directory, ` +
                `set {"jade/approval": {"mode": "auto"}} in ${ctx.home}/config.json`,
              "warning",
            );
          }
          return { decision: "deny", reason: nobody(call.name) };
        }
        seen.set(call.toolUseId, { call, mine: call, ...(why ? { why } : {}) });
        return { decision: "ask" };
      },
    });

    /** 问用户（或按刚加的规则直接决定），返回交给内核的回答 */
    const decide = async (asked: Asked, signal: AbortSignal): Promise<Verdict> => {
      const { call } = asked;
      if (asked.mine) {
        const again = rules.decide(asked.mine, { mode, rules: saved() });
        if (again.decision === "allow") return { approved: true, answer: "allow", by: "rule" };
        if (again.decision === "deny") return { approved: false, answer: "deny", by: "rule", reason: again.reason };
      }
      if (!canAsk()) return { approved: false, answer: "deny", by: "nobody", reason: nobody(call.name) };
      const allow = rules.rulesFor(call);
      const described = allow.map(describeRule).join(", ");
      // "总是允许"的范围只在正文里写一次：写进选项里时，长命令会把两个选项句尾的区别（本会话 / 这个目录）挤出屏幕
      const covers = asked.mine ? `"Always allow" covers: ${allow.length === 1 && allow[0]!.command !== undefined ? `${allow[0]!.tool}, this exact command only` : described}\n\n` : "";
      const shown: Text = [covers, (await preview(renderers, call)) ?? detail(call)];
      const expired = new AbortController();
      const timer = setTimeout(() => expired.abort(), askTimeoutMs);
      let got: Got | undefined;
      try {
        got = await ask(
          ui,
          {
            title: `Allow ${call.name}?`,
            // auto 模式拦了几次转回来问的：先说为什么
            detail: asked.why ? [asked.why, "\n\n", shown] : shown,
            options: [
              { label: "Allow once", value: "once" },
              // 别的插件要问的调用不能"总是允许"：这里的规则管不到它的关卡
              ...(asked.mine
                ? [
                    { label: "Always allow in this session", value: "always" as const },
                    { label: "Always allow in this directory, in every session", value: "forever" as const },
                  ]
                : []),
              { label: "Deny", value: "deny" },
            ],
          },
          AbortSignal.any([signal, expired.signal, ctx.signal]),
        );
      } finally {
        clearTimeout(timer);
      }
      if (expired.signal.aborted) {
        return { approved: false, answer: "deny", by: "timeout", reason: `Nobody answered the approval request for ${call.name} in time. Do not retry it; tell the user what you wanted to do.` };
      }
      // 终端里按 Esc 取消：用户要的是停下，不是让模型换个办法接着做
      if (got?.cancelled) return { approved: false, answer: "deny", by: "terminal", stop: true };
      if (got?.answer === "always" && asked.mine) {
        added.push(...allow);
        return { approved: true, answer: "always", by: got.by };
      }
      if (got?.answer === "forever" && asked.mine) {
        forever.push(...allow);
        try {
          await addForever(foreverFile, ctx.cwd, allow);
          ui?.notify(`${described} is now always allowed in ${ctx.cwd}. To ask again, remove it from ${foreverFile}`, "info");
        } catch (e) {
          ui?.notify(`could not save the rule to ${foreverFile} (${e instanceof Error ? e.message : String(e)}); it only applies to this session`, "warning");
        }
        return { approved: true, answer: "forever", by: got.by };
      }
      if (got !== undefined && got.answer !== "deny") return { approved: true, answer: "once", by: got.by };
      if (got?.said) return { approved: false, answer: "deny", by: got.by, reason: `The user denied this tool call and said: ${got.said}` };
      return { approved: false, answer: "deny", by: got?.by ?? "nobody", reason: "The user denied this tool call. Do not retry it unchanged: adjust, or ask what to do instead." };
    };

    /** 一个要问的调用：得出回答，交给会话。出错也要回答（拒绝），否则这一轮一直等着 */
    const settle = async (asked: Asked, signal: AbortSignal) => {
      const toolUseId = asked.call.toolUseId;
      let verdict: Verdict;
      try {
        verdict = await decide(asked, signal);
      } catch (e) {
        verdict = { approved: false, answer: "deny", by: "error", reason: `Asking for approval failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      // 这一轮已经结束（被中断）：回答作废
      if (signal.aborted) return;
      // 结束这一轮（内核的 endTurn）：等待中的调用记为错误，不再请求模型
      if (verdict.stop) return ctx.session.abort("the user cancelled the approval request");
      answered.set(toolUseId, { answer: verdict.answer, by: verdict.by });
      // 不等它：它要到内核再次停下才 resolve，后面排着的问题可能就是内核在等的
      void Promise.resolve()
        .then(() => ctx.session.send({ kind: "approval", toolUseId, approved: verdict.approved, ...(verdict.reason ? { reason: verdict.reason } : {}) }))
        .catch(() => void answered.delete(toolUseId));
    };

    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e, hook) => {
        if (e.type === ASK_ANSWERED) {
          const d = e.data as { toolUseId?: unknown; answers?: unknown };
          if (e.origin.by === "plugin" && e.origin.id === "jade/ask" && typeof d.toolUseId === "string" && Array.isArray(d.answers))
            ownAnswers.set(d.toolUseId, d.answers.map(String));
        } else if (e.type === "tool.decided") {
          const d = e.data as EventDataMap["tool.decided"];
          const asked = seen.get(d.toolUseId);
          seen.delete(d.toolUseId);
          if (d.decision !== "ask" || !asked) return;
          // 不在这里等回答：observe 要马上返回，内核才能停下来等
          handled.add(d.toolUseId);
          const signal = turn.signal;
          asking = asking.then(() => settle(asked, signal));
        } else if (e.type === "input.received") {
          const d = e.data as EventDataMap["input.received"];
          if (d.kind !== "approval") return;
          const a = answered.get(d.toolUseId);
          if (!a) return;
          answered.delete(d.toolUseId);
          // 内核只记同意或拒绝：选了什么、谁回答的（终端、哪个渠道、规则、超时）记在这里
          await hook.emit("answered", { toolUseId: d.toolUseId, ...a });
          if (a.answer === "always") await hook.record(RULES_KEY, merged((hook.derived[RULES_KEY] as AllowRule[] | undefined) ?? []));
        } else if (e.type === "turn.ended") {
          turn.abort(new Error("the turn ended"));
          turn = new AbortController();
          seen.clear();
          answered.clear();
          handled.clear();
        }
      },
    });

    // 恢复一个上次停在等审批的会话（进程被杀、崩溃）：那些调用的关卡是上一个进程跑的，这里没见过。
    // 内核恢复时再发一次 awaiting，据此重新问。只知道调用的名字和参数（工具的声明只有关卡拿得到），
    // 所以当作别的关卡要问的：只有"允许一次"和"拒绝"，不重新套规则
    ctx.session.subscribe((n) => {
      if (n.type !== "awaiting") return;
      const waiting = n.toolUseIds.filter((t) => !handled.has(t) && !seen.has(t));
      if (waiting.length === 0) return;
      const batch = ctx.session.state().batch;
      const signal = turn.signal;
      for (const toolUseId of waiting) {
        const c = batch.find((x) => x.toolUseId === toolUseId && x.decision === "ask");
        if (!c) continue;
        handled.add(toolUseId);
        asking = asking.then(() => settle({ call: { toolUseId, name: c.name, input: c.input } }, signal));
      }
    });
  },
});

/** 一个要问的调用。没有 mine 的是别的插件的关卡要问的，或者恢复会话时还在等的；why：auto 模式拦了几次转回来问时的理由 */
interface Asked {
  call: AskedCall;
  /** 这里的规则要问的：关卡看到的完整调用，问之前按它重新判断一次 */
  mine?: GatedToolCall;
  why?: string;
}

/**
 * auto 模式的审查拦下调用时告诉模型的话：审查没做成时可以再试；判断有风险时先问用户：
 * ask_user：用它问（这一轮里接着做）；reply：没有 ask_user，在回复里问、结束这一轮；
 * report：子 Agent 问不了用户，停下来在报告里说明，由主 Agent 问
 */
/** 只读的会话里，规则认不出是只读、又没有审查可以判断的调用 */
const READ_ONLY = (tool: string) =>
  `${tool}: sub-agents can only run read-only commands inside the working directory (for example git log, git diff, ls, rg). Describe anything else in your report instead.`;

function blocked(tool: string, verdict: Review, how: "ask_user" | "reply" | "report"): string {
  const why = verdict.reason ?? "no reason given";
  if (verdict.failed) return `${why} So this ${tool} call did not run. You may try it once more; if the review fails again, tell the user what you wanted to do.`;
  const next = {
    ask_user: `ask the user with ${ASK_USER}: say exactly what you want to run and why it was blocked, with options to allow it or not. If they allow it, make the same call again.`,
    reply: "tell the user exactly what you want to run and why, and end your turn; once they confirm, try the call again.",
    report:
      "stop and say in your report exactly which call was blocked and why, so the main agent can ask the user. Do not retry it yourself; " +
      "once the user agrees, the main agent can run it or give the task again.",
  }[how];
  return `The automatic safety review in auto mode blocked this ${tool} call: ${why} Do not work around it with another call that has the same effect. If this step is needed, ${next}`;
}

/** 要问的调用里给用户看的部分；恢复的会话里只有这些 */
type AskedCall = Pick<GatedToolCall, "toolUseId" | "name" | "input">;

/** 交给内核的回答，和记进 answered 事件的部分（answer、by） */
interface Verdict {
  approved: boolean;
  answer: "allow" | Answer;
  by: string;
  reason?: string;
  /** 不回答，结束这一轮（用户在终端里按了 Esc） */
  stop?: boolean;
}

/** allowRead、allowWrite：把目录登记进 roots，调用方的作用域关闭时撤销 */
function allow(caller: Caller, name: string, roots: string[], dir: string): () => void {
  if (caller.layer === "project") throw new Error(`approval.${name}: project plugins cannot widen what runs without asking`);
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error(`approval.${name}: dir must be an absolute path`);
  const root = path.resolve(dir);
  roots.push(root);
  const remove = () => {
    const i = roots.indexOf(root);
    if (i !== -1) roots.splice(i, 1);
  };
  caller.onDispose(remove);
  return remove;
}

/**
 * 把问题同时交给终端（能提问时）和所有审批渠道，返回先到的回答和回答的人（"terminal" 或渠道的插件 id），然后中止其余的。
 * 终端里取消（undefined）算拒绝并标上 cancelled；渠道返回 undefined、不认识的值或出错算它不回答。都不回答时返回 undefined（拒绝）
 */
async function ask(ui: UI | undefined, request: SelectRequest<Answer>, signal: AbortSignal): Promise<Got | undefined> {
  const done = new AbortController();
  const stop = () => done.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await new Promise<Got | undefined>((resolve, reject) => {
      const channels: Promise<Got | typeof NONE>[] = [];
      if (ui?.interactive) {
        // 终端里多一项：拒绝并说明。选了它再问一句话，取消或什么都没写就是普通的拒绝
        const options = [...request.options, { label: "Deny, and say what to do instead", value: EXPLAIN }];
        channels.push(
          ui.select<string>({ ...request, options }, done.signal).then(async (a) => {
            if (a === undefined && !done.signal.aborted) return { answer: "deny" as const, by: "terminal", cancelled: true };
            if (a !== EXPLAIN) return { answer: a !== undefined && ANSWERS.includes(a) ? (a as Answer) : "deny", by: "terminal" };
            const said = (await ui.input({ title: "What should the agent do instead?" }, done.signal))?.trim();
            return { answer: "deny" as const, by: "terminal", ...(said ? { said } : {}) };
          }),
        );
      }
      for (const [approver, by] of approvers) {
        channels.push(
          Promise.resolve()
            .then(() => approver(request, done.signal))
            .then(
              (a) => (typeof a === "string" && ANSWERS.includes(a) ? { answer: a as Answer, by } : NONE),
              () => NONE,
            ),
        );
      }
      let pending = channels.length;
      if (pending === 0) return resolve(undefined);
      for (const c of channels) {
        c.then((a) => {
          if (a !== NONE) resolve(a);
          else if (--pending === 0) resolve(undefined);
        }, reject);
      }
    });
  } finally {
    signal.removeEventListener("abort", stop);
    done.abort(new Error("answered"));
  }
}
const NONE = Symbol("no answer");

/** 拿到的回答：said 是"拒绝并说明"时用户写的话；cancelled 是用户在终端里按了 Esc */
interface Got {
  answer: Answer;
  by: string;
  said?: string;
  cancelled?: boolean;
}

/** approvals.json：工作目录 → 在这个目录里总是允许的规则。读不了或格式不对时当作没有 */
async function readForever(file: string): Promise<Record<string, AllowRule[]>> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, AllowRule[]> = {};
    for (const [dir, rules] of Object.entries(data)) {
      if (Array.isArray(rules)) out[dir] = rules.filter((r): r is AllowRule => !!r && typeof r === "object" && typeof (r as AllowRule).tool === "string");
    }
    return out;
  } catch {
    return {};
  }
}

async function addForever(file: string, cwd: string, add: AllowRule[]): Promise<void> {
  const all = await readForever(file);
  const rules = all[cwd] ?? [];
  for (const rule of add) if (!rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) rules.push(rule);
  all[cwd] = rules;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * 工具自己登记的审批预览（例如文件修改的 diff）。没有登记、返回的不是文字、或者出错时返回 undefined，
 * 用下面的 detail：预览是别的插件的代码，它坏了不能让审批卡住或失败
 */
async function preview(renderers: Renderers | undefined, call: AskedCall): Promise<Text | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 预览可能读文件、算 diff；一直不返回时也要能问用户
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PREVIEW_TIMEOUT_MS);
    });
    const text = await Promise.race([Promise.resolve(renderers?.forTool(call.name)?.renderer.preview?.(call.input)), late]);
    return typeof text === "string" || (typeof text === "object" && text !== null) ? text : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 给用户看的调用内容：命令、路径和要写的内容，太长的截断 */
function detail(call: AskedCall): string {
  const input = call.input as Record<string, unknown> | null;
  let text: string;
  if (typeof input?.command === "string") text = input.command;
  else if (typeof input?.path === "string" && typeof input.content === "string") text = `${input.path}\n\n${input.content}`;
  else if (typeof input?.path === "string" && typeof input.old_string === "string") text = `${input.path}\n\n- ${input.old_string}\n+ ${String(input.new_string)}`;
  else text = JSON.stringify(input, null, 2);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… (${text.length - MAX_DETAIL_CHARS} more characters)` : text;
}
