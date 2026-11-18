"""PA 安全規則收集(PR-1;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3、PR-0 實測 2026-11-18)。

PR-0 結果:現有 API Key(Operational Requests + Log)用 op 指令 `show config running xpath …` 就能讀規則與物件,
不需要 XML API Configuration 權限(D22 不變)。本模組只送下列唯讀 op 指令(白名單,完全比對):
  show system resources                                  管理平面 CPU(送出前檢查,超過門檻不讀)
  show config running xpath <vsys1>/rulebase/security    安全規則(依 PA 由上往下的順序)
  show config running xpath <vsys1>/{address, address-group, service, service-group, application-group, tag}
  show rule-hit-count vsys vsys1 rule-base security rules all
不送 type=config、不 Commit、不改設定。

流程(PolicyWorker,單一執行緒):每 PA_POLICY_MINUTES 分鐘(預設 30)或 netops-api 放進手動重新整理請求時執行一次:
  1. 測試區暫停輪詢(control.poll_paused)時不送
  2. 取樣管理平面 CPU,讀不到或超過門檻(E4:50%)不送,狀態標 rejected
  3. 讀規則、物件、命中數 → pan-os-python refreshall_from_xml 解析 → 正規化(position 1 起算 = PA GUI 編號)
  4. 規則 + 物件的內容雜湊(hash)寫進快照;命中數另存(每次都會變,不影響雜湊)
物件展開(群組 → 實際位址 / port)與版本歷史由 netops-api 處理(版本存 infra/store,Redis 只放最新快照)。
API Key 只放 X-PAN-KEY 標頭(沿用 pa_query.XmlApi);錯誤訊息經 status.mask,日誌不記規則內容。
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import redis
from panos.firewall import Firewall
from panos.objects import AddressGroup, AddressObject, ApplicationGroup, ServiceGroup, ServiceObject, Tag
from panos.policies import Rulebase, SecurityRule

from . import keys
from .pa_query import CPU_CMD, PaApiError, XmlApi
from .poller import parse_system
from .status import Status, iso, mask

log = logging.getLogger("netops_pa.policies")

VSYS_XPATH = "devices/entry[@name='localhost.localdomain']/vsys/entry[@name='vsys1']"
# 物件種類 → (xpath 結尾, pan-os-python 類別)
OBJECT_KINDS: dict[str, tuple[str, type]] = {
    "addresses": ("address", AddressObject),
    "addressGroups": ("address-group", AddressGroup),
    "services": ("service", ServiceObject),
    "serviceGroups": ("service-group", ServiceGroup),
    "applicationGroups": ("application-group", ApplicationGroup),
    "tags": ("tag", Tag),
}


def config_cmd(path: str) -> str:
    return f"<show><config><running><xpath>{VSYS_XPATH}/{path}</xpath></running></config></show>"


RULES_CMD = config_cmd("rulebase/security")
HITS_CMD = ("<show><rule-hit-count><vsys><vsys-name><entry name='vsys1'><rule-base><entry name='security'>"
            "<rules><all/></rules></entry></rule-base></entry></vsys-name></vsys></rule-hit-count></show>")
# 唯讀白名單(完全比對;D22)
ALLOWED_CMDS = frozenset({CPU_CMD, RULES_CMD, HITS_CMD, *(config_cmd(x) for x, _ in OBJECT_KINDS.values())})
# 解析用的 PAN-OS 版本(pan-os-python 依版本選欄位對應;PR-0 實機為 12.1.7,SDK 1.13.1 支援到的欄位與 11.x 相同)
PARSE_VERSION = (11, 1, 0)
# 單一欄位、陣列長度上限(防護;PA-560 實際 166 條規則、302 個位址物件)。
# 超過 MAX_ITEMS / MAX_RULES 時整次讀取標 failed,不寫出不完整的快照(AGENT.md §5);MAX_TEXT 同 PA 欄位本身的長度上限
MAX_TEXT = 1024
MAX_ITEMS = 2000
MAX_RULES = 5000
# 失敗、被拒絕(CPU 過高)後多久重試;暫停中多久再看一次
RETRY_SEC = 300
PAUSED_RECHECK_SEC = 60
# 手動重新整理在收集器端的最短間隔(netops-api 另有 5 分鐘冷卻;資安審查 M2:不只靠 netops-api)
MIN_MANUAL_SEC = 60


class TooLargeError(ValueError):
    """規則或物件數超過上限(不寫出截斷的快照)。"""


class PolicyApi(XmlApi):
    """XmlApi 換成安全規則用的唯讀白名單(其他 op 指令、type=log 一律拒絕;call 也檢查,資安審查 L4)。"""

    def call(self, params: dict[str, str], timeout: float | None = None) -> ET.Element:
        if params.get("type") != "op" or params.get("cmd") not in ALLOWED_CMDS or set(params) != {"type", "cmd"}:
            raise ValueError("不在唯讀指令白名單內")
        return super().call(params, timeout)

    def op(self, cmd: str, timeout: float | None = None) -> ET.Element:
        return self.call({"type": "op", "cmd": cmd}, timeout)


# ---------- 解析與正規化(純函式) ----------
def _firewall() -> Firewall:
    fw = Firewall()
    fw._version_info = PARSE_VERSION  # noqa: SLF001 — 離線解析:不連設備取版本
    fw.vsys = "vsys1"
    return fw


def _text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()[:MAX_TEXT]
    return s or None


def _list(v: Any) -> list[str]:
    if v is None:
        return []
    items = [v] if isinstance(v, str) else list(v)
    if len(items) > MAX_ITEMS:
        raise TooLargeError(f"單一欄位超過 {MAX_ITEMS} 個成員")
    return [s for s in (_text(x) for x in items) if s]


def _bool(v: Any) -> bool:
    return v is True or (isinstance(v, str) and v.lower() == "yes")


def _section(root: ET.Element, tag: str) -> ET.Element | None:
    """show config running 的回應:<result><tag>…</tag></result>;節點不存在(No such node / 空)回 None。"""
    return root.find(f"./result/{tag}")


PROFILE_FIELDS = ("virus", "spyware", "vulnerability", "url_filtering", "file_blocking", "wildfire_analysis", "data_filtering")
PROFILE_NAMES = {
    "url_filtering": "urlFiltering",
    "file_blocking": "fileBlocking",
    "wildfire_analysis": "wildfireAnalysis",
    "data_filtering": "dataFiltering",
}


def parse_rules(root: ET.Element) -> list[dict[str, Any]]:
    """安全規則 → 正規化(順序 = PA 比對順序,position 1 起算)。節點不存在回空陣列(呼叫端判斷要不要當失敗)。"""
    sec = _section(root, "security")
    rules_el = sec.find("rules") if sec is not None else None
    if rules_el is None:
        return []
    if len(rules_el.findall("entry")) > MAX_RULES:
        raise TooLargeError(f"安全規則超過 {MAX_RULES} 條")
    rb = Rulebase()
    _firewall().add(rb)
    proto = SecurityRule()
    rb.add(proto)
    out = []
    for i, r in enumerate(proto.refreshall_from_xml(rules_el, refresh_children=False), start=1):
        a = r.about()
        group = _list(a.get("group"))
        profiles = {PROFILE_NAMES.get(k, k): _list(a.get(k)) for k in PROFILE_FIELDS if a.get(k)}
        out.append({
            "position": i,
            "name": _text(a.get("name")) or "",
            "uuid": _text(a.get("uuid")),
            "type": _text(a.get("type")) or "universal",
            "tags": _list(a.get("tag")),
            "groupTag": _text(a.get("group_tag")),
            "fromZones": _list(a.get("fromzone")),
            "toZones": _list(a.get("tozone")),
            "sources": _list(a.get("source")),
            "sourceUsers": _list(a.get("source_user")),
            "sourceDevices": _list(a.get("source_devices")),
            "negateSource": _bool(a.get("negate_source")),
            "destinations": _list(a.get("destination")),
            "destinationDevices": _list(a.get("destination_devices")),
            "negateDestination": _bool(a.get("negate_destination")),
            "applications": _list(a.get("application")),
            "services": _list(a.get("service")),
            "categories": _list(a.get("category")),
            "action": _text(a.get("action")) or "",
            # Security Profile:群組(PR-0:測試區只用 group)或個別設定檔
            "profileGroup": group[0] if group else None,
            "profiles": profiles,
            "logStart": _bool(a.get("log_start")),
            "logEnd": _bool(a.get("log_end")),
            "logSetting": _text(a.get("log_setting")),
            "schedule": _text(a.get("schedule")),
            "disabled": _bool(a.get("disabled")),
            "description": _text(a.get("description")),
        })
    return out


def _parse_object(kind: str, a: dict[str, Any]) -> dict[str, Any]:
    name = _text(a.get("name")) or ""
    base = {"name": name, "description": _text(a.get("description")), "tags": _list(a.get("tag"))}
    if kind == "addresses":
        return {**base, "type": _text(a.get("type")) or "ip-netmask", "value": _text(a.get("value"))}
    if kind == "addressGroups":
        return {**base, "static": _list(a.get("static_value")), "dynamic": _text(a.get("dynamic_value"))}
    if kind == "services":
        return {**base, "protocol": _text(a.get("protocol")), "destinationPort": _text(a.get("destination_port")),
                "sourcePort": _text(a.get("source_port"))}
    if kind == "tags":
        return {"name": name, "color": _text(a.get("color")), "comments": _text(a.get("comments"))}
    # serviceGroups、applicationGroups
    return {"name": name, "members": _list(a.get("value"))}


def parse_objects(kind: str, root: ET.Element) -> list[dict[str, Any]]:
    tag, cls = OBJECT_KINDS[kind]
    el = _section(root, tag)
    if el is None:
        return []
    if len(el.findall("entry")) > MAX_ITEMS:
        raise TooLargeError(f"{tag} 物件超過 {MAX_ITEMS} 個")
    proto = cls()
    _firewall().add(proto)
    items = [_parse_object(kind, o.about()) for o in proto.refreshall_from_xml(el, refresh_children=False)]
    return sorted(items, key=lambda x: x["name"])


def _ts(v: str | None) -> str | None:
    """命中數的時間是 Unix 秒;0 或空 = 沒有(從未命中)。"""
    if not v or not v.strip().isdigit() or int(v) <= 0:
        return None
    return datetime.fromtimestamp(int(v), UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_hits(root: ET.Element) -> dict[str, dict[str, Any]]:
    """show rule-hit-count → {規則名稱: {hitCount, lastHit, firstHit, lastReset, created, modified}}。
    PR-0:比規則多 2 筆(intrazone-default / interzone-default 預設規則),一併保留。"""
    out: dict[str, dict[str, Any]] = {}
    entries = root.findall(".//rule-base/entry/rules/entry")
    if len(entries) > MAX_RULES + 10:
        raise TooLargeError(f"命中數超過 {MAX_RULES} 筆")
    for e in entries:
        name = _text(e.get("name"))
        if not name:
            continue
        hc = (e.findtext("hit-count") or "").strip()
        out[name] = {
            "hitCount": int(hc) if hc.isdigit() else None,
            "lastHit": _ts(e.findtext("last-hit-timestamp")),
            "firstHit": _ts(e.findtext("first-hit-timestamp")),
            "lastReset": _ts(e.findtext("last-reset-timestamp")),
            "created": _ts(e.findtext("rule-creation-timestamp")),
            "modified": _ts(e.findtext("rule-modification-timestamp")),
        }
    return out


def content_hash(rules: list[dict[str, Any]], objects: dict[str, list[dict[str, Any]]]) -> str:
    """規則 + 物件的內容雜湊(排序鍵、不含時間),變了才算新版本(netops-api 存版本歷史)。"""
    data = json.dumps({"rules": rules, "objects": objects}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


# ---------- 執行者 ----------
class PolicyWorker:
    def __init__(self, r: redis.Redis, api: PolicyApi, status: Status, interval_sec: int, max_mgmt_cpu: int, *,
                 paused: Callable[[], bool] = lambda: False, clock: Callable[[], float] = time.monotonic, check_every: float = 5.0) -> None:
        self.r = r
        self.api = api
        self.status = status
        self.interval = interval_sec
        self.max_cpu = max_mgmt_cpu
        self.paused = paused
        self.clock = clock
        self.check_every = check_every
        self._next = 0.0  # 啟動後立即讀一次
        self._last_run: float | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pa-policy", daemon=True)

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
                self.tick()
            except redis.RedisError as e:
                self.status.fail("policy", f"Redis:{type(e).__name__}")
            except Exception as e:  # noqa: BLE001 — 執行者不可因非預期錯誤結束
                log.error("安全規則收集發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
            self._stop.wait(self.check_every)

    def tick(self) -> str | None:
        """到期或有手動請求就執行一次;回傳結果狀態(沒有執行為 None)。
        成功後隔 interval;失敗 / 被拒絕 RETRY_SEC 後重試;暫停中 PAUSED_RECHECK_SEC 後再看(解除暫停很快就會讀)。
        手動請求距上次執行不到 MIN_MANUAL_SEC 時保留到可以執行(不消耗)。"""
        now = self.clock()
        if self.r.exists(keys.POLICY_REFRESH) and (self._last_run is None or now - self._last_run >= MIN_MANUAL_SEC):
            manual = bool(self.r.getdel(keys.POLICY_REFRESH))
        else:
            manual = False
        if not manual and now < self._next:
            return None
        result = self.run_once(manual=manual)
        if result != "paused":
            self._last_run = now
        delay = {"ok": self.interval, "paused": PAUSED_RECHECK_SEC}.get(result, min(self.interval, RETRY_SEC))
        self._next = now + delay
        return result

    def _set_status(self, state: str, message: str, **extra: str) -> None:
        # message 一律遮罩(PaApiError 目前不含原文,日後改動時也不外洩;資安審查參考項)
        self.r.hset(keys.POLICY_STATUS, mapping={"state": state, "message": mask(message), "lastRunAt": iso(), "mgmtCpu": "", **extra})

    def run_once(self, manual: bool = False) -> str:
        trigger = "manual" if manual else "schedule"
        if self.paused():
            self._set_status("paused", "測試區已暫停輪詢 PA-560,本次沒有讀取", trigger=trigger)
            return "paused"
        try:
            cpu = parse_system(self.api.op(CPU_CMD))["mgmt"]
        except PaApiError as e:
            return self._fail(str(e), trigger)
        if cpu is None or cpu > self.max_cpu:
            msg = "讀不到 PA-560 管理平面 CPU" if cpu is None else f"PA-560 管理平面 CPU {cpu}% 超過 {self.max_cpu}%"
            self._set_status("rejected", f"{msg},為保護設備本次不讀取規則", trigger=trigger, mgmtCpu="" if cpu is None else str(cpu))
            return "rejected"
        t0 = time.monotonic()
        try:
            rules = parse_rules(self.api.op(RULES_CMD))
            # 規則是空的:PA 回成功但沒有內容(帳號範圍變了等)不當成「規則全被刪除」,保留上一份快照(AGENT.md §5)
            if not rules:
                return self._fail("PA-560 回傳的安全規則是空的,保留上一份快照", trigger, cpu)
            objects = {k: parse_objects(k, self.api.op(config_cmd(x))) for k, (x, _) in OBJECT_KINDS.items()}
            hits = parse_hits(self.api.op(HITS_CMD))
        except PaApiError as e:
            return self._fail(str(e), trigger, cpu)
        except TooLargeError as e:
            return self._fail(f"{e},為避免不完整的資料本次不更新", trigger, cpu)
        except Exception as e:  # noqa: BLE001 — 解析失敗也要寫狀態,畫面才不會把舊快照當成最新(審查 #1)
            return self._fail(f"解析 PA 回應失敗:{type(e).__name__}", trigger, cpu)
        now = iso()
        digest = content_hash(rules, objects)
        snapshot = {"fetchedAt": now, "hash": digest, "vsys": "vsys1", "rules": rules, "objects": objects}
        with self.r.pipeline() as p:
            p.set(keys.POLICY_SNAPSHOT, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), ex=keys.POLICY_TTL)
            p.set(keys.POLICY_HITS, json.dumps({"fetchedAt": now, "items": hits}, ensure_ascii=False, separators=(",", ":")), ex=keys.POLICY_TTL)
            p.hset(keys.POLICY_STATUS, mapping={"state": "ok", "message": "", "lastRunAt": now, "lastOkAt": now, "trigger": trigger,
                                                "mgmtCpu": str(cpu), "durationMs": str(int((time.monotonic() - t0) * 1000)),
                                                "ruleCount": str(len(rules)), "hash": digest})
            p.execute()
        self.status.ok("policy")
        log.info("PA 安全規則已更新:%d 條(%s)", len(rules), trigger)
        return "ok"

    def _fail(self, message: str, trigger: str, cpu: float | None = None) -> str:
        self._set_status("failed", message, trigger=trigger, mgmtCpu="" if cpu is None else str(cpu))
        self.status.fail("policy", message)
        log.warning("讀取 PA 安全規則失敗:%s", mask(message))
        return "failed"
