"""Syslog 接收端點(:51294,TCP,選用 TLS;只收 TRAFFIC,P7 定案)。

PA-560 Syslog Server Profile 的自訂格式(docs/PA-FORWARDING-SPEC.md)讓訊息本文是一個 JSON 物件,
key 為 PA-LIVE-PLAN §4 的欄位。BSD(RFC 3164)與 IETF(RFC 5424)兩種格式都可以:訊息裡第一個 { 起算到結尾當 JSON。
TCP 分框兩種都接受(RFC 6587):以換行結尾,或「長度 空格 訊息」(octet counting)。

防範畸形與過大輸入(PA-LIVE-PLAN §9):
- 單一訊息超過 PA_MAX_SYSLOG_MESSAGE:丟棄到下一個換行(換行分框)或直接斷線(長度分框),計數 rejected。
- 閒置 300 秒沒有資料就斷線;同時連線數有上限(servers.py)。
- 解析失敗計數 malformed,不寫日誌內容。速率上限與佇列上限由 pipeline 控制。
"""

from __future__ import annotations

import json
import logging
import socket
import socketserver
from typing import Any

from .pipeline import Pipeline
from .records import normalize
from .servers import GuardedServer, warn

log = logging.getLogger("netops_pa.syslog")

# PA-560 有流量時每秒都有資料;閒置太久的連線釋放名額
IDLE_SECONDS = 120
READ_SIZE = 64 * 1024


def parse_message(msg: bytes) -> dict[str, Any] | None:
    """一則 syslog → TRAFFIC 紀錄;不是 JSON 物件、類型不是 TRAFFIC、沒有已知欄位時回 None。"""
    i = msg.find(b"{")
    if i < 0:
        return None
    try:
        data = json.loads(msg[i:].decode("utf-8").strip())
    except (ValueError, RecursionError):
        # ValueError 含 UnicodeDecodeError、JSONDecodeError、超長整數;RecursionError:深層巢狀
        return None
    if not isinstance(data, dict):
        return None
    # 這個 port 只收 TRAFFIC;設定錯誤送來其他類型時拒收,不混進 TRAFFIC 統計
    t = data.get("type")
    if isinstance(t, str) and t and t.upper() != "TRAFFIC":
        return None
    return normalize("traffic", data)


class Framer:
    """TCP 位元組流 → 一則一則訊息。超過上限回報 oversize。

    以位移索引掃描、最後一次截斷緩衝區(一次讀入 64 KB 含很多小訊息時不會反覆搬移)。
    """

    def __init__(self, max_message: int) -> None:
        self.max = max_message
        self.buf = bytearray()
        # 換行分框遇到過長訊息時,丟棄直到下一個換行
        self.skipping = False
        self.oversize = 0
        self.fatal = False

    def feed(self, data: bytes) -> list[bytes]:
        self.buf += data
        buf, out, pos, size = self.buf, [], 0, len(self.buf)
        while pos < size and not self.fatal:
            if self.skipping:
                j = buf.find(b"\n", pos)
                if j < 0:
                    pos = size
                    break
                pos, self.skipping = j + 1, False
                continue
            # 長度分框(RFC 6587 octet counting):開頭是 1–6 位數字(不以 0 開頭)+ 空格
            k = pos
            while k < size and k - pos < 6 and 48 <= buf[k] <= 57:
                k += 1
            if k > pos and k < size and buf[k] == 32 and buf[pos] != 48:
                n = int(buf[pos:k])
                if n > self.max:
                    # 長度分框無法安全找到下一則的開頭,只能斷線
                    self.oversize += 1
                    self.fatal = True
                    break
                if size < k + 1 + n:
                    break
                out.append(bytes(buf[k + 1 : k + 1 + n]))
                pos = k + 1 + n
                continue
            if k == size and k - pos < 6:
                # 只收到數字,等更多資料才能判斷分框方式
                break
            j = buf.find(b"\n", pos)
            if j < 0:
                if size - pos > self.max:
                    self.oversize += 1
                    self.skipping = True
                    pos = size
                break
            if j - pos > self.max:
                self.oversize += 1
            else:
                line = bytes(buf[pos:j]).rstrip(b"\r")
                if line:
                    out.append(line)
            pos = j + 1
        del buf[:pos]
        return out


class Handler(socketserver.BaseRequestHandler):
    server: SyslogReceiver

    def handle(self) -> None:
        srv = self.server
        sock: socket.socket = self.request
        sock.settimeout(IDLE_SECONDS)
        framer = Framer(srv.max_message)
        pending: list[dict[str, Any]] = []
        try:
            while True:
                try:
                    data = sock.recv(READ_SIZE)
                except OSError:
                    break
                if not data:
                    break
                for msg in framer.feed(data):
                    rec = parse_message(msg)
                    if rec is None:
                        srv.status.add("malformed")
                    else:
                        pending.append(rec)
                if framer.oversize:
                    srv.status.add("rejected", framer.oversize)
                    warn.warning("syslog:oversize", "Syslog 訊息超過上限(%d bytes),丟棄 %d 則,來源 %s",
                                 srv.max_message, framer.oversize, self.client_address[0])
                    framer.oversize = 0
                # 每次讀完就送出(不等緩衝區清空,避免半則訊息讓已解析的 log 延遲)
                if pending:
                    srv.pipeline.submit("traffic", pending, "syslog")
                    pending = []
                if framer.fatal:
                    break
        finally:
            if pending:
                srv.pipeline.submit("traffic", pending, "syslog")


class SyslogReceiver(GuardedServer):
    def __init__(self, addr: tuple[str, int], *, pipeline: Pipeline, max_message: int, **kw: Any) -> None:
        self.pipeline = pipeline
        self.max_message = max_message
        super().__init__(addr, Handler, name="Syslog 接收", **kw)
