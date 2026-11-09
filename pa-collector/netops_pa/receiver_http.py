"""HTTP Log Forwarding 接收端點(:51293;TRAFFIC 以外的類型,P7 定案)。

PA-560 的 HTTP Server Profile 設定見 docs/PA-FORWARDING-SPEC.md:
  POST /v1/logs/{type}       type = threat、url、wildfire、data、decryption、globalprotect、userid
  標頭 X-NetOps-Token: <PA_HTTP_TOKEN>
  本文 JSON:一筆物件、物件陣列,或一行一筆(NDJSON);key 為 PA-LIVE-PLAN §4 的欄位
檢查順序:來源 IP(連線時)→ 路徑與方法 → Token(固定時間比對)→ 長度上限 → JSON → 欄位。
本文、Token 一律不寫日誌。回應不含伺服器版本。
"""

from __future__ import annotations

import hmac
import json
import logging
from http.server import BaseHTTPRequestHandler
from typing import Any

from .keys import HTTP_TYPES
from .pipeline import Pipeline
from .records import normalize
from .servers import GuardedServer, warn

log = logging.getLogger("netops_pa.http")

TOKEN_HEADER = "X-NetOps-Token"  # noqa: S105 — 標頭名稱,不是機密
PATH_PREFIX = "/v1/logs/"
# 一個請求最多幾筆(PA 一次送一筆或小批;超過視為異常)
MAX_RECORDS = 2000


def parse_body(body: bytes) -> list[Any] | None:
    """一筆物件 / 物件陣列 / NDJSON → 物件清單;格式錯誤回 None。"""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = text.strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    except (ValueError, RecursionError):
        # ValueError 含 JSONDecodeError 與超長整數;RecursionError:深層巢狀
        pass
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except (ValueError, RecursionError):
            return None
    return out


class Handler(BaseHTTPRequestHandler):
    server: HttpReceiver
    protocol_version = "HTTP/1.1"
    # 不回伺服器與 Python 版本
    server_version = "netops-pa"
    sys_version = ""
    # 每次讀取的逾時(秒):慢速連線、閒置的 keep-alive 連線不長期佔住名額
    timeout = 10

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — 覆寫標準函式庫簽名
        # 預設會把請求列印到 stderr;只記錄錯誤(send_error),不記路徑以外的內容
        log.debug("%s %s", self.client_address[0], format % args)

    def _reply(self, status: int, obj: dict[str, Any]) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, status: int, code: str, counter: str = "rejected") -> None:
        self.server.status.add(counter)
        self._discard_body()
        self._reply(status, {"code": code})

    def _discard_body(self) -> None:
        """回錯誤前讀掉未讀的本文(上限 max_body):不讀就關閉連線時,對方(Windows、PA-560)可能收到 RST 而看不到錯誤碼。"""
        raw = self.headers.get("Content-Length", "") if self.headers else ""
        if getattr(self, "_body_read", False) or not (raw.isascii() and raw.isdigit() and len(raw) <= 9):
            return
        n = int(raw)
        if 0 < n <= self.server.max_body:
            try:
                self.rfile.read(n)
            except OSError:
                pass
        self._body_read = True

    def do_GET(self) -> None:  # noqa: N802
        self._reject(405, "METHOD_NOT_ALLOWED")

    # HEAD 不定義:標準函式庫回 501 且不寫本文
    do_PUT = do_DELETE = do_PATCH = do_GET  # noqa: N815

    def do_POST(self) -> None:  # noqa: N802
        srv = self.server
        path = self.path.split("?", 1)[0]
        log_type = path[len(PATH_PREFIX):] if path.startswith(PATH_PREFIX) else ""
        if log_type not in HTTP_TYPES:
            return self._reject(404, "NOT_FOUND")
        token = self.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(token.encode(), srv.token.encode()):
            warn.warning("http:token", "HTTP 接收 Token 不符,來源 %s", self.client_address[0])
            return self._reject(401, "TOKEN_INVALID")
        if self.headers.get("Transfer-Encoding"):
            return self._reject(411, "LENGTH_REQUIRED")
        raw_len = self.headers.get("Content-Length", "")
        if not (raw_len.isascii() and raw_len.isdigit() and len(raw_len) <= 9):
            return self._reject(411, "LENGTH_REQUIRED")
        length = int(raw_len)
        if length > srv.max_body:
            return self._reject(413, "TOO_LARGE")
        body = self.rfile.read(length)
        self._body_read = True
        if len(body) != length:
            return self._reject(400, "INCOMPLETE", "malformed")
        items = parse_body(body)
        if items is None or len(items) > MAX_RECORDS:
            return self._reject(400, "MALFORMED", "malformed")
        records = []
        for raw in items:
            rec = normalize(log_type, raw)
            if rec is None:
                srv.status.add("malformed")
            else:
                records.append(rec)
        accepted = srv.pipeline.submit(log_type, records, "http")
        # 速率上限丟棄的部分仍回 200:PA 收到錯誤會重送,反而加重負擔(丟棄數記在心跳 dropped)
        self._reply(200, {"accepted": accepted})


class HttpReceiver(GuardedServer):
    def __init__(self, addr: tuple[str, int], *, token: str, pipeline: Pipeline, max_body: int, **kw: Any) -> None:
        self.token = token
        self.pipeline = pipeline
        self.max_body = max_body
        super().__init__(addr, Handler, name="HTTP 接收", **kw)
