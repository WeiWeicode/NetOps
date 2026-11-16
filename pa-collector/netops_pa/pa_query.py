"""PA 精準查詢執行者(C5;docs/PA-LOG-CLICKHOUSE-GUIDE.md §9、ARCHITECTURE D31、IMPL-PLAN C0 E4 結果)。

netops-api 驗證、冷卻後把工作放進 Redis(keys.PAQ_*);這裡一次只執行一個:
  log      XML API type=log(TRAFFIC / 威脅),單一 IP、時間視窗 ≤ 15 分鐘且結束在 1 小時內、nlogs ≤ 500
  session  Session Browser:show session all filter source|destination <IP>(唯讀 op),最多回 500 筆
每個工作:
  1. 確認全系統名額(keys.PAQ_ACTIVE)還是這個工作(逾時被收回就不執行)
  2. 參數再驗一次(netops-api 驗過,這裡不信任 Redis 的內容)
  3. 送出前取樣管理平面 CPU(show system resources),超過門檻(E4:50%)不送,工作標 rejected
  4. 執行;log 工作每 2 秒起、逐次加到 5 秒輪詢 action=get,整個工作 60 秒內;逾時或失敗時送 action=finish 取消 PA 上的工作
  5. 結果寫回 job Hash(TTL 10 分鐘)、釋放名額、設全域間隔 10 秒

API Key 只放在 X-PAN-KEY 標頭(不進 URL、不進 POST 內容);錯誤訊息一律經 status.mask,日誌只記錯誤類型與分類過的訊息。
本模組只送下列唯讀請求(D22):type=log(查詢、get、finish)與 type=op 的 show system resources、show session all filter。
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import redis

from . import keys
from .config import QueryConfig
from .poller import parse_system
from .status import Status, iso, mask

log = logging.getLogger("netops_pa.pa_query")

# PA-560 的 receive_time 是設備本地時間(台灣,沒有日光節約;固定 +08:00,不依賴容器的 tzdata)
PA_TZ = timezone(timedelta(hours=8))
MAX_WINDOW = timedelta(minutes=15)
MAX_AGE = timedelta(hours=1)
MAX_NLOGS = 500
MAX_SESSIONS = 500
LOG_TYPES = ("traffic", "threat")
DIRECTIONS = {"src": "source", "dst": "destination"}
JOB_TIMEOUT = 60.0
MAX_FIELD = 512
CPU_CMD = "<show><system><resources></resources></system></show>"
# Session Browser 指令的完整格式(白名單;資安審查 C5 L2)
_SESSION_CMD = re.compile(r"^<show><session><all><filter><(source|destination)>[0-9a-fA-F:.]{2,45}</\1></filter></all></session></show>$")
# call() 只接受這些請求(type、action);其他一律拒絕
_ALLOWED_CALLS = {("log", None), ("log", "get"), ("log", "finish"), ("op", None)}
# 結果寫進 Redis 的總長度上限(500 筆實際約數百 KB;資安審查 L4)
MAX_RESULT_BYTES = 2 * 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟隨轉址:urllib 跟隨 3xx 時會把 X-PAN-KEY 帶到新網址(資安審查 C5 M1)"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


def release_slot(r: redis.Redis, job_id: str) -> None:
    """名額還是這個工作才刪(逾時後已被別的工作拿走就不動);WATCH / MULTI,不用 Lua。"""
    with r.pipeline() as p:
        try:
            p.watch(keys.PAQ_ACTIVE)
            if p.get(keys.PAQ_ACTIVE) == job_id.encode():
                p.multi()
                p.delete(keys.PAQ_ACTIVE)
                p.execute()
            else:
                p.unwatch()
        except redis.WatchError:
            pass


class PaApiError(Exception):
    """PA XML API 失敗;message 已遮罩、只有分類過的內容。"""


class JobError(Exception):
    """工作失敗:code 給 netops-api 原樣回給畫面(NETOPS_ 開頭)。"""

    def __init__(self, code: str, message: str, status: str = "failed") -> None:
        super().__init__(message)
        self.code = code
        self.status = status


# ---------- 參數驗證與查詢組字(純函式) ----------
def _ip(v: Any) -> str:
    """單一 IPv4 / IPv6(不接受 CIDR、萬用字元與 scope id);回傳正規化的文字。"""
    if not isinstance(v, str) or len(v) > 45 or "%" in v:
        raise JobError("NETOPS_PA_QUERY_INVALID", "IP 格式不正確")
    try:
        addr = ipaddress.ip_address(v.strip())
    except ValueError:
        raise JobError("NETOPS_PA_QUERY_INVALID", "IP 格式不正確") from None
    mapped = getattr(addr, "ipv4_mapped", None)
    return str(mapped or addr)


def _time(v: Any) -> datetime:
    if not isinstance(v, str):
        raise JobError("NETOPS_PA_QUERY_INVALID", "時間格式不正確")
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        raise JobError("NETOPS_PA_QUERY_INVALID", "時間格式不正確") from None
    if dt.tzinfo is None:
        raise JobError("NETOPS_PA_QUERY_INVALID", "時間缺少時區")
    return dt


@dataclass(frozen=True)
class LogQuery:
    log_type: str
    query: str
    nlogs: int


def build_log_query(p: dict[str, Any], now: datetime | None = None) -> LogQuery:
    """log 工作:只用驗證過的值組 PA 查詢語法(不接受使用者自訂 filter)。"""
    if p.get("logType") not in LOG_TYPES:
        raise JobError("NETOPS_PA_QUERY_INVALID", "log 類型只能是 traffic 或 threat")
    ip = _ip(p.get("ip"))
    start, end = _time(p.get("from")), _time(p.get("to"))
    now = now or datetime.now(UTC)
    if not (timedelta(0) < end - start <= MAX_WINDOW):
        raise JobError("NETOPS_PA_QUERY_INVALID", "時間視窗要大於 0、不超過 15 分鐘")
    if end < now - MAX_AGE or end > now + timedelta(minutes=1):
        raise JobError("NETOPS_PA_QUERY_INVALID", "結束時間要在最近 1 小時內")
    nlogs = p.get("nlogs", MAX_NLOGS)
    if not isinstance(nlogs, int) or isinstance(nlogs, bool) or not 1 <= nlogs <= MAX_NLOGS:
        raise JobError("NETOPS_PA_QUERY_INVALID", f"筆數要在 1–{MAX_NLOGS}")
    fmt = "%Y/%m/%d %H:%M:%S"
    s, e = start.astimezone(PA_TZ).strftime(fmt), end.astimezone(PA_TZ).strftime(fmt)
    return LogQuery(p["logType"], f"( addr in {ip} ) and ( receive_time geq '{s}' ) and ( receive_time leq '{e}' )", nlogs)


def build_session_cmd(p: dict[str, Any]) -> str:
    """session 工作:show session all filter source|destination <IP>(cmd XML 只由驗證過的值組成)。"""
    d = DIRECTIONS.get(p.get("direction", "src"))
    if d is None:
        raise JobError("NETOPS_PA_QUERY_INVALID", "方向只能是 src 或 dst")
    return f"<show><session><all><filter><{d}>{_ip(p.get('ip'))}</{d}></filter></all></session></show>"


# ---------- XML → 紀錄(純函式) ----------
# PA type=log 回應的欄位 → Log 明細的欄位名稱(同 backend/src/modules/pa/core/palog.js ROW_FIELDS)
LOG_FIELDS = {
    "receive_time": "time", "subtype": "subtype", "action": "action", "src": "src", "sport": "sport", "dst": "dst", "dport": "dport",
    "proto": "proto", "app": "app", "rule": "rule", "from": "fromZone", "to": "toZone", "srcuser": "srcUser", "natsrc": "natSrc",
    "natdst": "natDst", "bytes": "bytes", "bytes_sent": "sent", "bytes_received": "recv", "packets": "packets", "elapsed": "elapsed",
    "session_end_reason": "endReason", "category": "category", "srcloc": "srcCountry", "dstloc": "dstCountry", "threatid": "threat",
    "severity": "severity", "misc": "url", "direction": "direction", "repeatcnt": "repeat",
}
SESSION_FIELDS = {
    "idx": "id", "application": "app", "state": "state", "type": "type", "source": "src", "sport": "sport", "dst": "dst", "dport": "dport",
    "proto": "proto", "from": "fromZone", "to": "toZone", "start-time": "startTime", "total-byte-count": "bytes", "security-rule": "rule",
    "xsource": "natSrc", "xdst": "natDst", "xsport": "natSport", "xdport": "natDport", "srcuser": "srcUser",
}
NUMERIC = {"sport", "dport", "bytes", "sent", "recv", "packets", "elapsed", "repeat", "natSport", "natDport"}


def _entry(e: ET.Element, fields: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for tag, name in fields.items():
        v = (e.findtext(tag) or "").strip()[:MAX_FIELD]
        out[name] = int(v) if name in NUMERIC and v.isdigit() else v
    return out


def parse_logs(root: ET.Element, limit: int = MAX_NLOGS) -> list[dict[str, Any]]:
    return [_entry(e, LOG_FIELDS) for e in root.findall("./result/log/logs/entry")[:limit]]


def parse_sessions(root: ET.Element, limit: int = MAX_SESSIONS) -> tuple[list[dict[str, Any]], bool]:
    entries = root.findall("./result/entry")
    return [_entry(e, SESSION_FIELDS) for e in entries[:limit]], len(entries) > limit


# ---------- PA XML API(最小用戶端) ----------
class XmlApi:
    """POST https://host:port/api/,API Key 放 X-PAN-KEY 標頭;HTTPS 憑證預設驗證(同 poller.SdkClient)。"""

    def __init__(self, cfg: QueryConfig, *, use_http: bool = False) -> None:
        scheme = "http" if use_http else "https"  # use_http 只給測試的假 PA
        self.url = f"{scheme}://{cfg.host}:{cfg.port}/api/"
        self.key = cfg.api_key
        self.timeout = cfg.timeout
        if use_http:
            self.ctx = None
        elif cfg.tls_insecure:
            self.ctx = ssl.create_default_context()
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE
        else:
            self.ctx = ssl.create_default_context(cafile=cfg.ca_file or None)
        handlers: list[urllib.request.BaseHandler] = [_NoRedirect()]
        if self.ctx is not None:
            handlers.append(urllib.request.HTTPSHandler(context=self.ctx))
        self._open = urllib.request.build_opener(*handlers).open

    def call(self, params: dict[str, str], timeout: float | None = None) -> ET.Element:
        if (params.get("type"), params.get("action")) not in _ALLOWED_CALLS:
            raise ValueError("不在唯讀請求白名單內")
        body = urllib.parse.urlencode(params).encode()
        headers = {"X-PAN-KEY": self.key, "Content-Type": "application/x-www-form-urlencoded"}
        req = urllib.request.Request(self.url, data=body, method="POST", headers=headers)  # noqa: S310 — 位址只從設定讀
        try:
            with self._open(req, timeout=timeout or self.timeout) as res:
                raw = res.read(8 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as e:
            # 3xx 也在這裡(不跟隨轉址)
            raise PaApiError(f"PA 回應 HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as e:
            raise PaApiError(f"連不到 PA-560:{type(getattr(e, 'reason', e)).__name__}") from None
        if len(raw) > 8 * 1024 * 1024:
            raise PaApiError("PA 回應過大")
        try:
            root = ET.fromstring(raw)  # noqa: S314 — PA-560 管理介面(設定的主機)的回應
        except ET.ParseError:
            raise PaApiError("PA 回應不是 XML") from None
        if root.get("status") != "success":
            # 畫面只顯示分類與 PA 的錯誤代碼;PA 原文只寫日誌(遮罩後;資安審查 L3)
            code = root.get("code", "")
            detail = " ".join(t.strip() for t in root.itertext() if t.strip())[:200]
            log.warning("PA 回應錯誤 code=%s:%s", code or "-", mask(detail))
            raise PaApiError(f"PA-560 回應錯誤{f'(code {code})' if code.isdigit() else ''}")
        return root

    def op(self, cmd: str, timeout: float | None = None) -> ET.Element:
        if cmd != CPU_CMD and not _SESSION_CMD.match(cmd):
            raise ValueError("不在唯讀指令白名單內")
        return self.call({"type": "op", "cmd": cmd}, timeout)


# ---------- 執行者 ----------
class QueryWorker:
    def __init__(self, r: redis.Redis, api: XmlApi, status: Status, max_mgmt_cpu: int, *, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep, now: Callable[[], datetime] | None = None) -> None:
        self.r = r
        self.api = api
        self.status = status
        self.max_cpu = max_mgmt_cpu
        self.clock = clock
        self.sleep = sleep
        self.now = now or (lambda: datetime.now(UTC))
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pa-query", daemon=True)

    def alive(self) -> bool:
        return self._thread.is_alive()

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(10)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                # BRPOP 等待要小於 Redis socket_timeout(store.connect:5 秒)
                self.run_one(block=3)
            except redis.RedisError as e:
                self.status.fail("query", f"Redis:{type(e).__name__}")
                self._stop.wait(5)
            except Exception as e:  # noqa: BLE001 — 執行者不可因非預期錯誤結束
                log.error("PA 查詢執行者發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
                self._stop.wait(5)

    def run_one(self, block: int = 0) -> str | None:
        """取一個工作執行;回傳工作 id(沒有工作為 None)。block:BRPOP 等待秒數(0 = 不等)。"""
        item = self.r.brpop([keys.PAQ_JOBS], timeout=block) if block else self.r.rpop(keys.PAQ_JOBS)
        if not item:
            return None
        job_id = (item[1] if isinstance(item, (list, tuple)) else item).decode()
        jk = keys.paq_job(job_id)
        h = {k.decode(): v.decode() for k, v in self.r.hgetall(jk).items()}
        if h.get("status") != "queued":
            return job_id
        sent = False  # 真的送過 PA 請求才設全域間隔(過期、參數不合法的工作不擋別人)
        try:
            active = self.r.get(keys.PAQ_ACTIVE)
            if active is None or active.decode() != job_id:
                raise JobError("NETOPS_PA_QUERY_EXPIRED", "等候太久,查詢名額已收回,請重新送出")
            # 全域間隔在執行者端也強制(名額過期時 netops-api 可能已接受下一個工作;程式碼審查 C5 #5)
            gap = self.r.pttl(keys.PAQ_COOL_GLOBAL)
            if gap and gap > 0:
                self.sleep(gap / 1000)
            # 名額續到工作上限之後(從送出起算的 90 秒在最壞情況餘裕不足;#6)
            self.r.expire(keys.PAQ_ACTIVE, int(JOB_TIMEOUT) + 30)
            try:
                params = json.loads(h.get("params") or "{}")
            except ValueError:
                params = None
            if not isinstance(params, dict):
                raise JobError("NETOPS_PA_QUERY_INVALID", "查詢參數損壞")
            kind = h.get("kind")
            # 先驗參數(不合法就不碰 PA)
            if kind == "log":
                q = build_log_query(params, self.now())
            elif kind == "session":
                cmd = build_session_cmd(params)
            else:
                raise JobError("NETOPS_PA_QUERY_INVALID", "不支援的查詢類型")
            self.r.hset(jk, mapping={"status": "running", "startedAt": iso()})
            deadline = self.clock() + JOB_TIMEOUT
            sent = True
            cpu = self.mgmt_cpu()
            if cpu is None:
                raise JobError("NETOPS_PA_QUERY_CPU_UNKNOWN", "讀不到 PA-560 管理平面 CPU,為保護設備不送出查詢", "rejected")
            if cpu > self.max_cpu:
                msg = f"PA-560 管理平面 CPU {cpu}% 超過 {self.max_cpu}%,為保護設備不送出查詢,請稍後再試"
                raise JobError("NETOPS_PA_QUERY_CPU_HIGH", msg, "rejected")
            if kind == "log":
                rows = self.run_log(q, deadline)
                truncated = len(rows) >= q.nlogs
            else:
                rows, truncated = parse_sessions(self.api.op(cmd, timeout=max(1.0, deadline - self.clock())))
            data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
            while len(data.encode()) > MAX_RESULT_BYTES and rows:
                rows = rows[: len(rows) // 2]
                truncated = True
                data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
            self.r.hset(jk, mapping={"status": "done", "finishedAt": iso(), "mgmtCpu": str(cpu), "count": str(len(rows)),
                                     "truncated": "1" if truncated else "0", "result": data})
            self.status.ok("query")
        except JobError as e:
            self.r.hset(jk, mapping={"status": e.status, "finishedAt": iso(), "error": e.code, "message": str(e)})
            if e.status == "failed":
                log.warning("PA 查詢失敗:%s", e.code)
            # 為保護設備沒送出:不扣使用者的 60 秒冷卻(#9)
            if e.status == "rejected" and h.get("emp"):
                self.r.delete(f"{keys.PAQ_PREFIX}:cool:{h['emp']}")
        except PaApiError as e:
            self.r.hset(jk, mapping={"status": "failed", "finishedAt": iso(), "error": "NETOPS_PA_QUERY_FAILED", "message": str(e)})
            self.status.fail("query", e)
            log.warning("PA 查詢失敗:%s", e)
        except Exception as e:  # noqa: BLE001 — 非預期錯誤也要讓工作結束成 failed,不能停在 queued / running(#2)
            self.r.hset(jk, mapping={"status": "failed", "finishedAt": iso(), "error": "NETOPS_PA_QUERY_FAILED", "message": "PA 查詢發生非預期錯誤"})
            log.error("PA 查詢發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
        finally:
            self.r.expire(jk, keys.PAQ_JOB_TTL)
            release_slot(self.r, job_id)
            if sent:
                self.r.set(keys.PAQ_COOL_GLOBAL, "1", ex=keys.PAQ_COOL_GLOBAL_SEC)
        return job_id

    def mgmt_cpu(self) -> float | None:
        try:
            return parse_system(self.api.op(CPU_CMD))["mgmt"]
        except PaApiError:
            return None

    def run_log(self, q: LogQuery, deadline: float) -> list[dict[str, Any]]:
        root = self.api.call({"type": "log", "log-type": q.log_type, "nlogs": str(q.nlogs), "query": q.query})
        job = (root.findtext("./result/job") or "").strip()
        if not job.isdigit():
            raise PaApiError("PA 沒有回傳 log 工作編號")
        interval = 2.0
        try:
            while True:
                left = deadline - self.clock()
                if left <= 0:
                    raise JobError("NETOPS_PA_QUERY_TIMEOUT", f"PA-560 超過 {int(JOB_TIMEOUT)} 秒沒有完成,已取消查詢")
                self.sleep(min(interval, left))
                res = self.api.call({"type": "log", "action": "get", "job-id": job}, timeout=max(1.0, min(self.api.timeout, deadline - self.clock())))
                if (res.findtext("./result/job/status") or "").strip() == "FIN":
                    return parse_logs(res, q.nlogs)
                interval = min(interval + 1.0, 5.0)
        except BaseException:
            # 逾時或失敗:取消 PA 上的工作(不讓管理平面繼續搜尋);取消失敗只記錄
            try:
                self.api.call({"type": "log", "action": "finish", "job-id": job}, timeout=5)
            except PaApiError as e:
                log.warning("取消 PA log 工作失敗:%s", e)
            raise
