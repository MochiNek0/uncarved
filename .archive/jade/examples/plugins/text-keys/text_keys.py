"""示例：用 Python 写的进程外插件，提供斜杠命令和快捷键。

jade 启动这个进程，经 stdin/stdout 用 JSON-RPC 2.0 通信，一行一条消息。只用标准库。
- 斜杠命令：jade 发 jade/command，回复 {"text"} 显示给用户，{"prompt"} 作为用户消息发给模型。
- 快捷键：jade 发 jade/key，用户层插件收到的参数里有输入框的文字 text；
  回复 {"set"} 换掉输入框的文字，{"insert"} 在光标处插入，{"send"} 替用户发送。项目层插件收不到 text，回复也不起作用。
日志请写到 stderr：stdout 上任何不是 JSON-RPC 的输出都会让 jade 结束这个进程。
"""

import datetime
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", newline="\n")

MANIFEST = {
    "id": "example/text-keys",
    "version": "1.0.0",
    "kernel": "^0.1",
    "hooks": [],
    "commands": [
        {"name": "wc", "args": "<text>", "description": "count the words and characters of the text", "instant": True},
        {"name": "explain", "args": "<topic>", "description": "ask the agent to explain a topic simply"},
    ],
    "keys": [
        {"key": "alt+u", "description": "uppercase the input box"},
        {"key": "alt+d", "description": "insert today's date"},
        {"key": "alt+s", "description": "send the input box as a question about the current directory"},
    ],
}


def command(name, args):
    if name == "wc":
        return {"text": f"{len(args.split())} words, {len(args)} characters"}
    if name == "explain":
        if not args.strip():
            return {"text": "Usage: /explain <topic>"}
        return {"prompt": f"Explain {args} in simple words, with one short example."}
    raise ValueError(f"unknown command {name}")


def key(name, text):
    # 项目层插件收不到 text（是 None）
    if name == "alt+u":
        return {"set": text.upper()} if text else {}
    if name == "alt+d":
        return {"insert": datetime.date.today().isoformat()}
    if name == "alt+s":
        return {"send": f"In this directory: {text}", "set": ""} if text and text.strip() else {}
    raise ValueError(f"unknown key {name}")


def handle(method, params):
    if method == "initialize":
        return MANIFEST
    if method == "shutdown":
        return {}
    if method == "jade/command":
        return command(params["name"], params.get("args", ""))
    if method == "jade/key":
        return key(params["key"], params.get("text"))
    raise ValueError(f"unknown method {method}")


def send(msg):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **msg}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    if "id" not in msg or "method" not in msg:
        continue  # $/cancel 之类的通知：这里每个请求都立即回复，不用处理
    try:
        send({"id": msg["id"], "result": handle(msg["method"], msg.get("params") or {})})
    except Exception as err:  # noqa: BLE001
        send({"id": msg["id"], "error": {"code": -32000, "message": str(err)}})
    if msg["method"] == "shutdown":
        break
