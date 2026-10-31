"""示例：用 Python 写的进程外插件，把工具输出里的密钥替换掉，模型看不到。

jade 启动这个进程，经 stdin/stdout 用 JSON-RPC 2.0 通信，一行一条消息。只用标准库。
日志请写到 stderr：stdout 上任何不是 JSON-RPC 的输出都会让 jade 结束这个进程。
"""

import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", newline="\n")

MANIFEST = {
    "id": "example/redact-secrets",
    "version": "1.0.0",
    "kernel": "^0.1",
    "needs": ["transform:tool.after"],
    "hooks": [
        {
            # name 是插件自己起的名字，jade 调用 hook 时原样带回来
            "name": "redact",
            "kind": "transform",
            "point": "tool.after",
            # 只收到 content 字段，也只能改 content
            "reads": ["content"],
            "writes": ["content"],
            "timeoutMs": 5000,
        }
    ],
}

PATTERNS = [
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS access key
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),  # GitHub token
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),  # OpenAI / Anthropic 风格的 key
]


def redact_blocks(blocks):
    out = []
    for b in blocks:
        if b.get("kind") == "text":
            text = b["text"]
            for p in PATTERNS:
                text = p.sub("[REDACTED]", text)
            b = {**b, "text": text}
        elif b.get("kind") == "tool_result":
            b = {**b, "content": redact_blocks(b.get("content", []))}
        out.append(b)
    return out


def handle(method, params):
    if method == "initialize":
        return MANIFEST
    if method == "hook" and params["hook"] == "redact":
        return {"content": redact_blocks(params["payload"]["content"])}
    if method == "shutdown":
        return {}
    raise ValueError(f"unknown method {method}")


def send(message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    if "id" not in msg:
        continue  # 通知（例如 $/cancel），这个插件不需要处理
    try:
        send({"id": msg["id"], "result": handle(msg["method"], msg.get("params", {}))})
    except Exception as e:  # noqa: BLE001
        send({"id": msg["id"], "error": {"code": -32603, "message": str(e)}})
    if msg.get("method") == "shutdown":
        break
