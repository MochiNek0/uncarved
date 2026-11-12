"""jade 进程外插件的 Python SDK（设计见 docs/design/jade.md 第 6 节）。单文件，只用标准库。

jade 启动插件进程时把这个文件所在的目录加进 PYTHONPATH，插件直接 ``import jade_plugin``。

    from jade_plugin import Plugin

    plugin = Plugin()

    @plugin.process
    def process(ctx):
        ctx.provide("greeter@1", Greeter())                  # 公开方法都能被其他插件调用
        ctx.service("commands@1").register({"name": "hello", "run": hello})
        ctx.secrets.set("API_TOKEN", "...")                 # 只有这个插件自己的密钥（第 8 节）

    @plugin.session
    def session(ctx):
        ctx.tool("shout", "Upper-cases text", {"type": "object"}, effect="read", execute=shout)

    plugin.run()

stdout 只用来传协议消息，日志写到 stderr（jade 会转告用户）。每个请求在自己的线程里处理，
插件的处理函数可能同时被调用；处理函数里可以调用宿主（ctx.service(...).method(...)），调用会阻塞到宿主回复。
"""

from __future__ import annotations

import json
import sys
import threading
import traceback
from typing import Any, Callable

__all__ = ["Plugin", "Context", "Caller", "JadeError", "cancelled"]


class JadeError(Exception):
    """宿主返回的错误"""


_local = threading.local()


def cancelled() -> bool:
    """当前处理的请求是否已被宿主取消（例如用户中止了正在执行的工具）"""
    ev = getattr(_local, "cancel", None)
    return bool(ev and ev.is_set())


class Plugin:
    def __init__(self, id: str | None = None):
        self.id = id
        self._process: Callable[[Context], Any] | None = None
        self._session: Callable[[Context], Any] | None = None

    def process(self, fn: Callable[["Context"], Any]):
        """进程级：提供服务、向其他插件的注册服务注册东西"""
        self._process = fn
        return fn

    def session(self, fn: Callable[["Context"], Any]):
        """会话级：每个会话调用一次，注册工具和 hook"""
        self._session = fn
        return fn

    def run(self) -> None:
        _Connection(self).serve()


class Caller:
    """按调用方创建的服务实例拿到的调用方信息"""

    def __init__(self, id: str, plugin: str, layer: str):
        self.id = id
        self.plugin = plugin
        self.layer = layer
        self._disposers: list[Callable[[], Any]] = []

    def on_dispose(self, fn: Callable[[], Any]) -> None:
        """调用方关闭时执行：注册表在这里撤销调用方注册的东西"""
        self._disposers.append(fn)


class _Secrets:
    """一个作用域里的 ctx.secrets：按插件 id 隔离，value 为 None 时删除"""

    def __init__(self, conn: "_Connection", scope: str):
        self._conn = conn
        self._scope = scope

    def get(self, key: str) -> str | None:
        return self._conn.request("secrets/get", {"scope": self._scope, "key": key})

    def set(self, key: str, value: str | None) -> None:
        self._conn.request("secrets/set", {"scope": self._scope, "key": key, "value": value})


class _Service:
    """宿主那边一个服务的代理：任何属性都是方法，调用时发给宿主"""

    def __init__(self, conn: "_Connection", scope: str, name: str):
        self._conn = conn
        self._scope = scope
        self._name = name

    def __getattr__(self, method: str):
        if method.startswith("__"):
            raise AttributeError(method)
        return lambda *args: self._conn.call(self._scope, self._name, method, list(args))


class _RemoteFunction:
    """宿主交给插件的函数"""

    def __init__(self, conn: "_Connection", scope: str, fn: str):
        self._conn = conn
        self._scope = scope
        self._fn = fn

    def __call__(self, *args):
        return self._conn.call(self._scope, {"$fn": self._fn}, None, list(args))


