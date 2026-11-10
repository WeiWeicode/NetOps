"""接收端點 → 有上限的佇列 → 寫入執行緒(批次寫 Redis)。

記憶體與速率限制(PA-LIVE-PLAN §9):
- 佇列有上限(PA_QUEUE_SIZE);滿了就丟棄新進的 log 並計數 dropped,不無限累積。
- 速率上限(PA_MAX_RATE 筆 / 秒,token bucket)**HTTP 與 Syslog 各一個**;Syslog(TRAFFIC,沒有 Token)最多只能用
  佇列的 80%,保留空間給 HTTP 的威脅等資安 log,TRAFFIC 洪流不會擠掉資安事件。
- Redis 寫入失敗:這批丟棄並計數 redisFailed,錯誤寫進心跳(Redis 恢復後才看得到);不重試,避免佇列塞滿。
丟棄的 log 歷史仍可從 FTP 查(PA-LIVE-PLAN §3.2)。
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any

from .control import Control
from .status import Status, ThrottledLog
from .store import RedisStore

log = logging.getLogger("netops_pa.pipeline")

BATCH_MAX = 1000
BATCH_SECONDS = 1.0
HEARTBEAT_SECONDS = 5.0
# Syslog 最多可用的佇列比例
SYSLOG_QUEUE_SHARE = 0.8


class RateLimiter:
    """token bucket:每秒補 rate 個,最多存 rate 個(容許 1 秒的突發)。"""

    def __init__(self, rate: int, clock=time.monotonic) -> None:
        self.rate = float(rate)
        self.tokens = float(rate)
        self.clock = clock
        self.last = clock()
        self.lock = threading.Lock()

    def take(self, n: int = 1) -> int:
        """最多取 n 個,回傳實際取得的數量。"""
        with self.lock:
            now = self.clock()
            self.tokens = min(self.rate, self.tokens + (now - self.last) * self.rate)
            self.last = now
            got = min(n, int(self.tokens))
            self.tokens -= got
            return got

    def refund(self, n: int) -> None:
        with self.lock:
            self.tokens = min(self.rate, self.tokens + n)


class Pipeline:
    def __init__(self, store: RedisStore, status: Status, queue_size: int, max_rate: int, control: Control | None = None) -> None:
        self.store = store
        self.status = status
        # 測試區手動開關;接收的暫停狀態在每次心跳前讀(HEARTBEAT_SECONDS)
        self.control = control
        self.q: queue.Queue[tuple[str, dict[str, Any], float]] = queue.Queue(maxsize=queue_size)
        self.limiters = {"http": RateLimiter(max_rate), "syslog": RateLimiter(max_rate)}
        self.caps = {"http": queue_size, "syslog": int(queue_size * SYSLOG_QUEUE_SHARE)}
        self._warn = ThrottledLog(log)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="redis-writer", daemon=True)

    # ---------- 接收端點呼叫 ----------
    def submit(self, log_type: str, records: list[dict[str, Any]], source: str) -> int:
        """放進佇列;回傳接受的筆數(其餘因速率或佇列滿被丟棄)。source:http / syslog。"""
        if not records:
            return 0
        # 接收暫停(測試區手動開關):丟棄並計數 paused,回呼叫端 0 筆(HTTP 仍回 200,避免 PA 重送)
        if self.control and self.control.receive_paused:
            self.status.add("paused", len(records))
            return 0
        limiter = self.limiters[source]
        allowed = limiter.take(len(records))
        now = time.time()
        accepted = 0
        cap = self.caps[source]
        for rec in records[:allowed]:
            if self.q.qsize() >= cap:
                break
            try:
                self.q.put_nowait((log_type, rec, now))
            except queue.Full:
                break
            accepted += 1
        if accepted < allowed:
            limiter.refund(allowed - accepted)
        dropped = len(records) - accepted
        if accepted:
            self.status.add("received", accepted)
            self.status.ok(source)
        if dropped:
            self.status.add("dropped", dropped)
            self._warn.warning(f"drop:{source}", "丟棄 %d 筆 %s log(速率上限或佇列已滿)", dropped, log_type)
        return accepted

    # ---------- 寫入執行緒 ----------
    def start(self) -> None:
        self._thread.start()

    def alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self, timeout: float = 10.0) -> None:
        """停止並寫完佇列內剩下的 log。"""
        self._stop.set()
        self._thread.join(timeout)

    def _drain(self, deadline: float) -> list[tuple[str, dict[str, Any], float]]:
        batch: list[tuple[str, dict[str, Any], float]] = []
        while len(batch) < BATCH_MAX:
            remain = deadline - time.monotonic()
            try:
                batch.append(self.q.get(timeout=remain) if remain > 0 else self.q.get_nowait())
            except queue.Empty:
                break
        return batch

    def flush_once(self, seconds: float = BATCH_SECONDS) -> int:
        """寫一批;回傳寫入筆數(沒有資料或失敗為 0)。"""
        batch = self._drain(time.monotonic() + seconds)
        if not batch:
            return 0
        try:
            n = self.store.write_logs(batch)
            self.status.ok("redis")
            return n
        except Exception as e:  # noqa: BLE001 — Redis 任何錯誤都要記錄並繼續
            self.status.add("redisFailed", len(batch))
            self.status.fail("redis", e)
            self._warn.warning("redis", "寫入 Redis 失敗,丟棄 %d 筆:%s", len(batch), type(e).__name__)
            return 0

    def heartbeat(self) -> None:
        if self.control:
            self.control.refresh()
            # 總開關關閉時沒有接收端點,不標示暫停
            enabled = self.status.get("receiveEnabled") == "1"
            self.status.set(receivePaused="1" if enabled and self.control.receive_paused else "0")
        try:
            self.store.write_heartbeat(self.status.snapshot())
            # 心跳寫得進去就代表 Redis 已恢復(只輪詢、沒有 log 時也要清掉錯誤)
            self.status.ok("redis")
        except Exception as e:  # noqa: BLE001
            self.status.fail("redis", e)
            self._warn.warning("heartbeat", "寫入心跳失敗:%s", type(e).__name__)

    def _run(self) -> None:
        next_hb = 0.0
        while not self._stop.is_set():
            self.flush_once()
            if time.monotonic() >= next_hb:
                self.heartbeat()
                next_hb = time.monotonic() + HEARTBEAT_SECONDS
        # 結束前寫完佇列;Redis 失敗就不再嘗試(由 stop 的 timeout 控制上限)
        while not self.q.empty():
            if not self.flush_once(0):
                break
        self.heartbeat()
