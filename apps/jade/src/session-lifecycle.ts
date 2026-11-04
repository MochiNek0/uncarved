// 会话的生命周期：开始、离开、换会话（/clear、/resume）、重新加载、退出。每个会话一套插件实例（SessionScope）和一个运行时。
//
// 换会话是事务（docs/design/jade-plugin-lifecycle.md 第 5 节）：
//   1. prepare：新的一套在 preparing 里创建，工厂函数这时运行；
//   2. 打开新的运行时；失败就回滚：只收掉新的一套，当前的一套一直是 active，不用恢复任何东西；
//   3. commit：关闭旧的一套（ctx.signal 中止），会话收尾（detach），换成新的，激活新的；旧的一套在后台 dispose。
// 退出前 settled() 等所有后台 dispose 完成。
//
// 这里不碰界面：清屏、状态栏的会话号、提示由调用方（main.ts）在每一步之后做。

import type { Plugin, Runtime } from "uncarved";
import type { Jade } from "./distro.ts";
import type { SessionScope } from "./session-scope.ts";

export interface LifecycleDeps<Mode> {
  /** 创建一套新的插件实例，挂在一个 preparing 的作用域上 */
  prepare(mode: Mode | undefined): Promise<SessionScope>;
  /** 打开运行时：有 id 时恢复那个会话，没有时开始新会话 */
  open(plugins: Plugin[], id?: string): Promise<Runtime>;
  /** 离开会话之后调用：会话没用过就删掉它的日志；返回是否删掉了 */
  discard(sessionId: string): Promise<boolean>;
  /** 要告诉用户的问题（插件 dispose 出错、超时等） */
  warn(list: string[]): void;
  /** 会话收尾失败：仍然继续离开 */
  error(err: unknown): void;
}

/** 当前会话：一起换 */
export interface Current {
  scope: SessionScope;
  jade: Jade;
  rt: Runtime;
  sessionId: string;
}

export class SessionLifecycle<Mode = string> {
  readonly #deps: LifecycleDeps<Mode>;
  #scope: SessionScope;
  #rt: Runtime | undefined;
  #sessionId = "";
  /** 后台进行中的 dispose：换会话时不等它（新会话已经能用了），退出前等完（各自限时，见 DISPOSE_TIMEOUT_MS） */
  readonly #disposals = new Set<Promise<void>>();

  private constructor(deps: LifecycleDeps<Mode>, scope: SessionScope) {
    this.#deps = deps;
    this.#scope = scope;
  }

  /**
   * 启动的第一步：创建第一套插件实例（还没激活）。之后宿主可以先读 jade（命令、警告、服务），再调用 begin 打开会话
   */
  static async prepare<Mode>(deps: LifecycleDeps<Mode>, mode?: Mode): Promise<SessionLifecycle<Mode>> {
    return new SessionLifecycle(deps, await deps.prepare(mode));
  }

  get scope(): SessionScope {
    return this.#scope;
  }

  get jade(): Jade {
    return this.#scope.jade;
  }

  /** 当前会话；begin 之前不能用 */
  get current(): Current {
    if (!this.#rt) throw new Error("the session has not begun");
    return { scope: this.#scope, jade: this.#scope.jade, rt: this.#rt, sessionId: this.#sessionId };
  }

  /** 启动的第二步：打开第一个会话并激活插件。失败时收掉这套实例再抛出 */
  async begin(id?: string): Promise<Current> {
    try {
      this.#commit(this.#scope, await this.#deps.open(this.jade.plugins, id));
    } catch (err) {
      this.jade.shutdown();
      this.#deps.warn(await this.#scope.dispose());
      throw err;
    }
    return this.current;
  }

  /**
   * 离开当前会话但保留它（退出、换会话时）：先关闭作用域（进行中的快捷键、插件的 ctx.signal 中止），再会话收尾。
   * 会话收尾（session.detached 的 hook）用的还是这套实例，之后才在后台 dispose。返回会话是否保留了下来
   */
  async leave(reason = "the session ended"): Promise<boolean> {
    const { scope, rt, sessionId } = this.current;
    scope.close(reason);
    scope.jade.shutdown();
    try {
      await rt.detach();
      return !(await this.#deps.discard(sessionId));
    } catch (err) {
      this.#deps.error(err);
      return true;
    } finally {
      this.#disposeInBackground(scope);
    }
  }

  /**
   * 换成另一个会话：id 为空时开始新会话（/clear），否则恢复它（/resume）。
   * 打开失败时回滚并抛出，当前会话不受影响；成功时返回旧会话的 id 和它是否保留了下来
   */
  async switchTo(id: string | undefined, mode: Mode | undefined): Promise<{ previous: string; kept: boolean }> {
    const next = await this.#deps.prepare(mode);
    let rt: Runtime;
    try {
      rt = await this.#deps.open(next.jade.plugins, id);
    } catch (err) {
      // 回滚：新的一套从没激活过，收掉它就行；当前的一套一直是 active
      next.jade.shutdown();
      this.#deps.warn(await next.dispose());
      throw err;
    }
    const previous = this.#sessionId;
    const kept = await this.leave();
    this.#commit(next, rt);
    return { previous, kept };
  }

  /**
   * 用新的插件实例继续当前会话：工具和系统提示词按现在的配置重新生成，对话内容不变。
   * 同一个会话要先 detach 才能用新的实例恢复，所以先关掉当前的一套；恢复失败时改为开始新会话，返回那个错误
   */
  async reload(mode: Mode | undefined): Promise<{ error?: unknown }> {
    const next = await this.#deps.prepare(mode);
    const { scope, rt, sessionId } = this.current;
    scope.close("the session was reloaded");
    scope.jade.shutdown();
    try {
      await rt.detach();
    } catch (err) {
      this.#deps.error(err);
    } finally {
      this.#disposeInBackground(scope);
    }
    let error: unknown;
    let opened: Runtime;
    try {
      opened = await this.#deps.open(next.jade.plugins, sessionId);
    } catch (err) {
      error = err;
      try {
        opened = await this.#deps.open(next.jade.plugins);
      } catch (again) {
        next.jade.shutdown();
        this.#deps.warn(await next.dispose());
        throw again;
      }
    }
    this.#commit(next, opened);
    return error === undefined ? {} : { error };
  }

  /** 退出前：等后台的 dispose 都完成 */
  async settled(): Promise<void> {
    await Promise.all(this.#disposals);
  }

  #commit(scope: SessionScope, rt: Runtime) {
    this.#scope = scope;
    this.#rt = rt;
    this.#sessionId = rt.state.sessionId;
    scope.activate();
  }

  #disposeInBackground(scope: SessionScope) {
    const done = scope.dispose().then((w) => this.#deps.warn(w));
    this.#disposals.add(done);
    void done.finally(() => this.#disposals.delete(done));
  }
}
