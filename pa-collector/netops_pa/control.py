"""測試區手動開關(2026-11-09 需求方決定「在測試區我想要有按鈕可以停用或開啟」;PA-LIVE-PLAN §4、§3.4)。

- 環境變數 PA_POLL_ENABLED / PA_RECEIVE_ENABLED 是總開關:決定這個功能能不能開(關閉時不開 port、不建立輪詢)。
- 畫面按鈕只切換執行中的「暫停 / 繼續」,狀態存在 Redis netops:pa:control(netops-api 寫入,這裡只讀)。
- 只在非正式區生效(GW_ENV=test;dev 為本機開發);正式區一律不讀這個鍵,永遠視為「繼續」。
- 讀取失敗(Redis 暫時連不上)時保留上一次的狀態,不因 Redis 抖動切換。
- 輪詢:每次輪詢前讀(poll_paused);接收:寫入執行緒每 5 秒(心跳時)讀一次(refresh),暫停時丟棄收到的 log 並計數 paused。
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .status import ThrottledLog

log = logging.getLogger("netops_pa.control")


def _one_line(v: str) -> str:
    """寫日誌前去掉換行與控制字元(值來自 Redis)。"""
    return "".join(ch if ch.isprintable() else " " for ch in v)[:40]


class Control:
    def __init__(self, read: Callable[[], dict[str, str]], enabled: bool) -> None:
        self._read = read
        self.enabled = enabled
        # (輪詢暫停, 接收暫停):輪詢執行緒與寫入執行緒都會 refresh,存成一個 tuple 一次換掉
        self._state = (False, False)
        self._warn = ThrottledLog(log)

    def refresh(self) -> None:
        """讀 Redis 的開關;正式區或讀取失敗時不變。"""
        if not self.enabled:
            return
        try:
            c = self._read()
        except Exception as e:  # noqa: BLE001 — Redis 任何錯誤都保留上一次的狀態
            self._warn.warning("control", "讀取收集器開關失敗,沿用上一次的狀態:%s", type(e).__name__)
            return
        poll, receive = c.get("pollPaused") == "1", c.get("receivePaused") == "1"
        if (poll, receive) != self._state:
            log.info("收集器開關:輪詢%s、接收%s(%s 於 %s 設定)", "暫停" if poll else "繼續", "暫停" if receive else "繼續",
                     _one_line(c.get("updatedBy", "?")), _one_line(c.get("updatedAt", "?")))
        self._state = (poll, receive)

    def poll_paused(self) -> bool:
        """輪詢前呼叫:重新讀取後回傳是否暫停。"""
        self.refresh()
        return self._state[0]

    @property
    def receive_paused(self) -> bool:
        return self._state[1]