class Context:
    """一个作用域（进程级或某个会话）的 ctx"""

    def __init__(self, conn: "_Connection", scope: str, params: dict):
        self._conn = conn
        self.scope = scope
        self.kind: str = params["kind"]
        self.cwd: str = params.get("cwd", "")
        self.home: str = params.get("home", "")
        self.config: dict = params.get("config") or {}
        self.secrets = _Secrets(conn, scope)
        self.session_id: str | None = (params.get("session") or {}).get("id")
        self._on_close: list[Callable[[], Any]] = []

    def service(self, name: str) -> Any:
        """取一个声明在 plugin.json 的 requires 或 optional 里的服务"""
        return _Service(self._conn, self.scope, name)

    require = service

    def report(self, message: str) -> None:
        """告诉用户一个问题（警告，不是错误），消息前面加上插件 id"""
        self._conn.request("report", {"scope": self.scope, "message": message})

    def provide(self, name: str, impl: Any = None, *, factory: Callable[[Caller], Any] | None = None, methods: list[str] | None = None) -> None:
        """
        提供一个声明在 provides 里的服务，只能在 process 里调用。
        impl：所有调用方共用的对象，公开方法都可以被调用。
        factory：每个调用方调用一次，返回这个调用方专用的实例；factory 不是类时用 methods 列出方法名
        """
        if (impl is None) == (factory is None):
            raise ValueError("provide needs exactly one of impl and factory")
        source = impl if impl is not None else factory
        if methods is None:
            if factory is not None and not isinstance(factory, type):
                raise ValueError("provide(factory=...) needs methods=[...] unless the factory is a class")
            methods = [n for n in dir(source) if not n.startswith("_") and callable(getattr(source, n))]
        if factory is not None:
            self._conn.factories[name] = factory
        else:
            self._conn.services[name] = impl
        self._conn.request("provide", {"scope": self.scope, "service": name, "methods": methods, "perCaller": factory is not None})

    def tool(self, name: str, description: str, input_schema: dict, *, effect: str, execute: Callable[[Any, dict], Any], concurrency: str = "exclusive", idempotent: bool = False, meta: dict | None = None) -> None:
        """
        注册一个工具，只能在 session 里调用。effect："read"、"write" 或 "external"。
        execute(input, ctx) 返回文字，或 {"content": 文字或 block 列表, "isError": bool}。
        meta：别的插件据此认出工具做什么，{"writes": "path"} 表示写输入里 path 字段给的文件，{"shell": "command"} 表示执行 command 字段里的命令
        """
        tool = {"name": name, "description": description, "inputSchema": input_schema, "effect": effect, "concurrency": concurrency, "idempotent": idempotent}
        if meta is not None:
            tool["meta"] = meta
        self._conn.request("kernel/tool", {"scope": self.scope, "tool": tool, "execute": self._conn.handle(execute, self.scope)})

    def hook(self, kind: str, point: str, fn: Callable[[dict], Any], *, reads: list[str], writes: list[str] | None = None, timeout_ms: int = 30_000, order: int | None = None) -> None:
        """
        注册一个内核 hook，只能在 session 里调用。fn 只收到 reads 列出的字段；
        transform 返回要改的字段（只能是 writes 里的），gate 返回 {"decision": ..., "reason": ...}
        """
        hook = {"kind": kind, "point": point, "reads": reads, "writes": writes or [], "timeoutMs": timeout_ms}
        if order is not None:
            hook["order"] = order
        self._conn.request("kernel/hook", {"scope": self.scope, "hook": hook, "fn": self._conn.handle(fn, self.scope)})

    def send(self, input: dict) -> None:
        """发起一轮（会话级）。不要在工具或 hook 里调用：它要等当前这一轮结束"""
        self._conn.call(self.scope, "$session", "send", [input])

    def abort(self, reason: str | None = None) -> None:
        """中止正在跑的这一轮（会话级）；空闲时什么都不做"""
        self._conn.call(self.scope, "$session", "abort", [reason])

    def after_turn(self, fn: Callable[[], Any]) -> None:
        """本轮完全结束后执行一次（会话级）"""
        self._conn.call(self.scope, "$session", "afterTurn", [fn])

    def state(self) -> dict:
        """会话现在的状态（阶段、消息、还没做完的工具调用、derived）。scope 打开期间（session 函数里）还没有"""
        return self._conn.call(self.scope, "$session", "state", [])

    def subscribe(self, fn: Callable[[dict], Any]) -> None:
        """订阅运行时的通知（事件、增量、工具进度、awaiting），作用域关闭时自动取消（会话级）"""
        self._conn.call(self.scope, "$session", "subscribe", [fn])

    def on_close(self, fn: Callable[[], Any]) -> None:
        """作用域关闭时执行，逆序"""
        self._on_close.append(fn)


