// 内置插件提供的服务的类型：第三方插件用 ctx.require / ctx.service 取这些服务时，从这里 import 类型。
// 只有类型，没有值。服务的形状仍由提供它的插件决定（jade.md 3.3）：这里是它们公开的那一份，
// 内置插件自己也只从这里 import（test/boundaries.test.ts 守着），所以不会和实现走偏。
// 核心不 import 这个文件：核心不认识任何功能（原则 1）。

import type { ContentSource, GatedToolCall, ModelRequest, ModelResponse, Tool } from "uncarved";
import type { SelectRequest, SessionManager, Text, UI } from "./index.ts";

// ---------- commands@1（jade/commands） ----------

export interface Command {
  /** 不带斜杠，字母、数字、- 和 _ */
  name: string;
  description?: string;
  /** 参数提示，例如 "<file>" */
  args?: string;
  /**
   * 不碰会话（只查看、只改插件自己的设置）的命令设为 true：模型工作时也立即执行，不排队。
   * 这种命令返回 { prompt } 无效
   */
  instant?: boolean;
  /**
   * 输入的简写：以这个字符开头的输入当作这条命令，例如 jade/shell 的 /sh 用 "!"，`!git status` 就是 `/sh git status`。
   * 一个不是字母、数字、空白、"/" 的字符；已经被别的命令用了时这条命令照常注册，只是没有简写（并报告）
   */
  prefix?: string;
  /** 输入框里打了简写时显示的说明，例如 "shell command · you run it, not the agent" */
  prefixHint?: string;
  /** 字符串：显示给用户；{ prompt }：作为用户消息发给模型；不返回：什么也不做 */
  run(args: string, ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

export type CommandResult = Text | { prompt: string } | void | undefined;

/** 前端执行命令时给的上下文 */
export interface CommandContext {
  /** 用户中断（esc）或退出时中止 */
  signal: AbortSignal;
  ui: UI;
  /** 当前会话、新建、恢复（/clear、/resume 用它） */
  sessions: SessionManager;
  /** 在对话里显示一段文字（Text：可以带语义样式）。details：折叠起来的完整内容，终端界面里点击或 ctrl+o 展开，其他前端可以不显示 */
  print(text: Text, opts?: { details?: Text }): void;
  /**
   * 命令还在跑时临时显示的内容（例如正在执行的程序的输出），可以多行；再调用一次换掉上一次的，undefined 去掉。
   * 显示在对话的最后，只显示末尾几行，命令结束时自动去掉。前端可以不提供
   */
  progress?(text: Text | undefined): void;
}

export interface CommandEntry {
  command: Command;
  /** 注册它的插件 */
  plugin: string;
}

export interface Commands {
  /** 注册一条命令，返回撤销函数。名字不合法时抛错；已被占用时先注册的留下，这一条跳过并报告给用户（返回的撤销函数什么也不做） */
  register(command: Command): () => void;
  /** 按名字找（不分大小写） */
  get(name: string): CommandEntry | undefined;
  /** 全部命令，按名字排序 */
  list(): { name: string; args?: string; description?: string; instant?: boolean; prefix?: string; prefixHint?: string; plugin: string }[];
  /** 用这个简写字符的命令 */
  byPrefix(prefix: string): CommandEntry | undefined;
}

// ---------- completions@1（jade/completions） ----------

/**
 * 输入框里的补全：打了触发字符（例如 "@"）之后列出候选，选中的插进输入框。
 * 前端只管列、排序和插入；候选是什么、发送时拿它做什么归注册的插件（例如 jade/mentions 发送时附上文件内容）
 */
export interface Completion {
  /** 一个字符，在行首或空白之后打出来时开始补全 */
  trigger: string;
  /** 输入框的占位提示里怎么说，例如 "files"（显示成 "@ files"） */
  label: string;
  /** 候选菜单下面的说明，例如 "the file's content is sent with the message" */
  hint?: string;
  /** 候选，像路径一样用 / 分层，目录以 / 结尾；每次开始输入一个新的触发字符时取一次 */
  candidates(): Promise<string[]>;
}

export interface Completions {
  /** 登记一种补全，返回撤销函数。触发字符不是一个字符时抛错；已经被别的插件用了时跳过并报告（同 Commands.register） */
  register(completion: Completion): () => void;
  list(): { completion: Completion; plugin: string }[];
}

// ---------- keys@1（jade/keys） ----------

export interface Key {
  /** 见 KEY_SPEC，不分大小写 */
  key: string;
  /** /help 里显示 */
  description?: string;
  /** 按下时调用；出错时前端显示警告。上一次还没执行完时再按，会再调用一次 */
  run(ctx: { key: string; signal: AbortSignal }): void | Promise<void>;
}

export interface Keys {
  /** 注册一个键，返回撤销函数。键不合法或是保留键时抛错；已被占用时跳过并报告（同 Commands.register） */
  register(key: Key): () => void;
  /** 前端按下一个自己不用的键时查找；找到了由前端执行 run，出错时显示警告 */
  get(key: string): { key: Key; plugin: string } | undefined;
  list(): { key: string; description?: string; plugin: string }[];
}

// ---------- renderers@1（jade/renderers） ----------

export interface ToolRenderer {
  tool: string;
  /** 调用行 "● 工具名(…)" 括号里的摘要，只显示第一行；默认是 path 参数或参数的 JSON */
  summary?(input: unknown): Text | undefined;
  /** 摘要省略了的参数（例如很长的命令），展开调用行后显示在最前面，可以多行 */
  details?(input: unknown): Text | undefined;
  /** 执行时显示的内容，代替默认的 "工具名(摘要)"：第一行跟在 "● " 后面，其余的行原样显示在下面，不折叠 */
  call?(input: unknown): Text | undefined;
  /**
   * 运行中的进度：工具用 ToolContext.progress 推送的一项换成一行，显示在对话的最后，工具结束时去掉；返回 undefined 不显示。
   * 没有这个函数时，{ text } 形式的进度按输出逐行显示，其他的不显示
   */
  progress?(update: unknown, call: { toolUseId: string; summary(tool: string, input: unknown): string }): Text | undefined;
  /** 请用户批准时显示的预览，可以多行；默认是参数的 JSON */
  preview?(input: unknown): Text | undefined | Promise<Text | undefined>;
  /** 工具执行之前同步调用（例如记下修改前的文件，好在结果里显示 diff），返回值交给 result 的 before */
  before?(input: unknown): unknown;
  /**
   * 结果：line 接在调用行的 "⎿ " 后面（一行），details 是展开后的内容（可以多行）；
   * 返回 null 时不显示结果；默认显示结果文字的第一行，多出的行折叠起来
   */
  result?(r: { toolUseId: string; input: unknown; text: string; isError: boolean; before?: unknown }): { line: Text; details?: Text } | null | undefined;
}

/** 插件自己的事件（hook 的 ctx.emit 写入的）怎么显示。只能为自己的事件注册：event 不带 "<插件 id>/" 前缀 */
export interface EventRenderer {
  event: string;
  /** line 显示成一行，details 是展开后的内容；返回 undefined 时不显示 */
  render(data: unknown): { line: Text; details?: Text } | undefined;
}

export interface Renderers {
  /** 为一个工具登记显示方式，返回撤销函数。同一个工具已有登记时跳过并报告（同 Commands.register） */
  tool(renderer: ToolRenderer): () => void;
  /** 为自己的一种事件登记显示方式，返回撤销函数 */
  event(renderer: EventRenderer): () => void;
  /** 前端查找 */
  forTool(tool: string): { renderer: ToolRenderer; plugin: string } | undefined;
  /** 前端按完整的事件类型（"<插件 id>/<event>"）查找 */
  forEvent(type: string): { renderer: EventRenderer; plugin: string } | undefined;
}

// ---------- models@1（jade/models） ----------

/** models@1 */
export interface Models {
  /** 当前配置的服务和模型；没有配置时 undefined。via 是给人看的服务说明，例如 "the Anthropic API" */
  current(): {
    kind: string;
    model: string;
    via: string;
    /** 上下文窗口（token） */
    contextWindow: number;
    /** 模型能不能看图片（JADE_VISION；不设时按服务推断） */
    vision: boolean;
    /** 每次回复的输出上限（JADE_MAX_TOKENS，含 .env 里的）；不设或写错时没有，用服务的默认值 */
    maxTokens?: number;
  } | undefined;
  /**
   * 完成一次请求，带重试和限速。默认用当前配置的模型（限速和会话共用）；
   * model 是 /model 保存过的模型名（$JADE_HOME/models.json），用它和它自己的设置；
   * 没保存过时当作当前服务上的模型名（list() 里的那些），用这个服务的默认设置
   */
  complete(request: ModelRequest, options: { signal: AbortSignal; onDelta?: (delta: import("uncarved").Delta) => void; model?: string }): Promise<ModelResponse>;
  /** 服务提供的模型列表；不支持或出错时为空 */
  list(): Promise<string[]>;
  /** /model 保存过的模型名（complete 的 model 能用的那些），最近用过的在前 */
  saved?(): Promise<string[]>;
  /** 配置换了（/model）时调用，返回取消订阅。前端用它更新状态栏 */
  subscribe?(fn: () => void): () => void;
}

// ---------- approval@1（jade/approval） ----------

/** jade/approval 的权限模式 */
export type ApprovalMode = "ask" | "auto" | "plan" | "readonly" | "yolo";

/** approval@1 */
export interface Approval {
  mode(): ApprovalMode;
  setMode(mode: ApprovalMode): void;
  /** 读这个目录（绝对路径）里的文件不用问，例如 skill 的目录。返回撤销函数，调用方的作用域关闭时自动撤销。项目层插件不能用 */
  allowRead(dir: string): () => void;
  /** 这个目录（绝对路径）和工作目录同样对待：auto 模式下在里面改文件不用问，例如会话的临时目录。返回撤销函数，调用方的作用域关闭时自动撤销。项目层插件不能用 */
  allowWrite(dir: string): () => void;
  /**
   * 登记一个审批渠道（例如聊天机器人）：要问用户时，问题同时交给终端和所有渠道，先回答的算数，
   * 其余的经 signal 收到中止。渠道返回 undefined、不认识的值或出错，算它不回答，不算拒绝；
   * 终端里取消照旧算拒绝。有渠道时，不能提问的前端（-p）也会问。返回撤销函数，调用方的作用域关闭时自动撤销。
   * request.detail 是 Text（可能带样式片段），只能显示纯文字的渠道用 plainText(request.detail)。
   * 项目层插件不能用
   */
  addApprover(approver: Approver): () => void;
  /**
   * 这个调用（例如子 Agent 的）在会话 session 里能不能不问就执行。只读工具：按该会话"总是允许"的规则、
   * allowRead/allowWrite 登记的目录和 yolo 模式判断。其他工具（bash）：只读模式下也放行的才算（工作目录里的只读命令），
   * yolo 模式和"总是允许"的规则都不放宽。会话不存在时为 false
   */
  allows(session: string, call: GatedToolCall): boolean;
}

/** 审批的回答：允许一次、本会话里总是允许、在这个工作目录里以后都允许、拒绝 */
export type Answer = "once" | "always" | "forever" | "deny";

export type Approver = (request: SelectRequest<Answer>, signal: AbortSignal) => Promise<Answer | undefined>;

// ---------- modes@1（jade/modes） ----------

/** modes@1 */
export interface Modes {
  current(): string;
  list(): { name: string; description: string }[];
  /** 换模式，从下一个工具调用起生效 */
  set(mode: string): void;
  /** 换到轮换顺序里的下一个 */
  cycle(): string;
  /** 模式变化时调用，返回取消订阅的函数；调用方关闭时自动取消 */
  subscribe(fn: (mode: string) => void): () => void;
}

// ---------- prompts@1（jade/prompts） ----------

/** prompts@1 */
export interface Prompts {
  /**
   * 往系统提示词里加一段，排在主体、环境信息和指令文件之后，返回撤销函数；调用方的作用域关闭时自动撤销。
   * stable（默认 true）的段落排在 volatile 的前面：会变的段落放在后面，前面的才能命中提示缓存。
   * 项目层插件加的段落标为不可信；untrusted 为 true 时也标为不可信（内容来自外部，例如 MCP 服务的说明、仓库里的 skill）
   */
  add(section: { text: string; stable?: boolean; untrusted?: boolean }): () => void;
  /**
   * 给模型留一句说明：下一次请求模型时以 "[Note from jade] …" 附在那个会话最后一条用户消息后面，并记进日志，
   * 之后的请求、恢复的会话里它都在同一个位置。用在命令里做了模型该知道的事（例如用户撤销了它改的文件）、
   * 又不该替用户发一条消息的时候。不发起新的一轮；会话没有再请求模型就关闭时，说明丢掉。
   * 项目层插件留的说明标为不可信
   */
  note(session: string, text: string): void;
  /**
   * 这个会话的系统提示词里的指令文件（用户的 AGENTS.md / CLAUDE.md、仓库里各级目录的），按放进提示词的顺序。
   * 给自己另起模型对话的插件用（例如子 Agent）：它们的提示词不经过 jade/prompts，要遵守同样的指令就从这里拿。
   * 仓库里的指令是不可信的，放进提示词时要保留 trust 和 source。会话不存在时为空
   */
  instructions?(session: string): PromptInstructions[];
}

/** 一份指令文件（Prompts.instructions） */
export interface PromptInstructions {
  /** 带标题的全文，可以直接作为系统提示词的一段 */
  text: string;
  trust: "trusted" | "untrusted";
  /** 出处：配置层、路径、内容哈希 */
  source: ContentSource;
}

// ---------- compact@1（jade/compact） ----------

/** compact@1 */
export interface Compact {
  /** 历史超过这么多 token 时自动压缩（界面显示用） */
  threshold(): number;
}

// ---------- sessions@1（jade/sessions） ----------

export interface SessionSummary {
  id: string;
  cwd: string;
  /** 第一条消息的开头 */
  title: string;
  /** 最近一次使用的时间（ISO） */
  at: string;
}

/** sessions@1 */
export interface SessionIndex {
  /** cwd 里的会话，最近用过的在前（jade --continue 取第一个） */
  list(cwd: string): Promise<SessionSummary[]>;
}

// ---------- shell@1（jade/shell） ----------

export interface RunResult {
  /** 超时被杀掉时为 null */
  code: number | null;
  /** stdout 和 stderr 合在一起，超长时保留首尾 */
  output: string;
  timedOut: boolean;
}

/** onOutput：输出一到就调用（stdout、stderr 各自按到达的顺序，一次可能是半行或好几行） */
export type RunCommand = (command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (text: string) => void }) => Promise<RunResult>;

/** shell@1 */
export interface Shell {
  /** 实际执行的 shell 程序；这台机器上没有时为 undefined */
  readonly executable: string | undefined;
  /** 找不到 shell 时的说明 */
  readonly unavailable?: string;
  /** 执行一条命令并收集输出；超时或中止时连同子进程一起杀掉 */
  run: RunCommand;
  /** 在 PATH 里找可执行文件（Windows 上按 PATHEXT 补扩展名），找不到返回 undefined */
  which(bin: string): string | undefined;
}

// ---------- tools@1（jade/tools） ----------

/**
 * tools@1：给嵌套 Agent（子 Agent 之类）用的工具的注册表。主会话里的工具对象是各插件私有的，
 * 所以提供工具的插件在这里另登记一套实例，另起 Agent 的插件来取。登记的一方不用知道谁在用
 */
export interface Tools {
  /**
   * 登记一个工具，返回撤销函数；登记者的作用域关闭时自动撤销。工具名已被别的插件登记时跳过并报告（同 Commands.register）。
   * 登记的工具不经过主会话的关卡（审批、hook），所以只登记嵌套 Agent 用得着的：现在登记的都是只读的，
   * 或者由使用方把关的（jade/shell 的 bash）。
   * opts.when：每次 list 时调用，返回 false 时这次不给（例如没有配置搜索服务时的 web_search）
   */
  register(tool: Tool, opts?: { when?: () => boolean }): () => void;
  /**
   * 现在登记着的工具，同名的取最后登记的。使用方自己筛选、自己把关：这些工具在它的 Agent 里执行时没有主会话的关卡守着，
   * 工具声明的 effect 说明它会不会改东西。例如 jade/task：只读工具读工作目录之外的路径、带 url 参数时问用户，
   * 其他工具（bash）只执行 approval@1 认定为只读的调用
   */
  list(): Tool[];
}

// ---------- steer@1（jade/steer） ----------

/** steer@1：在一轮的中途对模型说话。项目层插件不能替用户说话，push、take 对它们抛错 */
export interface Steer {
  /**
   * 用户在一轮中途说的一句话：下一次请求模型时附在最后一条消息（刚执行完的工具的结果）后面，并记进日志。
   * 会话里没有正在跑的一轮（或没有这个会话）时返回 false，调用方照常发消息。
   * 这一轮没有再请求模型就结束时，话还留着：调用方在一轮结束后用 take 取回，当作普通消息发出去
   */
  push(session: string, text: string): boolean;
  /** 还没交给模型的话，按先后 */
  pending(session: string): string[];
  /** 取回还没交给模型的话（一轮结束后发出去，或者用户想改） */
  take(session: string): string[];
  /** pending 变了（交给了模型、被取回、新加了一句）时调用，返回取消订阅；调用方的作用域关闭时自动取消 */
  subscribe(fn: () => void): () => void;
}
