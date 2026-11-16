"""log 欄位與每分鐘統計的定義(PA-LIVE-PLAN §4)。

欄位 key 沿用舊版:TRAFFIC 對應 server/lib/palog.js 的 COLUMNS,其他類型對應 server/lib/paevents.js
(THREAT_COLUMNS 與 decryption / globalprotect / userid 的 columns)。不新增欄位;PA-560 轉送格式
(docs/PA-FORWARDING-SPEC.md)直接輸出這些 key。不在清單內的 key 一律丟掉,不寫進 Redis。

例外(2026-11-10 核准,ARCHITECTURE D28、PA-LOG-CLICKHOUSE-GUIDE §12 CQ9):TRAFFIC 與威脅類(threat、url、data、
wildfire)加 `seqno`(PA 的 Sequence Number)與 `sessionId`(Session ID),給 netops-ingest 寫進 ClickHouse,FTP 補漏時逐筆去重。
seqno 是 64 位元無號整數(實測 19 位數),超過 JavaScript 的安全整數,所以**存成數字字串**(netops-ingest 原樣寫進 UInt64)。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# 每個欄位值的長度上限(字元);超過截斷。url / description 等較長
DEFAULT_MAX_LEN = 128
LONG_FIELDS = {"url": 512, "description": 512, "error": 256, "name": 200, "sni": 256}
# 統計的值(Hash 欄位名稱、Sorted Set 成員)長度上限
DIM_MAX_LEN = 120

TRAFFIC_FIELDS = (
    "time", "type", "subtype", "src", "dst", "natSrc", "natDst", "rule", "srcUser", "app", "fromZone", "toZone",
    "inIf", "outIf", "sport", "dport", "natDport", "proto", "action", "bytes", "sent", "recv", "packets", "start",
    "elapsed", "category", "srcCountry", "dstCountry", "endReason", "appRisk", "appCategory", "appSubcat", "appTech",
    "srcHost", "dstHost",
    # CQ9 例外(見檔頭)
    "seqno", "sessionId",
)
THREAT_FIELDS = (
    "time", "subtype", "src", "dst", "natSrc", "natDst", "rule", "srcUser", "app", "fromZone", "toZone",
    "sport", "dport", "natDport", "proto", "action", "url", "name", "category", "severity", "direction",
    "srcCountry", "dstCountry", "repeat", "thrCategory", "filedigest", "filetype",
    # CQ9 例外(見檔頭)
    "seqno", "sessionId",
)
DECRYPTION_FIELDS = (
    "time", "src", "dst", "rule", "app", "dport", "action", "error", "errIndex", "status", "tls", "proxyType",
    "policy", "sni", "repeat",
)
GLOBALPROTECT_FIELDS = (
    "time", "eventId", "stage", "auth", "user", "region", "machine", "publicIp", "privateIp", "clientVer", "os",
    "error", "description", "status", "portal", "repeat",
)
USERID_FIELDS = ("time", "subtype", "ip", "user", "dataSourceType", "dataSource", "repeat")

# 舊版 palog.js NUMERIC 與 paevents.js 的 numeric(repeat)
NUMERIC = {"bytes", "sent", "recv", "packets", "elapsed", "sport", "dport", "natDport", "appRisk", "repeat", "sessionId"}
# 64 位元無號整數,存成數字字串(見檔頭);不合法時不寫這個 key(ClickHouse 端預設 0)
UINT64_TEXT = {"seqno"}
_UINT64_MAX = 2**64 - 1


def _host(url: str) -> str:
    """URL 的主機名稱(同舊版 paevents.js hostOf)。"""
    for sep in ("/", "?"):
        url = url.split(sep, 1)[0]
    return url


def _port(r: dict[str, Any]) -> str:
    """proto/dport,例如 tcp/443(同舊版 dims 的 Port)。"""
    proto, dport = r.get("proto", ""), r.get("dport", 0)
    return f"{proto}/{dport}" if dport else str(proto)


Dim = Callable[[dict[str, Any]], Any]


@dataclass(frozen=True)
class LogType:
    fields: tuple[str, ...]
    # 每分鐘 Hash 的計數欄位:{名稱: 取值},存成「名稱:值」→ 次數(數量少的列舉)
    kpis: dict[str, Dim] = field(default_factory=dict)
    # 每分鐘排行 Sorted Set:{維度: 取值},成員為值、分數為次數
    tops: dict[str, Dim] = field(default_factory=dict)
    # 依位元組排行(只有 TRAFFIC)
    byte_tops: dict[str, Dim] = field(default_factory=dict)


def _f(name: str) -> Dim:
    return lambda r: r.get(name, "")


_THREAT_LIKE_TOPS = {"name": _f("name"), "src": _f("src"), "dst": _f("dst"), "app": _f("app"), "rule": _f("rule")}

TYPES: dict[str, LogType] = {
    "traffic": LogType(
        TRAFFIC_FIELDS,
        kpis={"action": _f("action"), "proto": _f("proto")},
        tops={"src": _f("src"), "dst": _f("dst"), "app": _f("app"), "rule": _f("rule"), "port": _port},
        byte_tops={"srcBytes": _f("src"), "dstBytes": _f("dst"), "appBytes": _f("app")},
    ),
    "threat": LogType(
        THREAT_FIELDS,
        kpis={"action": _f("action"), "severity": _f("severity"), "subtype": _f("subtype")},
        tops=_THREAT_LIKE_TOPS,
    ),
    "url": LogType(
        THREAT_FIELDS,
        kpis={"action": _f("action"), "category": _f("category")},
        tops={"host": lambda r: _host(str(r.get("url", ""))), "category": _f("category"), "src": _f("src"),
              "user": _f("srcUser"), "app": _f("app")},
    ),
    "data": LogType(
        THREAT_FIELDS,
        kpis={"action": _f("action"), "subtype": _f("subtype"), "direction": _f("direction")},
        tops={"name": _f("name"), "src": _f("src"), "app": _f("app"), "filetype": _f("filetype"), "user": _f("srcUser")},
    ),
    "wildfire": LogType(
        THREAT_FIELDS,
        # 舊版 wildfire 的「判定」放在 category
        kpis={"verdict": _f("category"), "action": _f("action")},
        tops={"src": _f("src"), "dst": _f("dst"), "filetype": _f("filetype"), "app": _f("app")},
    ),
    "decryption": LogType(
        DECRYPTION_FIELDS,
        kpis={"status": _f("status"), "errIndex": _f("errIndex"), "tls": _f("tls")},
        tops={"error": _f("error"), "src": _f("src"), "dst": _f("dst"), "sni": _f("sni"), "app": _f("app")},
    ),
    "globalprotect": LogType(
        GLOBALPROTECT_FIELDS,
        kpis={"status": _f("status"), "eventId": _f("eventId")},
        tops={"user": _f("user"), "publicIp": lambda r: "" if r.get("publicIp") == "0.0.0.0" else r.get("publicIp", ""),  # noqa: S104 — 比對值,不是監聽
              "region": _f("region")},
    ),
    "userid": LogType(
        USERID_FIELDS,
        kpis={"subtype": _f("subtype")},
        tops={"user": _f("user"), "ip": _f("ip")},
    ),
}


def _clean(v: Any, limit: int) -> str:
    """轉成字串、去掉控制字元(換行、tab 等)並截斷。"""
    s = v if isinstance(v, str) else ("" if v is None else str(v))
    if any(ord(c) < 32 or ord(c) == 127 for c in s):
        s = "".join(" " if (ord(c) < 32 or ord(c) == 127) else c for c in s)
    return s.strip()[:limit]


def _num(v: Any) -> int:
    """數字欄位:不是非負整數就當 0(同舊版 Number(v) || 0,但不接受小數與負數)。"""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return v if 0 <= v < 2**63 else 0
    s = str(v).strip()
    return int(s) if s.isdigit() and len(s) <= 18 else 0


def _uint64_text(v: Any) -> str | None:
    """seqno:十進位非負整數且 ≤ 2^64-1 → 去掉前導 0 的字串;其他回 None。"""
    if isinstance(v, bool):
        return None
    s = str(v).strip() if isinstance(v, (str, int)) else ""
    if not s.isascii() or not s.isdigit() or len(s) > 20:
        return None
    n = int(s)
    return str(n) if n <= _UINT64_MAX else None


def normalize(log_type: str, raw: Any) -> dict[str, Any] | None:
    """轉送來的一筆 → 只含已知欄位的紀錄;不是物件或沒有任何已知欄位時回 None(呼叫端計為畸形)。"""
    if not isinstance(raw, dict):
        return None
    t = TYPES[log_type]
    out: dict[str, Any] = {}
    for k in t.fields:
        if k not in raw:
            continue
        if k in NUMERIC:
            out[k] = _num(raw[k])
        elif k in UINT64_TEXT:
            u = _uint64_text(raw[k])
            if u is not None:
                out[k] = u
        else:
            v = _clean(raw[k], LONG_FIELDS.get(k, DEFAULT_MAX_LEN))
            if v:
                out[k] = v
    return out or None


def dim_value(v: Any) -> str:
    """統計用的值:空字串不計;截斷長度。"""
    return _clean(v, DIM_MAX_LEN)


def weight(log_type: str, r: dict[str, Any]) -> int:
    """次數權重:TRAFFIC 一筆算 1;其他類型乘 Repeat Count(同舊版,PA 會把重複事件合併成一筆)。"""
    if log_type == "traffic":
        return 1
    rep = r.get("repeat", 0)
    return rep if isinstance(rep, int) and 0 < rep <= 1_000_000 else 1
