"""兩個接收端點共用:來源 IP 檢查、同時連線數上限、選用的 TLS(可要求用戶端憑證)。

標準函式庫 socketserver(不另裝套件):PA-560 只有一台、連線數少,每條連線一個執行緒即可;
同時連線數超過 PA_MAX_CONNECTIONS 直接關閉,避免無限開執行緒。被拒絕的連線只計數,日誌每分鐘最多一則。

注意:主機 2 / 3 經 Windows portproxy 轉入時,容器看到的來源是 Docker 閘道,不是 PA-560(Gateway DEPLOYMENT §6.1),
所以真正只放行 PA-560 的是 Windows 防火牆規則(docs/PA-FORWARDING-SPEC.md 附錄 F);這裡的檢查是第二道防線。
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import socketserver
import ssl
import threading
from collections.abc import Sequence

from .status import Status, ThrottledLog

log = logging.getLogger("netops_pa.servers")
warn = ThrottledLog(log)

Network = ipaddress.IPv4Network | ipaddress.IPv6Network

# TLS 握手的時間上限(秒)
HANDSHAKE_SECONDS = 10


def source_allowed(addr: str, allowed: Sequence[Network]) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    # IPv4-mapped IPv6(::ffff:10.1.2.3)當成 IPv4 比對
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in n for n in allowed if n.version == ip.version)


def tls_context(cert: str, key: str, client_ca: str = "") -> ssl.SSLContext | None:
    """伺服器端 TLS;client_ca 有設定時要求用戶端憑證(PA-560 的憑證須由該 CA 簽發)。"""
    if not cert:
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    if client_ca:
        ctx.verify_mode = ssl.CERT_REQUIRED
        ctx.load_verify_locations(client_ca)
    return ctx


class GuardedServer(socketserver.ThreadingTCPServer):
    """來源檢查 + 連線數上限 + TLS(在處理執行緒內握手,不卡住 accept)。"""

    daemon_threads = True
    allow_reuse_address = True
    # 收到連線但還沒處理時的佇列長度
    request_queue_size = 16

    def __init__(self, addr: tuple[str, int], handler: type[socketserver.BaseRequestHandler], *, name: str,
                 allowed: Sequence[Network], max_connections: int, tls: ssl.SSLContext | None, status: Status) -> None:
        self.name = name
        self.allowed = allowed
        self.tls = tls
        self.status = status
        self._slots = threading.BoundedSemaphore(max_connections)
        self._thread: threading.Thread | None = None
        super().__init__(addr, handler)

    def verify_request(self, request, client_address) -> bool:  # type: ignore[override]
        if not source_allowed(client_address[0], self.allowed):
            self.status.add("rejected")
            # 只記來源位址,不記內容
            warn.warning(f"{self.name}:source", "%s 拒絕不在允許清單的來源 %s", self.name, client_address[0])
            return False
        if not self._slots.acquire(blocking=False):
            self.status.add("rejected")
            warn.warning(f"{self.name}:limit", "%s 同時連線數已達上限,拒絕 %s", self.name, client_address[0])
            return False
        return True

    def process_request_thread(self, request, client_address) -> None:  # type: ignore[override]
        try:
            if self.tls is not None:
                request.settimeout(HANDSHAKE_SECONDS)
                try:
                    request = self.tls.wrap_socket(request, server_side=True)
                except (ssl.SSLError, OSError) as e:
                    self.status.add("rejected")
                    warn.warning(f"{self.name}:tls", "%s TLS 握手失敗 %s:%s", self.name, client_address[0], type(e).__name__)
                    self.shutdown_request(request)
                    return
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def shutdown_request(self, request) -> None:  # type: ignore[override]
        try:
            request.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        self.close_request(request)

    def handle_error(self, request, client_address) -> None:  # type: ignore[override]
        # 預設會把堆疊印到 stderr;只記類型(內容可能是對方送來的資料)
        self.status.add("malformed")
        warn.warning(f"{self.name}:error", "%s 處理 %s 的連線發生錯誤", self.name, client_address[0])

    def start(self) -> None:
        self._thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.5}, name=self.name, daemon=True)
        self._thread.start()

    def alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()
