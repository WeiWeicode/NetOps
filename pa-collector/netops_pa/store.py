"""寫入 netops-redis(PA-LIVE-PLAN §4)。所有鍵由 keys.py 產生,這裡不自行組鍵。

一批 log 用一個 pipeline 寫完:每種類型 XADD 到 Stream、每分鐘 Hash 計數、每分鐘排行 Sorted Set。
同一批內先在記憶體加總,減少 Redis 指令數(TRAFFIC 平均每秒約 100 筆)。

保留與記憶體上限(D21;Redis 是 noeviction,滿了整個即時監控停擺,所以每一種資料都要有上限):
- Stream:每批以 XTRIM MINID 精確修剪到保留時間;另以 MAXLEN(近似)限制筆數(keys.LOG_MAXLEN),
  防止異常大量時超過記憶體;並設 EXPIRE(保留時間 + 1 分鐘),某類型停止轉送後舊明細也會過期。
- 每分鐘 Hash:每個計數項目(action、severity…)每分鐘最多 KPI_MAX_VALUES 種值,其餘併入「(其他)」。
- 排行:分鐘進行中先限制在 5N(控制記憶體),分鐘結束後修剪到 N。
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

import redis

from . import keys
from .records import TYPES, dim_value, weight

# 分鐘進行中排行最多保留 N 的幾倍(之後修剪到 N)
_LIVE_TOP_FACTOR = 5
# 每分鐘 Hash 的每個計數項目最多幾種值(正常的列舉都在 20 種以內)
KPI_MAX_VALUES = 50
KPI_OTHER = "(其他)"


def connect(url: str) -> redis.Redis:
    # 逾時要短:Redis 卡住時寫入執行緒不能無限等待,失敗會記在心跳
    return redis.Redis.from_url(url, socket_timeout=5, socket_connect_timeout=5, health_check_interval=30)


def _json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


class RedisStore:
    def __init__(self, client: redis.Redis, top_n: int) -> None:
        self.r = client
        self.top_n = top_n
        # 已寫過、還沒修剪到 N 的排行鍵:{bucket: {key}}
        self._pending_top: dict[str, set[str]] = defaultdict(set)
        # 每分鐘 Hash 已出現的計數值:{hash 鍵: {項目: {值}}}(只保留最近幾分鐘)
        self._kpi_seen: dict[str, dict[str, set[str]]] = {}

    def _kpi_field(self, hk: str, name: str, value: str) -> str:
        seen = self._kpi_seen.setdefault(hk, {}).setdefault(name, set())
        if value not in seen:
            if len(seen) >= KPI_MAX_VALUES:
                return f"{name}:{KPI_OTHER}"
            seen.add(value)
        return f"{name}:{value}"

    # ---------- log ----------
    def write_logs(self, batch: Iterable[tuple[str, dict[str, Any], float]]) -> int:
        """batch:(類型, 紀錄, 收到的 Unix 秒)。回傳寫入筆數。Redis 失敗時拋出例外(呼叫端記錄)。"""
        streams: dict[str, list[str]] = defaultdict(list)
        hashes: dict[str, Counter[str]] = defaultdict(Counter)
        tops: dict[str, Counter[str]] = defaultdict(Counter)
        ttl: dict[str, int] = {}
        newest: dict[str, float] = {}
        touched_top: dict[str, set[str]] = defaultdict(set)
        n = 0
        for log_type, rec, ts in batch:
            t = TYPES[log_type]
            n += 1
            streams[log_type].append(_json(rec))
            newest[log_type] = max(newest.get(log_type, 0.0), ts)
            bucket = keys.minute_bucket(ts)
            w = weight(log_type, rec)
            hk = keys.agg(log_type, bucket)
            ttl[hk] = keys.AGG_RETENTION[log_type] + 60
            h = hashes[hk]
            h["count"] += w
            if log_type == "traffic":
                h["bytes"] += rec.get("bytes", 0)
                h["packets"] += rec.get("packets", 0)
            for name, fn in t.kpis.items():
                v = dim_value(fn(rec))
                if v:
                    h[self._kpi_field(hk, name, v)] += w
            for dims, use_bytes in ((t.tops, False), (t.byte_tops, True)):
                for dim, fn in dims.items():
                    v = dim_value(fn(rec))
                    amount = rec.get("bytes", 0) if use_bytes else w
                    if v and amount:
                        tk = keys.top(log_type, dim, bucket)
                        tops[tk][v] += amount
                        ttl[tk] = ttl[hk]
                        touched_top[bucket].add(tk)
        if not n:
            return 0

        p = self.r.pipeline(transaction=False)
        for log_type, items in streams.items():
            sk = keys.log_stream(log_type)
            for d in items:
                p.xadd(sk, {"d": d}, maxlen=keys.LOG_MAXLEN[log_type], approximate=True)
            # Stream ID 是毫秒時間:比保留時間舊的精確修剪(每批一次,刪除量即過期的筆數)
            p.xtrim(sk, minid=int((newest[log_type] - keys.LOG_RETENTION[log_type]) * 1000), approximate=False)
            p.expire(sk, keys.LOG_RETENTION[log_type] + 60)
        for hk, c in hashes.items():
            for f, v in c.items():
                p.hincrby(hk, f, v)
            p.expire(hk, ttl[hk])
        live_cap = self.top_n * _LIVE_TOP_FACTOR
        for tk, c in tops.items():
            for m, v in c.items():
                p.zincrby(tk, v, m)
            p.expire(tk, ttl[tk])
            p.zremrangebyrank(tk, 0, -(live_cap + 1))
        # 已經過去的分鐘:修剪到前 N 名(遲到的批次會再寫入那一分鐘,下次照樣修剪)
        current = max(keys.minute_bucket(ts) for ts in newest.values())
        for b, ks in touched_top.items():
            self._pending_top[b] |= ks
        done = [b for b in self._pending_top if b < current]
        for b in done:
            for tk in self._pending_top[b]:
                p.zremrangebyrank(tk, 0, -(self.top_n + 1))
        p.execute()
        # 寫入成功才移除待修剪清單(失敗時下一批再修剪)
        for b in done:
            self._pending_top.pop(b, None)
        # 只保留最近 3 分鐘的計數值紀錄
        for hk in [k for k in self._kpi_seen if k.rsplit(":", 1)[-1] < keys.minute_bucket(max(newest.values()) - 180)]:
            del self._kpi_seen[hk]
        return n

    # ---------- 設備快照 ----------
    def write_snapshot(self, metric: str, data: dict[str, Any], ts: float) -> None:
        """最新快照(60 秒 TTL)+ 趨勢 Stream(2 天;停止輪詢後也會過期)。"""
        d = _json(data)
        sk = keys.series(metric)
        p = self.r.pipeline(transaction=False)
        p.set(keys.snap(metric), d, ex=keys.SNAP_TTL)
        p.xadd(sk, {"d": d})
        p.xtrim(sk, minid=int((ts - keys.SERIES_RETENTION) * 1000), approximate=False)
        p.expire(sk, keys.SERIES_RETENTION + 60)
        p.execute()

    # ---------- 心跳 ----------
    def write_heartbeat(self, fields: dict[str, str]) -> None:
        """整個 Hash 換新(清掉已恢復的錯誤欄位)。不設 TTL:收集器停止時 updatedAt 停在最後時間,由 netops-api 判斷。"""
        p = self.r.pipeline(transaction=True)
        p.delete(keys.HEARTBEAT)
        p.hset(keys.HEARTBEAT, mapping=fields)
        p.execute()
