"""Redis 鍵格式與保留時間(PA-LIVE-PLAN §4、ARCHITECTURE D21)。

鍵格式只在這裡定義;Node 端 backend/src/infra/redis/ 有同一份規則,兩邊要一起改,改之前先回報需求方。
分鐘桶一律用 UTC 的 yyyyMMddHHmm(收集器收到 log 的時間),不用 log 自己的時間欄位:
log 時間可能延遲或格式錯誤,用收到的時間才能保證修剪與 TTL 正確。
"""

from __future__ import annotations

from datetime import UTC, datetime

PREFIX = "netops:pa"

# log 類型(PA-LIVE-PLAN §4);traffic 經 Syslog,其他經 HTTP(P7 定案)
LOG_TYPES = ("traffic", "threat", "url", "wildfire", "data", "decryption", "globalprotect", "userid")
HTTP_TYPES = tuple(t for t in LOG_TYPES if t != "traffic")

# 快照指標
METRICS = ("session", "cpu", "throughput", "interfaces")

HOUR = 3600
DAY = 24 * HOUR

# 保留時間(秒),2026-11-04 需求方決定:TRAFFIC 明細 1 小時、統計 1 天;其他類型明細與統計 2 天
LOG_RETENTION = {t: (HOUR if t == "traffic" else 2 * DAY) for t in LOG_TYPES}
AGG_RETENTION = {t: (DAY if t == "traffic" else 2 * DAY) for t in LOG_TYPES}
SERIES_RETENTION = 2 * DAY
# Stream 筆數上限(防護用,正常量遠低於此;每筆約 300 bytes,合計最壞約 1.5 GB < maxmemory 2 GB):
#   TRAFFIC 1 小時:平均每秒 90–130 筆(PA-LIVE-PLAN §5),上限約每秒 400 筆;其他類型 2 天各 50 萬筆
LOG_MAXLEN = {t: (1_500_000 if t == "traffic" else 500_000) for t in LOG_TYPES}
# 快照 60 秒過期:過期即視為「停止更新」,畫面不把舊快照當即時資料(PA-LIVE-PLAN §3.1)
SNAP_TTL = 60


def minute_bucket(ts: float) -> str:
    """Unix 秒 → UTC yyyyMMddHHmm。"""
    return datetime.fromtimestamp(ts, UTC).strftime("%Y%m%d%H%M")


def snap(metric: str) -> str:
    return f"{PREFIX}:snap:{metric}"


def series(metric: str) -> str:
    return f"{PREFIX}:series:{metric}"


def log_stream(log_type: str) -> str:
    return f"{PREFIX}:log:{log_type}"


def agg(log_type: str, bucket: str) -> str:
    return f"{PREFIX}:agg:{log_type}:{bucket}"


def top(log_type: str, dim: str, bucket: str) -> str:
    return f"{PREFIX}:top:{log_type}:{dim}:{bucket}"


HEARTBEAT = f"{PREFIX}:heartbeat"