class _Connection:
    def __init__(self, plugin: Plugin):
        self.plugin = plugin
        self.services: dict[str, Any] = {}
        self.factories: dict[str, Callable[[Caller], Any]] = {}
        self.callers: dict[str, tuple[Caller, Any]] = {}
        self.scopes: dict[str, Context] = {}
        self._fns: dict[str, Callable] = {}
        self._buckets: dict[str, set[str]] = {}
        self._pending: dict[int, list] = {}
        self._incoming: dict[Any, threading.Event] = {}
        self._lock = threading.Lock()
        self._next = 0
        self._out = sys.stdout.buffer
        self._in = sys.stdin.buffer
        # 插件代码误用 print 时不要弄坏协议：stdout 改指向 stderr
        sys.stdout = sys.stderr

    # ---------- 值 ----------

    def handle(self, fn: Callable, scope: str) -> dict:
        with self._lock:
            self._next += 1
            h = f"p{self._next}"
            self._fns[h] = fn
            self._buckets.setdefault(scope, set()).add(h)
        return {"$fn": h}

    def encode(self, v: Any, scope: str) -> Any:
        if callable(v) and not isinstance(v, (type, _Service)):
            return self.handle(v, scope)
        if isinstance(v, (list, tuple)):
            return [self.encode(x, scope) for x in v]
        if isinstance(v, dict):
            return {k: self.encode(x, scope) for k, x in v.items()}
        return v

    def decode(self, v: Any, scope: str) -> Any:
        if isinstance(v, dict):
            if len(v) == 1 and isinstance(v.get("$fn"), str):
                return _RemoteFunction(self, scope, v["$fn"])
            return {k: self.decode(x, scope) for k, x in v.items()}
        if isinstance(v, list):
            return [self.decode(x, scope) for x in v]
        return v

    # ---------- 传输 ----------

    def _write(self, msg: dict) -> None:
        data = json.dumps(msg).encode("utf-8") + b"\n"
        with self._lock:
            self._out.write(data)
            self._out.flush()

    def request(self, method: str, params: dict) -> Any:
        with self._lock:
            self._next += 1
            id = self._next
            slot = [threading.Event(), None, None]
            self._pending[id] = slot
        self._write({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
        slot[0].wait()
        if slot[2] is not None:
            raise JadeError(slot[2].get("message", "error"))
        return slot[1]

    def call(self, scope: str, target: Any, method: str | None, args: list) -> Any:
        params = {"scope": scope, "target": target, "args": self.encode(args, scope)}
        if method is not None:
            params["method"] = method
        return self.decode(self.request("call", params), scope)

    def serve(self) -> None:
        while True:
            line = self._in.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                print(f"jade_plugin: ignored a malformed line: {line[:200]!r}", file=sys.stderr)
                continue
            method = msg.get("method")
            if method is None:
                slot = self._pending.pop(msg.get("id"), None)
                if slot is not None:
                    slot[1] = msg.get("result")
                    slot[2] = msg.get("error")
                    slot[0].set()
            elif method == "$/cancel":
                ev = self._incoming.get((msg.get("params") or {}).get("id"))
                if ev is not None:
                    ev.set()
            else:
                id = msg.get("id")
                cancel = threading.Event()
                if id is not None:
                    self._incoming[id] = cancel
                threading.Thread(target=self._serve_one, args=(id, method, msg.get("params") or {}, cancel), daemon=True).start()
        # 宿主关闭了管道：清理全部作用域后退出
        for scope in list(self.scopes):
            self._close(scope)

    def _serve_one(self, id: Any, method: str, params: dict, cancel: threading.Event) -> None:
        _local.cancel = cancel
        try:
            result = self._dispatch(method, params)
            if id is not None:
                self._write({"jsonrpc": "2.0", "id": id, "result": result})
        except Exception as e:
            if not isinstance(e, JadeError):
                traceback.print_exc(file=sys.stderr)
            if id is not None:
                self._write({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": str(e) or type(e).__name__}})
        finally:
            self._incoming.pop(id, None)

    # ---------- 宿主发来的请求 ----------

    def _dispatch(self, method: str, p: dict) -> Any:
        if method == "initialize":
            return {**({"id": self.plugin.id} if self.plugin.id else {}), "session": self.plugin._session is not None}
        if method == "scope/open":
            ctx = Context(self, p["scope"], p)
            self.scopes[ctx.scope] = ctx
            fn = self.plugin._process if ctx.kind == "process" else self.plugin._session
            if fn is not None:
                fn(ctx)
            return None
        if method == "scope/close":
            self._close(p["scope"])
            return None
        if method == "caller/open":
            c = p["caller"]
            caller = Caller(c["id"], c["plugin"], c["layer"])
            self.callers[caller.id] = (caller, self.factories[p["service"]](caller))
            return None
        if method == "caller/close":
            entry = self.callers.pop(p["caller"], None)
            if entry:
                for d in reversed(entry[0]._disposers):
                    _quietly(d)
            return None
        if method == "call":
            scope = p.get("scope", "process")
            args = self.decode(p.get("args") or [], scope)
            target = p.get("target")
            if isinstance(target, dict):
                fn = self._fns.get(target.get("$fn"))
                if fn is None:
                    raise JadeError(f"function {target.get('$fn')} is no longer valid")
                result = fn(*args)
            else:
                if "caller" in p:
                    entry = self.callers.get(p["caller"])
                    if entry is None:
                        raise JadeError(f"caller {p['caller']} is closed")
                    impl = entry[1]
                else:
                    impl = self.services.get(target)
                if impl is None:
                    raise JadeError(f"service {target} is not provided by this plugin")
                result = getattr(impl, p["method"])(*args)
            return self.encode(result, scope)
        raise JadeError(f"unknown method {method}")

    def _close(self, scope: str) -> None:
        ctx = self.scopes.pop(scope, None)
        if ctx is not None:
            for fn in reversed(ctx._on_close):
                _quietly(fn)
        with self._lock:
            for h in self._buckets.pop(scope, set()):
                self._fns.pop(h, None)


def _quietly(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:
        traceback.print_exc(file=sys.stderr)
