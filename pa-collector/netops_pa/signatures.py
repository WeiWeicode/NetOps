"""PA 威脅特徵碼收集(TS-1;docs/THREAT-SIGNATURE-PLAN.md §3、§4.1、§5.4;TS-0 實測 2026-11-19)。

TS-0 實測結果:現有 API Key(Operational Requests)用唯讀 op 就能讀本機特徵庫與 vsys1 profile 設定,
不需要 XML API Configuration 權限(D22 不變)。本模組只送下列唯讀 op 指令(白名單,完全比對):
  show system resources                                    管理平面 CPU(送出前檢查,超過門檻不讀)
  show system info                                         內容版本(threat / app / av / wildfire)與發布時間
  show predefined xpath /predefined/threats/vulnerability  弱點特徵清單(約 2.5 萬筆)
  show predefined xpath /predefined/threats/phone-home     間諜軟體特徵清單(約 1 萬筆)
  show config running xpath <vsys1>/profile-group          vsys1 Profile Group(規則覆蓋用;shared 沒設定不讀)
  show config running xpath <vsys1>/profiles/{vulnerability,spyware}  vsys1 弱點防護 / 間諜軟體 profile 名稱
  show threat id <純數字 ID>                                抽屜按需單筆查詢(經收集器、CPU 保護、全系統每 10 秒 1 次)
不送 type=config、不 Commit、不改設定。

流程(SignatureWorker,單一執行緒):
  1. 每 PA_SIGNATURE_MINUTES 分鐘(預設 30)或手動請求時執行一次:
     - 測試區暫停輪詢(control.poll_paused)時不送
     - 管理平面 CPU 讀不到或超過門檻(E4:50%)不送,狀態標 rejected
     - 讀 show system info;只有 threat-version 變了、手動請求、或 Redis 沒快照時才讀全清單與 profile
     - 版本未變時只更新 meta 的版本時間(av / wildfire 等)並續期快照 TTL
     - 空清單、解析失敗、超過上限一律標 failed,保留上一份快照(AGENT.md §5)
  2. 同步消費 netops:pa:sig:lookup:jobs(抽屜按需單筆查詢):
     - 先查 1 天快取;未命中時檢查暫停、10 秒全域限流與 CPU,再執行 show threat id <ID>
API Key 只放 X-PAN-KEY 標頭(沿用 pa_query.XmlApi);錯誤訊息經 status.mask,日誌不記特徵內容。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import datetime
from typing import Any

import redis

from . import keys
from .config import SignatureConfig
from .pa_query import CPU_CMD, PaApiError, XmlApi
from .poller import parse_system
from .status import Status, iso, mask

log = logging.getLogger("netops_pa.signatures")

VSYS_XPATH = "devices/entry[@name='localhost.localdomain']/vsys/entry[@name='vsys1']"
INFO_CMD = "<show><system><info></info></system></show>"
VULN_CMD = "<show><predefined><xpath>/predefined/threats/vulnerability</xpath></predefined></show>"
SPYWARE_CMD = "<show><predefined><xpath>/predefined/threats/phone-home</xpath></predefined></show>"
PROFILE_GROUP_CMD = f"<show><config><running><xpath>{VSYS_XPATH}/profile-group</xpath></running></config></show>"
VP_PROFILES_CMD = f"<show><config><running><xpath>{VSYS_XPATH}/profiles/vulnerability</xpath></running></config></show>"
AS_PROFILES_CMD = f"<show><config><running><xpath>{VSYS_XPATH}/profiles/spyware</xpath></running></config></show>"

# 唯讀白名單(完全比對;D22)
ALLOWED_CMDS = frozenset({
    CPU_CMD,
    INFO_CMD,
    VULN_CMD,
    SPYWARE_CMD,
    PROFILE_GROUP_CMD,
    VP_PROFILES_CMD,
    AS_PROFILES_CMD,
})
# 抽屜按需單筆查詢:ID 只能是 1–10 位純數字(\A/\Z 避免換行字元繞過)
THREAT_ID_RE = re.compile(r"\A\d{1,10}\Z")
SHOW_THREAT_ID_RE = re.compile(r"\A<show><threat><id>\d{1,10}</id></threat></show>\Z")

# TS-0 實測弱點清單約 11.6 MB / 25,450 筆、間諜軟體約 2.5 MB / 9,566 筆;64 MB 上限同 scripts/ts0_probe.py
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_TEXT = 1024
MAX_LIST_ITEMS = 200
MAX_SIGNATURES = 100_000
MAX_PROFILES = 2000
# 失敗、被拒絕後多久重試;暫停中多久再看一次;手動重新整理收集器端最短間隔
RETRY_SEC = 300
PAUSED_RECHECK_SEC = 60
MIN_MANUAL_SEC = 60

PROFILE_GROUP_FIELDS: dict[str, str] = {
    "virus": "virus",
    "spyware": "spyware",
    "vulnerability": "vulnerability",
    "url-filtering": "urlFiltering",
    "file-blocking": "fileBlocking",
    "wildfire-analysis": "wildfireAnalysis",
    "data-filtering": "dataFiltering",
}

_PA_DATE_RE = re.compile(r"\A(\d{4})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z]+|[+-]\d{2}:?\d{2}))?\Z")


class TooLargeError(ValueError):
    """特徵或 profile 筆數超過上限(不寫出截斷的快照)。"""


def build_threat_id_cmd(threat_id: str) -> str:
    """組裝 show threat id <ID>;只接受 1–10 位純數字字串(不含空白或換行)。"""
    if not isinstance(threat_id, str) or not THREAT_ID_RE.match(threat_id):
        raise ValueError("特徵 ID 必須是 1–10 位純數字")
    return f"<show><threat><id>{threat_id}</id></threat></show>"


def is_allowed_cmd(cmd: str) -> bool:
    return cmd in ALLOWED_CMDS or bool(SHOW_THREAT_ID_RE.match(cmd))


class SignatureApi(XmlApi):
    """XmlApi 換成威脅特徵碼用的唯讀白名單(op 與 call 都檢查;回應上限 64 MB)。"""

    def __init__(self, cfg: SignatureConfig, *, use_http: bool = False, max_bytes: int = MAX_RESPONSE_BYTES) -> None:
        super().__init__(cfg, use_http=use_http, max_bytes=max_bytes)

    def call(self, params: dict[str, str], timeout: float | None = None) -> ET.Element:
        cmd = params.get("cmd", "")
        if params.get("type") != "op" or set(params) != {"type", "cmd"} or not is_allowed_cmd(cmd):
            raise ValueError("不在唯讀指令白名單內")
        return super().call(params, timeout)

    def op(self, cmd: str, timeout: float | None = None) -> ET.Element:
        return self.call({"type": "op", "cmd": cmd}, timeout)


# ---------- 解析與正規化(純函式) ----------
def _text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()[:MAX_TEXT]
    return s or None


def _parse_release_date(raw: str | None) -> str | None:
    """PA 發布時間(例 2026/11/17 05:46:29 CST)→ ISO 8601 含時區(AGENT.md §8);無法解析時保留原字串。"""
    s = _text(raw)
    if not s:
        return None
    m = _PA_DATE_RE.match(s)
    if not m:
        return s
    year, month, day, hour, minute, sec, tz = m.groups()
    try:
        datetime(int(year), int(month), int(day), int(hour), int(minute), int(sec))
    except ValueError:
        return s
    base = f"{year}-{month}-{day}T{hour}:{minute}:{sec}"
    if tz is None or tz.upper() == "CST":
        # PA-560 台灣時區(同 pa_query.PA_TZ = +08:00)
        return f"{base}+08:00"
    if tz.upper() in ("UTC", "GMT"):
        return f"{base}Z"
    if tz[0] in ("+", "-"):
        offset = tz if ":" in tz else f"{tz[:3]}:{tz[3:]}"
        return f"{base}{offset}"
    return s


def parse_system_info(root: ET.Element) -> dict[str, Any]:
    """show system info → 內容版本與發布時間(TS-0 實測欄位;AV / WildFire 只取版本與發布時間,TS-Q4)。"""
    sysel = root.find("./result/system")
    if sysel is None:
        return {
            "swVersion": None,
            "model": None,
            "threatVersion": None,
            "threatReleaseDate": None,
            "appVersion": None,
            "appReleaseDate": None,
            "avVersion": None,
            "avReleaseDate": None,
            "wildfireVersion": None,
            "wildfireReleaseDate": None,
            "urlFilteringVersion": None,
        }
    return {
        "swVersion": _text(sysel.findtext("sw-version")),
        "model": _text(sysel.findtext("model")),
        "threatVersion": _text(sysel.findtext("threat-version")),
        "threatReleaseDate": _parse_release_date(sysel.findtext("threat-release-date")),
        "appVersion": _text(sysel.findtext("app-version")),
        "appReleaseDate": _parse_release_date(sysel.findtext("app-release-date")),
        "avVersion": _text(sysel.findtext("av-version")),
        "avReleaseDate": _parse_release_date(sysel.findtext("av-release-date")),
        "wildfireVersion": _text(sysel.findtext("wildfire-version")),
        "wildfireReleaseDate": _parse_release_date(sysel.findtext("wildfire-release-date")),
        "urlFilteringVersion": _text(sysel.findtext("url-filtering-version")),
    }


def _parse_members(el: ET.Element | None) -> list[str]:
    """PAN-OS <member> 清單(例如 <cve><member>…</member></cve>、<vendor>、profile-group 欄位)。"""
    if el is None:
        return []
    members = el.findall("member")
    if members:
        if len(members) > MAX_LIST_ITEMS:
            raise TooLargeError(f"單一欄位超過 {MAX_LIST_ITEMS} 個成員")
        out = [v for v in (_text(m.text) for m in members) if v]
        return out
    children = list(el)
    if children:
        if len(children) > MAX_LIST_ITEMS:
            raise TooLargeError(f"單一欄位超過 {MAX_LIST_ITEMS} 個成員")
        return [v for v in (_text(c.text) or _text(c.tag) for c in children) if v]
    txt = _text(el.text)
    return [txt] if txt else []


def _parse_default_action(el: ET.Element | None) -> str | None:
    """<default-action> 的子節點名稱(例如 <reset-both/> → reset-both);沒有時 None。"""
    if el is None:
        return None
    child = next(iter(el), None)
    if child is not None:
        return _text(child.tag)
    return _text(el.text)


def _parse_affected_host(el: ET.Element | None) -> str | None:
    """<affected-host>:同時相容文字值(client / server)與子節點(<client>yes</client>、<server/>)。"""
    if el is None:
        return None
    children = list(el)
    if not children:
        return _text(el.text)
    members = el.findall("member")
    if members:
        vals = [v for v in (_text(m.text) for m in members) if v]
        return ",".join(vals)[:MAX_TEXT] or None
    active = [c.tag for c in children if (c.text or "").strip().lower() not in ("no", "false", "0")]
    if not active:
        return None
    if {"client", "server"} <= set(active):
        return "both"
    return ",".join(active)[:MAX_TEXT]


def _parse_disabled(el: ET.Element | None) -> bool:
    """<disable>:出現且不是 no / false 時視為預設停用(TS-0 實測只出現在停用的特徵)。"""
    if el is None:
        return False
    raw = (el.text or "").strip().lower()
    return raw not in ("no", "false", "0")


def _parse_time_attribute(el: ET.Element | None, depth: int = 0) -> dict[str, Any] | str | None:
    """<time-attribute>:保留原樣(有子節點轉為 dict,純文字轉為 str)。"""
    if el is None or depth > 4:
        return None
    children = list(el)
    if not children:
        return _text(el.text)
    out: dict[str, Any] = {}
    for c in children:
        out[c.tag] = _parse_time_attribute(c, depth + 1)
    return out or None


def _first_level_entries(root: ET.Element) -> list[ET.Element]:
    """取 <result> 下第一個有直接 <entry> 子節點的容器(同 scripts/ts0_probe.py,避免抓進巢狀 entry)。"""
    result = root.find("./result")
    if result is None:
        return []
    for el in result.iter():
        kids = el.findall("entry")
        if kids:
            return kids
    return []


def parse_signatures(root: ET.Element, kind: str) -> list[dict[str, Any]]:
    """show predefined xpath /predefined/threats/{vulnerability,phone-home} → 正規化清單(依數字 ID 排序)。"""
    if kind not in ("vulnerability", "spyware"):
        raise ValueError(f"不支援的特徵種類:{kind}")
    entries = _first_level_entries(root)
    if len(entries) > MAX_SIGNATURES:
        raise TooLargeError(f"{kind} 特徵超過 {MAX_SIGNATURES} 筆")
    by_id: dict[str, dict[str, Any]] = {}
    for e in entries:
        sig_id = (e.get("name") or "").strip()
        if not THREAT_ID_RE.match(sig_id):
            continue
        by_id[sig_id] = {
            "id": sig_id,
            "kind": kind,
            "name": _text(e.findtext("threatname")) or "",
            "severity": _text(e.findtext("severity")) or "",
            "category": _text(e.findtext("category")) or "",
            "affectedHost": _parse_affected_host(e.find("affected-host")),
            "engineVersion": _text(e.findtext("engine-version")),
            "defaultAction": _parse_default_action(e.find("default-action")),
            "cves": _parse_members(e.find("cve")),
            "vendorIds": _parse_members(e.find("vendor")),
            "disabled": _parse_disabled(e.find("disable")),
            "timeAttribute": _parse_time_attribute(e.find("time-attribute")),
        }
    return [by_id[k] for k in sorted(by_id, key=int)]


def parse_profile_groups(root: ET.Element) -> dict[str, dict[str, list[str]]]:
    """show config running xpath <vsys1>/profile-group → {群組名稱: {vulnerability: [...], spyware: [...], ...}}。"""
    pg = root.find("./result/profile-group")
    if pg is None:
        return {}
    entries = pg.findall("entry")
    if len(entries) > MAX_PROFILES:
        raise TooLargeError(f"profile-group 超過 {MAX_PROFILES} 個")
    out: dict[str, dict[str, list[str]]] = {}
    for e in entries:
        name = _text(e.get("name"))
        if not name:
            continue
        profiles: dict[str, list[str]] = {}
        for xml_tag, field in PROFILE_GROUP_FIELDS.items():
            vals = _parse_members(e.find(xml_tag))
            if vals:
                profiles[field] = vals
        out[name] = profiles
    return dict(sorted(out.items()))


def parse_profile_names(root: ET.Element, tag: str) -> list[str]:
    """show config running xpath <vsys1>/profiles/{vulnerability,spyware} → 只取第一層 profile 名稱(忽略巢狀 rule entry)。"""
    section = root.find(f"./result/{tag}")
    if section is None:
        return []
    entries = section.findall("entry")
    if len(entries) > MAX_PROFILES:
        raise TooLargeError(f"{tag} profile 超過 {MAX_PROFILES} 個")
    names = {n for n in (_text(e.get("name")) for e in entries) if n}
    return sorted(names)


def parse_threat_id(root: ET.Element, threat_id: str) -> dict[str, Any] | None:
    """show threat id <ID> → 單筆說明(TS-0 實測:entry name + subtype / severity / description)。查無回 None。"""
    result = root.find("./result")
    if result is None:
        return None
    entry = result.find("entry")
    if entry is None:
        entry = result.find(".//entry")
    if entry is None:
        return None
    name = _text(entry.get("name")) or _text(entry.findtext("threatname"))
    subtype = _text(entry.findtext("subtype"))
    severity = _text(entry.findtext("severity"))
    description = _text(entry.findtext("description"))
    if not any((name, subtype, severity, description)):
        return None
    return {
        "id": threat_id,
        "name": name or "",
        "subtype": subtype,
        "severity": severity,
        "description": description,
    }


def content_hash(vulnerability: list[dict[str, Any]], spyware: list[dict[str, Any]]) -> str:
    """弱點 + 間諜軟體特徵清單的內容雜湊(排序鍵、不含時間)。"""
    data = json.dumps({"vulnerability": vulnerability, "spyware": spyware}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


# ---------- 執行者 ----------
class SignatureWorker:
    def __init__(
        self,
        r: redis.Redis,
        api: SignatureApi,
        status: Status,
        interval_sec: int,
        max_mgmt_cpu: int,
        *,
        paused: Callable[[], bool] = lambda: False,
        clock: Callable[[], float] = time.monotonic,
        check_every: float = 1.0,
    ) -> None:
        self.r = r
        self.api = api
        self.status = status
        self.interval = interval_sec
        self.max_cpu = max_mgmt_cpu
        self.paused = paused
        self.clock = clock
        self.check_every = check_every
        self._next = 0.0  # 啟動後立即檢查一次
        self._last_run: float | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pa-signatures", daemon=True)

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
                self.run_one_lookup()
            except redis.RedisError as e:
                self.status.fail("signature", f"Redis:{type(e).__name__}")
            except Exception as e:  # noqa: BLE001 — 執行者不可因非預期錯誤結束
                log.error("威脅特徵碼收集發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
            self._stop.wait(self.check_every)

    def tick(self) -> str | None:
        """到期或有手動請求就執行一次;回傳結果狀態(沒有執行為 None)。
        手動請求距上次執行不到 MIN_MANUAL_SEC 時保留到可以執行(不消耗)。"""
        now = self.clock()
        if self.r.exists(keys.SIG_REFRESH) and (self._last_run is None or now - self._last_run >= MIN_MANUAL_SEC):
            manual = bool(self.r.getdel(keys.SIG_REFRESH))
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
        self.r.hset(keys.SIG_STATUS, mapping={"state": state, "message": mask(message), "lastRunAt": iso(), "mgmtCpu": "", **extra})

    def _load_existing_meta(self) -> dict[str, Any] | None:
        raw = self.r.get(keys.SIG_META)
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None

    def _optional_op(self, cmd: str) -> ET.Element | None:
        """讀取 vsys1 可選設定節點(No such node 視為空;其餘錯誤往上拋出)。"""
        try:
            return self.api.op(cmd)
        except PaApiError as e:
            if e.not_found:
                return None
            raise

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
            self._set_status("rejected", f"{msg},為保護設備本次不讀取特徵碼", trigger=trigger, mgmtCpu="" if cpu is None else str(cpu))
            return "rejected"

        t0 = time.monotonic()
        try:
            info = parse_system_info(self.api.op(INFO_CMD))
        except PaApiError as e:
            return self._fail(str(e), trigger, cpu)
        except Exception as e:  # noqa: BLE001 — 解析失敗也要標 failed
            return self._fail(f"解析 PA 系統資訊失敗:{type(e).__name__}", trigger, cpu)

        threat_version = info.get("threatVersion")
        if not threat_version:
            return self._fail("PA-560 系統資訊缺少 threat-version,保留上一份快照", trigger, cpu)

        existing_meta = self._load_existing_meta()
        has_snapshot = bool(
            existing_meta
            and isinstance(existing_meta.get("hash"), str)
            and isinstance(existing_meta.get("counts"), dict)
            and self.r.exists(keys.SIG_ITEMS_VULN)
            and self.r.exists(keys.SIG_ITEMS_SPYWARE)
            and self.r.exists(keys.SIG_PROFILES)
        )
        need_full = manual or not has_snapshot or existing_meta.get("threatVersion") != threat_version

        if not need_full and existing_meta is not None:
            now = iso()
            updated_meta = {
                **existing_meta,
                "checkedAt": now,
                "threatReleaseDate": info["threatReleaseDate"] or existing_meta.get("threatReleaseDate"),
                "appVersion": info["appVersion"],
                "appReleaseDate": info["appReleaseDate"],
                "avVersion": info["avVersion"],
                "avReleaseDate": info["avReleaseDate"],
                "wildfireVersion": info["wildfireVersion"],
                "wildfireReleaseDate": info["wildfireReleaseDate"],
                "urlFilteringVersion": info["urlFilteringVersion"],
            }
            counts = existing_meta["counts"]
            raw_total = counts.get("total", 0)
            total = raw_total if isinstance(raw_total, int) else 0
            with self.r.pipeline() as p:
                p.set(keys.SIG_META, json.dumps(updated_meta, ensure_ascii=False, separators=(",", ":")), ex=keys.SIG_TTL)
                p.expire(keys.SIG_ITEMS_VULN, keys.SIG_TTL)
                p.expire(keys.SIG_ITEMS_SPYWARE, keys.SIG_TTL)
                p.expire(keys.SIG_PROFILES, keys.SIG_TTL)
                p.hset(
                    keys.SIG_STATUS,
                    mapping={
                        "state": "ok",
                        "message": "",
                        "lastRunAt": now,
                        "lastOkAt": now,
                        "trigger": trigger,
                        "mgmtCpu": str(cpu),
                        "durationMs": str(int((time.monotonic() - t0) * 1000)),
                        "count": str(total),
                        "threatVersion": threat_version,
                        "hash": existing_meta["hash"],
                        "fullFetch": "0",
                    },
                )
                p.execute()
            self.status.ok("signature")
            return "ok"

        try:
            vuln_root = self.api.op(VULN_CMD)
            vuln = parse_signatures(vuln_root, "vulnerability")
            del vuln_root  # 立即釋放 XML 樹記憶體(弱點 XML 約 11.6 MB)
            if not vuln:
                return self._fail("PA-560 回傳的弱點特徵清單是空的,保留上一份快照", trigger, cpu)

            spy_root = self.api.op(SPYWARE_CMD)
            spyware = parse_signatures(spy_root, "spyware")
            del spy_root
            if not spyware:
                return self._fail("PA-560 回傳的間諜軟體特徵清單是空的,保留上一份快照", trigger, cpu)

            pg_root = self._optional_op(PROFILE_GROUP_CMD)
            profile_groups = parse_profile_groups(pg_root) if pg_root is not None else {}
            vp_root = self._optional_op(VP_PROFILES_CMD)
            vp_profiles = parse_profile_names(vp_root, "vulnerability") if vp_root is not None else []
            as_root = self._optional_op(AS_PROFILES_CMD)
            as_profiles = parse_profile_names(as_root, "spyware") if as_root is not None else []
        except PaApiError as e:
            return self._fail(str(e), trigger, cpu)
        except TooLargeError as e:
            return self._fail(f"{e},為避免不完整的資料本次不更新", trigger, cpu)
        except Exception as e:  # noqa: BLE001 — 解析失敗也要寫狀態,畫面才不會把舊快照當最新
            return self._fail(f"解析 PA 特徵碼回應失敗:{type(e).__name__}", trigger, cpu)

        now = iso()
        digest = content_hash(vuln, spyware)
        counts = {"vulnerability": len(vuln), "spyware": len(spyware), "total": len(vuln) + len(spyware)}
        baseline_at = (existing_meta.get("baselineAt") if isinstance(existing_meta, dict) else None) or now
        meta = {
            "fetchedAt": now,
            "checkedAt": now,
            "threatVersion": threat_version,
            "threatReleaseDate": info["threatReleaseDate"],
            "appVersion": info["appVersion"],
            "appReleaseDate": info["appReleaseDate"],
            "avVersion": info["avVersion"],
            "avReleaseDate": info["avReleaseDate"],
            "wildfireVersion": info["wildfireVersion"],
            "wildfireReleaseDate": info["wildfireReleaseDate"],
            "urlFilteringVersion": info["urlFilteringVersion"],
            "counts": counts,
            "hash": digest,
            "baselineAt": baseline_at,
        }
        profiles = {
            "fetchedAt": now,
            "vsys": "vsys1",
            "profileGroups": profile_groups,
            "vulnerabilityProfiles": vp_profiles,
            "spywareProfiles": as_profiles,
        }
        with self.r.pipeline() as p:
            p.set(keys.SIG_META, json.dumps(meta, ensure_ascii=False, separators=(",", ":")), ex=keys.SIG_TTL)
            p.set(keys.SIG_ITEMS_VULN, json.dumps(vuln, ensure_ascii=False, separators=(",", ":")), ex=keys.SIG_TTL)
            p.set(keys.SIG_ITEMS_SPYWARE, json.dumps(spyware, ensure_ascii=False, separators=(",", ":")), ex=keys.SIG_TTL)
            p.set(keys.SIG_PROFILES, json.dumps(profiles, ensure_ascii=False, separators=(",", ":")), ex=keys.SIG_TTL)
            p.hset(
                keys.SIG_STATUS,
                mapping={
                    "state": "ok",
                    "message": "",
                    "lastRunAt": now,
                    "lastOkAt": now,
                    "trigger": trigger,
                    "mgmtCpu": str(cpu),
                    "durationMs": str(int((time.monotonic() - t0) * 1000)),
                    "count": str(counts["total"]),
                    "threatVersion": threat_version,
                    "hash": digest,
                    "fullFetch": "1",
                },
            )
            p.execute()
        self.status.ok("signature")
        log.info("PA 威脅特徵碼已更新:版本 %s、弱點 %d 筆、間諜軟體 %d 筆(%s)", threat_version, len(vuln), len(spyware), trigger)
        return "ok"

    def run_one_lookup(self) -> str | None:
        """處理一筆抽屜按需查詢(show threat id <ID>);沒有工作回 None。"""
        raw_id = self.r.rpop(keys.SIG_LOOKUP_JOBS)
        if not raw_id:
            return None
        lookup_id = raw_id.decode() if isinstance(raw_id, bytes) else str(raw_id)
        jk = keys.sig_lookup_job(lookup_id)
        h = {k.decode(): v.decode() for k, v in self.r.hgetall(jk).items()}
        if h.get("status") != "queued":
            return lookup_id

        try:
            threat_id = h.get("threatId") or ""
            if not THREAT_ID_RE.match(threat_id):
                self.r.hset(
                    jk,
                    mapping={"status": "failed", "finishedAt": iso(), "error": "NETOPS_PA_SIGNATURE_INVALID", "message": "特徵 ID 格式不正確"},
                )
                return lookup_id

            # 快取命中時不碰 PA、不耗限流名額
            ck = keys.sig_lookup_cache(threat_id)
            cached_raw = self.r.get(ck)
            if cached_raw:
                try:
                    cached = json.loads(cached_raw)
                except ValueError:
                    cached = None
                if isinstance(cached, dict) and isinstance(cached.get("found"), bool):
                    now = iso()
                    if cached["found"] and isinstance(cached.get("item"), dict):
                        self.r.hset(
                            jk,
                            mapping={
                                "status": "done",
                                "finishedAt": now,
                                "cached": "1",
                                "result": json.dumps(cached["item"], ensure_ascii=False, separators=(",", ":")),
                            },
                        )
                    else:
                        self.r.hset(
                            jk,
                            mapping={
                                "status": "not_found",
                                "finishedAt": now,
                                "cached": "1",
                                "message": "本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)",
                            },
                        )
                    return lookup_id

            if self.paused():
                self.r.hset(
                    jk,
                    mapping={
                        "status": "rejected",
                        "finishedAt": iso(),
                        "error": "NETOPS_PA_SIGNATURE_PAUSED",
                        "message": "測試區已暫停輪詢 PA-560,無法按需查詢特徵碼",
                    },
                )
                return lookup_id

            # 全系統限流(每 10 秒 1 次,計畫 §5.4)
            if not self.r.set(keys.SIG_LOOKUP_COOL, "1", ex=keys.SIG_LOOKUP_COOL_SEC, nx=True):
                self.r.hset(
                    jk,
                    mapping={
                        "status": "rejected",
                        "finishedAt": iso(),
                        "error": "NETOPS_PA_SIGNATURE_COOLDOWN",
                        "message": "單筆特徵查詢限流中,請稍後再試",
                    },
                )
                return lookup_id

            self.r.hset(jk, mapping={"status": "running", "startedAt": iso()})
            try:
                cpu = parse_system(self.api.op(CPU_CMD))["mgmt"]
            except PaApiError:
                cpu = None
            if cpu is None:
                self.r.hset(
                    jk,
                    mapping={
                        "status": "rejected",
                        "finishedAt": iso(),
                        "error": "NETOPS_PA_SIGNATURE_CPU_UNKNOWN",
                        "message": "讀不到 PA-560 管理平面 CPU,為保護設備不送出查詢",
                    },
                )
                return lookup_id
            if cpu > self.max_cpu:
                self.r.hset(
                    jk,
                    mapping={
                        "status": "rejected",
                        "finishedAt": iso(),
                        "mgmtCpu": str(cpu),
                        "error": "NETOPS_PA_SIGNATURE_CPU_HIGH",
                        "message": f"PA-560 管理平面 CPU {cpu}% 超過 {self.max_cpu}%,為保護設備不送出查詢",
                    },
                )
                return lookup_id

            try:
                root = self.api.op(build_threat_id_cmd(threat_id))
                item = parse_threat_id(root, threat_id)
            except PaApiError as e:
                if e.not_found:
                    item = None
                else:
                    self.r.hset(
                        jk,
                        mapping={
                            "status": "failed",
                            "finishedAt": iso(),
                            "mgmtCpu": str(cpu),
                            "error": "NETOPS_PA_SIGNATURE_LOOKUP_FAILED",
                            "message": mask(str(e)),
                        },
                    )
                    log.warning("PA 單筆特徵碼查詢失敗(id=%s):%s", threat_id, mask(str(e)))
                    return lookup_id

            now = iso()
            if item is not None:
                self.r.set(ck, json.dumps({"found": True, "item": item, "checkedAt": now}, ensure_ascii=False, separators=(",", ":")),
                           ex=keys.SIG_LOOKUP_CACHE_TTL)
                self.r.hset(
                    jk,
                    mapping={
                        "status": "done",
                        "finishedAt": now,
                        "mgmtCpu": str(cpu),
                        "cached": "0",
                        "result": json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                    },
                )
            else:
                self.r.set(ck, json.dumps({"found": False, "checkedAt": now}, ensure_ascii=False, separators=(",", ":")),
                           ex=keys.SIG_LOOKUP_CACHE_TTL)
                self.r.hset(
                    jk,
                    mapping={
                        "status": "not_found",
                        "finishedAt": now,
                        "mgmtCpu": str(cpu),
                        "cached": "0",
                        "message": "本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)",
                    },
                )
        except Exception as e:  # noqa: BLE001 — 非預期錯誤也要讓工作結束成 failed
            self.r.hset(
                jk,
                mapping={
                    "status": "failed",
                    "finishedAt": iso(),
                    "error": "NETOPS_PA_SIGNATURE_LOOKUP_FAILED",
                    "message": "單筆特徵查詢發生非預期錯誤",
                },
            )
            log.error("PA 單筆特徵查詢發生非預期錯誤:%s", mask(f"{type(e).__name__}: {e}"))
        finally:
            self.r.expire(jk, keys.SIG_LOOKUP_JOB_TTL)
        return lookup_id

    def _fail(self, message: str, trigger: str, cpu: float | None = None) -> str:
        self._set_status("failed", message, trigger=trigger, mgmtCpu="" if cpu is None else str(cpu))
        self.status.fail("signature", message)
        log.warning("讀取 PA 威脅特徵碼失敗:%s", mask(message))
        return "failed"
