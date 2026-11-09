"""程序內的狀態(各執行緒更新,心跳寫進 Redis netops:pa:heartbeat)與日誌遮罩 / 限頻。"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import UTC, datetime

# 錯誤訊息遮罩:API Key(URL 參數 key=…、X-PAN-KEY 標頭)、Token 與密碼不可出現在日誌或心跳(PA-LIVE-PLAN §9)
_SECRET = re.compile(r"(?i)(key|token|password|passwd)(=|%3D|['\"]?\s*:\s*['\"]?)[^&\s'\",}]+")
# 已知的機密值(啟動時登記):不論以什麼格式出現都整串取代
_KNOWN: list[str] = []


def register_secret(value: str) -> None:
    if value and len(value) >= 8 and value not in _KNOWN:
        _KNOWN.append(value)


def mask(msg: str) -> str:
    for v in _KNOWN:
        msg = msg.replace(v, "***")
    return _SECRET.sub(r"\1\2***", msg)[:300]


def iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class ThrottledLog:
    """同一種警告每 interval 秒最多記一次,期間被略過的次數併在下一次輸出(防止被灌爆日誌)。"""

    def __init__(self, logger: logging.Logger, interval: float = 60.0, clock=time.monotonic) -> None:
        self.log = logger
        self.interval = interval
        self.clock = clock
        self._last: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def warning(self, kind: str, msg: str, *args: object) -> None:
        now = self.clock()
        with self._lock:
            last, skipped = self._last.get(kind, (-1e18, 0))
            if now - last < self.interval:
                self._last[kind] = (last, skipped + 1)
                return
            self._last[kind] = (now, 0)
        if skipped:
            msg += f"(前 {self.interval:.0f} 秒內另有 {skipped} 次未記錄)"
        self.log.warning(msg, *args)


class Status:
    """心跳欄位(全部字串)。計數為程序啟動後累計。"""

    # paused:接收暫停(測試區手動開關,control.py)期間丟棄的筆數
    COUNTERS = ("received", "dropped", "rejected", "malformed", "redisFailed", "paused")

    def __init__(self, version: str, gw_env: str, poll_enabled: bool, receive_enabled: bool, **extra: str) -> None:
        self._lock = threading.Lock()
        self._fields: dict[str, str] = {
            "version": version,
            "env": gw_env,
            "startedAt": iso(),
            "pollEnabled": "1" if poll_enabled else "0",
            "receiveEnabled": "1" if receive_enabled else "0",
            # 實際的暫停狀態(測試區手動開關,control.py);總開關關閉時一律 0
            "pollPaused": "0",
            "receivePaused": "0",
            **extra,
        }
        self._counts = dict.fromkeys(self.COUNTERS, 0)

    def set(self, **fields: str) -> None:
        with self._lock:
            self._fields.update(fields)

    def clear(self, *names: str) -> None:
        with self._lock:
            for n in names:
                self._fields.pop(n, None)

    def add(self, counter: str, n: int = 1) -> None:
        with self._lock:
            self._counts[counter] += n

    def ok(self, prefix: str) -> None:
        """某項工作成功:記時間、清掉該項的錯誤。"""
        with self._lock:
            self._fields[f"{prefix}OkAt"] = iso()
            self._fields.pop(f"{prefix}Error", None)
            self._fields.pop(f"{prefix}ErrorAt", None)

    def fail(self, prefix: str, err: BaseException | str) -> None:
        self.set(**{f"{prefix}ErrorAt": iso(), f"{prefix}Error": mask(str(err) or type(err).__name__)})

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            out = dict(self._fields)
            out.update({k: str(v) for k, v in self._counts.items()})
        out["updatedAt"] = iso()
        return out

    def get(self, name: str) -> str | None:
        with self._lock:
            return self._fields.get(name)
