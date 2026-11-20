"""PA 威脅特徵碼收集(TS-1):版本檢查、全清單正規化、vsys1 profile、唯讀白名單、CPU 門檻、暫停、
手動重新整理、失敗保留快照、按需單筆查詢與 Key 不外洩。"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.config import ConfigError, SignatureConfig, load_config
from netops_pa.pa_query import CPU_CMD
from netops_pa.signatures import (
    ALLOWED_CMDS,
    AS_PROFILES_CMD,
    INFO_CMD,
    MAX_TEXT,
    PROFILE_GROUP_CMD,
    SPYWARE_CMD,
    VP_PROFILES_CMD,
    VULN_CMD,
    SignatureApi,
    SignatureWorker,
    build_threat_id_cmd,
    content_hash,
    parse_profile_groups,
    parse_profile_names,
    parse_signatures,
    parse_system_info,
    parse_threat_id,
)
from netops_pa.status import Status, register_secret
from tests.fake_pa import (
    AS_PROFILES_VSYS,
    NO_SUCH_NODE,
    PREDEFINED_PHONE_HOME,
    PREDEFINED_VULNERABILITY,
    PROFILE_GROUP_VSYS,
    SHOW_THREAT_ID_FOUND,
    SYSTEM_INFO_SIG,
    VP_PROFILES_VSYS,
    FakePa,
)

KEY = "secret-signature-key-0123456789"


@pytest.fixture
def pa():
    with FakePa(api_key=KEY, require_header_key=True) as p:
        yield p


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def make(pa: FakePa, key: str = KEY, paused: bool = False, max_bytes: int | None = None):
    cfg = SignatureConfig(
        host="127.0.0.1",
        port=pa.port,
        api_key=key,
        ca_file="",
        tls_insecure=False,
        timeout=5,
        interval=1800,
        max_mgmt_cpu=50,
    )
    r = fakeredis.FakeRedis()
    clock = Clock()
    api = SignatureApi(cfg, use_http=True) if max_bytes is None else SignatureApi(cfg, use_http=True, max_bytes=max_bytes)
    w = SignatureWorker(r, api, Status("t", "test", False, False), 1800, 50, paused=lambda: paused, clock=clock)
    return w, r, clock


def status(r: fakeredis.FakeRedis) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in r.hgetall(keys.SIG_STATUS).items()}


def enqueue_lookup(r: fakeredis.FakeRedis, threat_id: str, lookup_id: str = "lookup-1") -> str:
    r.hset(keys.sig_lookup_job(lookup_id), mapping={"status": "queued", "threatId": threat_id, "emp": "S112009"})
    r.lpush(keys.SIG_LOOKUP_JOBS, lookup_id)
    return lookup_id


def read_lookup(r: fakeredis.FakeRedis, lookup_id: str) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in r.hgetall(keys.sig_lookup_job(lookup_id)).items()}


def test_parse_system_info_and_dates():
    xml = SYSTEM_INFO_SIG.format(
        threat_version="9173-10354",
        threat_release_date="2026/11/17 05:46:29 CST",
        app_version="9173-10354",
        app_release_date="2026/11/17 05:46:29 UTC",
        av_version="5749-6277",
        av_release_date="2026/11/18 20:00:27 CST",
        wildfire_version="1136765-1141451",
        wildfire_release_date="2026/11/19 14:57:18 CST",
    )
    info = parse_system_info(ET.fromstring(xml))
    assert info["threatVersion"] == "9173-10354"
    assert info["threatReleaseDate"] == "2026-11-17T05:46:29+08:00"
    assert info["appReleaseDate"] == "2026-11-17T05:46:29Z"
    assert info["avVersion"] == "5749-6277" and info["avReleaseDate"] == "2026-11-18T20:00:27+08:00"
    assert info["wildfireVersion"] == "1136765-1141451" and info["wildfireReleaseDate"] == "2026-11-19T14:57:18+08:00"
    assert info["urlFilteringVersion"] == "20261006.20097"
    assert parse_system_info(ET.fromstring('<response status="success"><result/></response>'))["threatVersion"] is None


def test_parse_signatures_vulnerability_and_spyware():
    vulns = parse_signatures(ET.fromstring(PREDEFINED_VULNERABILITY), "vulnerability")
    # 依數字 ID 排序
    assert [v["id"] for v in vulns] == ["30000", "547000"]
    v30 = vulns[0]
    assert v30["kind"] == "vulnerability"
    assert v30["name"] == "Legacy SMB Info Leak"
    assert v30["affectedHost"] == "client"
    assert v30["defaultAction"] is None
    assert v30["cves"] == [] and v30["vendorIds"] == []
    assert v30["disabled"] is True
    assert v30["timeAttribute"] is None

    v547 = vulns[1]
    assert v547["severity"] == "critical" and v547["category"] == "code-execution"
    assert v547["affectedHost"] == "server"
    assert v547["engineVersion"] == "8.0"
    assert v547["defaultAction"] == "reset-both"
    assert v547["cves"] == ["CVE-2026-1001", "CVE-2026-1002"]
    assert v547["vendorIds"] == ["MS26-001"]
    assert v547["disabled"] is False
    assert v547["timeAttribute"] == {"threshold": "5", "track-by": "source", "interval": "60"}

    spy = parse_signatures(ET.fromstring(PREDEFINED_PHONE_HOME), "spyware")
    assert [s["id"] for s in spy] == ["10001", "87187"]
    assert spy[0]["kind"] == "spyware" and spy[0]["cves"] == [] and spy[0]["affectedHost"] is None
    assert spy[0]["defaultAction"] == "reset-both" and spy[0]["disabled"] is False
    assert spy[1]["defaultAction"] == "alert" and spy[1]["disabled"] is True

    # 超長文字截斷 MAX_TEXT、非數字 ID 略過、affected-host client+server → both、disable=no → False
    edge = ET.fromstring(
        f'<response status="success"><result><vulnerability>'
        f'<entry name="not-num"><threatname>skip</threatname></entry>'
        f'<entry name="999"><threatname>{"A" * (MAX_TEXT + 50)}</threatname><severity>low</severity>'
        f"<category>x</category><affected-host><client>yes</client><server>yes</server></affected-host>"
        f"<disable>no</disable></entry></vulnerability></result></response>"
    )
    parsed = parse_signatures(edge, "vulnerability")
    assert len(parsed) == 1 and parsed[0]["id"] == "999"
    assert len(parsed[0]["name"]) == MAX_TEXT
    assert parsed[0]["affectedHost"] == "both" and parsed[0]["disabled"] is False


def test_parse_profiles_vsys_only_top_level():
    pg = parse_profile_groups(ET.fromstring(PROFILE_GROUP_VSYS))
    assert list(pg) == ["AV_ONLY", "SG"]
    assert pg["SG"]["vulnerability"] == ["Vulnerability_POC"]
    assert pg["SG"]["spyware"] == ["Spyware_POC"]
    assert pg["SG"]["urlFiltering"] == ["URL_POC"]
    assert pg["SG"]["fileBlocking"] == ["FB_POC"]
    assert pg["SG"]["wildfireAnalysis"] == ["WF_POC"]
    assert pg["AV_ONLY"] == {"virus": ["AV_POC"]}

    # 忽略巢狀 rules / threat-exception / botnet-domains 的 <entry>
    assert parse_profile_names(ET.fromstring(VP_PROFILES_VSYS), "vulnerability") == ["Vulnerability_POC"]
    assert parse_profile_names(ET.fromstring(AS_PROFILES_VSYS), "spyware") == ["Spyware_POC"]
    assert parse_profile_groups(ET.fromstring('<response status="success"><result/></response>')) == {}
    assert parse_profile_names(ET.fromstring('<response status="success"><result/></response>'), "vulnerability") == []


def test_parse_threat_id():
    xml = SHOW_THREAT_ID_FOUND.format(name="Test Sig", subtype="vulnerability", severity="high", description="Desc")
    assert parse_threat_id(ET.fromstring(xml), "547000") == {
        "id": "547000",
        "name": "Test Sig",
        "subtype": "vulnerability",
        "severity": "high",
        "description": "Desc",
    }
    assert parse_threat_id(ET.fromstring('<response status="success"><result/></response>'), "999999") is None

    # F1-a:PA 對本機查無的 ID(如 Proxy:hola.org 109010004)回 Unknown 佔位且無 severity/description → 回 None
    unknown_xmls = (
        '<response status="success"><result><entry name="Unknown"><subtype>Unknown</subtype></entry></result></response>',
        (
            '<response status="success"><result>'
            '<entry name="unknown"><subtype>UNKNOWN</subtype><severity>  </severity><description/></entry>'
            "</result></response>"
        ),
        (
            '<response status="success"><result>'
            '<entry name="  Unknown "><subtype> unknown </subtype><severity></severity><description></description></entry>'
            "</result></response>"
        ),
    )
    for raw in unknown_xmls:
        assert parse_threat_id(ET.fromstring(raw), "109010004") is None

    # 若有 severity 或 description,即使名稱/子類型為 Unknown 也不誤判為查無
    with_sev = (
        '<response status="success"><result>'
        '<entry name="Unknown"><subtype>Unknown</subtype><severity>high</severity></entry>'
        "</result></response>"
    )
    assert parse_threat_id(ET.fromstring(with_sev), "109010004") is not None
    with_desc = (
        '<response status="success"><result>'
        '<entry name="Unknown"><subtype>Unknown</subtype><description>Real desc</description></entry>'
        "</result></response>"
    )
    assert parse_threat_id(ET.fromstring(with_desc), "109010004") is not None


def test_whitelist_rejects_other_commands_on_op_and_call(pa):
    w, _, _ = make(pa)
    bad_cmds = (
        "<show><config><running></running></config></show>",
        "<show><config><running><xpath>shared/profile-group</xpath></running></config></show>",
        "<show><predefined><xpath>/predefined/application</xpath></predefined></show>",
        "<request><content><upgrade><check/></upgrade></content></request>",
        "<show><threat><id>abc</id></threat></show>",
        "<show><threat><id>12345678901</id></threat></show>",
        "<show><threat><id>547000</id></threat></show>\n",
        "<show><threat><id>547000</id></threat><request/></show>",
    )
    for cmd in bad_cmds:
        with pytest.raises(ValueError, match="白名單"):
            w.api.op(cmd)

    bad_params = (
        {"type": "config", "action": "get", "xpath": "/config/predefined"},
        {"type": "log", "log-type": "threat"},
        {"type": "op", "cmd": INFO_CMD, "action": "set"},
        {"type": "op", "cmd": "<show><system><state/></system></show>"},
    )
    for params in bad_params:
        with pytest.raises(ValueError, match="白名單"):
            w.api.call(params)

    for bad_id in ("", "abc", "123\n", "12345678901", "547000<x/>"):
        with pytest.raises(ValueError):
            build_threat_id_cmd(bad_id)

    assert pa.requests == []
    assert ALLOWED_CMDS == frozenset({CPU_CMD, INFO_CMD, VULN_CMD, SPYWARE_CMD, PROFILE_GROUP_CMD, VP_PROFILES_CMD, AS_PROFILES_CMD})


def test_first_run_full_fetch_and_key_only_in_header(pa):
    w, r, _ = make(pa)
    assert w.run_once() == "ok"

    meta = json.loads(r.get(keys.SIG_META))
    vuln = json.loads(r.get(keys.SIG_ITEMS_VULN))
    spy = json.loads(r.get(keys.SIG_ITEMS_SPYWARE))
    profiles = json.loads(r.get(keys.SIG_PROFILES))

    assert meta["threatVersion"] == "9173-10354"
    assert meta["threatReleaseDate"] == "2026-11-17T05:46:29+08:00"
    assert meta["avVersion"] == "5749-6277" and meta["wildfireVersion"] == "1136765-1141451"
    assert meta["counts"] == {"vulnerability": 2, "spyware": 2, "total": 4}
    assert meta["hash"] == content_hash(vuln, spy) and len(meta["hash"]) == 64
    assert meta["baselineAt"] == meta["fetchedAt"] and meta["baselineAt"].endswith("Z")
    assert [v["id"] for v in vuln] == ["30000", "547000"]
    assert [s["id"] for s in spy] == ["10001", "87187"]
    assert profiles["vsys"] == "vsys1"
    assert profiles["profileGroups"]["SG"]["vulnerability"] == ["Vulnerability_POC"]
    assert profiles["vulnerabilityProfiles"] == ["Vulnerability_POC"]
    assert profiles["spywareProfiles"] == ["Spyware_POC"]

    for k in (keys.SIG_META, keys.SIG_ITEMS_VULN, keys.SIG_ITEMS_SPYWARE, keys.SIG_PROFILES):
        assert 0 < r.ttl(k) <= keys.SIG_TTL

    st = status(r)
    assert st["state"] == "ok" and st["count"] == "4" and st["threatVersion"] == "9173-10354"
    assert st["fullFetch"] == "1" and st["mgmtCpu"] == "10.0"

    # 只送白名單 op(含讀弱點、間諜軟體清單前各再檢查一次 CPU,審查 S1);API Key 只在標頭,不在 URL 與請求內容
    assert [p["cmd"] for p in pa.requests] == [
        CPU_CMD,
        INFO_CMD,
        CPU_CMD,
        VULN_CMD,
        CPU_CMD,
        SPYWARE_CMD,
        PROFILE_GROUP_CMD,
        VP_PROFILES_CMD,
        AS_PROFILES_CMD,
    ]
    assert all(p["type"] == "op" for p in pa.requests)
    assert all(KEY not in p["_url"] and KEY not in json.dumps({k: v for k, v in p.items() if k != "_header_key"}) for p in pa.requests)
    hb = w.status.snapshot()
    assert hb["signatureState"] == "ok" and "signatureError" not in hb and "signatureNote" not in hb


def test_unchanged_version_skips_full_fetch_and_updates_av_wildfire(pa):
    w, r, _ = make(pa)
    assert w.run_once() == "ok"
    first_meta = json.loads(r.get(keys.SIG_META))
    pa.requests.clear()

    # threat-version 沒變,但 AV / WildFire 更新了
    pa.values["av_version"] = "5750-6278"
    pa.values["wildfire_version"] = "1136766-1141452"
    assert w.run_once() == "ok"

    # 只送 CPU + show system info,不重抓全清單與 profile
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD, INFO_CMD]
    second_meta = json.loads(r.get(keys.SIG_META))
    assert second_meta["avVersion"] == "5750-6278"
    assert second_meta["wildfireVersion"] == "1136766-1141452"
    assert second_meta["fetchedAt"] == first_meta["fetchedAt"]
    assert second_meta["baselineAt"] == first_meta["baselineAt"]
    assert second_meta["hash"] == first_meta["hash"]
    assert status(r)["fullFetch"] == "0"


def test_version_change_triggers_full_fetch_and_keeps_baseline(pa):
    w, r, _ = make(pa)
    assert w.run_once() == "ok"
    baseline_at = json.loads(r.get(keys.SIG_META))["baselineAt"]
    old_hash = json.loads(r.get(keys.SIG_META))["hash"]
    pa.requests.clear()

    pa.values["threat_version"] = "9174-10355"
    pa.vuln_xml = PREDEFINED_VULNERABILITY.replace("Legacy SMB Info Leak", "Legacy SMB Info Leak v2")
    assert w.run_once() == "ok"

    assert len(pa.requests) == 9
    meta = json.loads(r.get(keys.SIG_META))
    assert meta["threatVersion"] == "9174-10355"
    assert meta["baselineAt"] == baseline_at
    assert meta["hash"] != old_hash
    assert status(r)["fullFetch"] == "1"


def test_manual_refresh_and_min_gap(pa):
    w, r, clock = make(pa)
    assert w.tick() == "ok"
    pa.requests.clear()

    # 30 秒內手動請求保留不消耗
    r.set(keys.SIG_REFRESH, json.dumps({"emp": "S112009"}))
    clock.t = 30
    assert w.tick() is None and r.get(keys.SIG_REFRESH) is not None and pa.requests == []

    # 滿 60 秒:即使 threat-version 沒變也強制重抓全清單並消耗請求
    clock.t = 60
    assert w.tick() == "ok" and r.get(keys.SIG_REFRESH) is None
    assert len(pa.requests) == 9
    assert status(r)["trigger"] == "manual" and status(r)["fullFetch"] == "1"

    # 下一次排程在 1800 秒後
    pa.requests.clear()
    clock.t = 60 + 1799
    assert w.tick() is None
    clock.t = 60 + 1800
    assert w.tick() == "ok" and status(r)["trigger"] == "schedule" and len(pa.requests) == 2


def test_cpu_high_and_paused_reject_without_fetching(pa):
    w, r, _ = make(pa)
    pa.values["idle"] = 40.0  # 管理平面 CPU 60% > 50%
    assert w.run_once() == "rejected"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD]
    assert status(r)["state"] == "rejected" and "60.0%" in status(r)["message"]
    assert r.get(keys.SIG_META) is None
    # 審查 S2:心跳反映 rejected 與原因,且不標為 signatureError
    hb_rej = w.status.snapshot()
    assert hb_rej["signatureState"] == "rejected" and "60.0%" in hb_rej["signatureNote"]
    assert "signatureError" not in hb_rej

    # 暫停中:完全不送 PA 請求,60 秒後重檢;心跳反映 paused 且清除舊錯誤
    paused = [True]
    cfg = SignatureConfig(host="127.0.0.1", port=pa.port, api_key=KEY, ca_file="", tls_insecure=False, timeout=5, interval=1800, max_mgmt_cpu=50)
    r2 = fakeredis.FakeRedis()
    clock = Clock()
    w2 = SignatureWorker(r2, SignatureApi(cfg, use_http=True), Status("t", "test", False, False), 1800, 50, paused=lambda: paused[0], clock=clock)
    w2.status.fail("signature", "old error")
    pa.requests.clear()
    pa.values["idle"] = 90.0
    assert w2.tick() == "paused"
    assert pa.requests == [] and status(r2)["state"] == "paused"
    hb_paused = w2.status.snapshot()
    assert hb_paused["signatureState"] == "paused" and "暫停" in hb_paused["signatureNote"]
    assert "signatureError" not in hb_paused and "signatureErrorAt" not in hb_paused
    paused[0] = False
    clock.t = 60
    assert w2.tick() == "ok"
    hb_ok = w2.status.snapshot()
    assert hb_ok["signatureState"] == "ok" and "signatureNote" not in hb_ok


def test_recheck_cpu_before_vuln_and_spyware_preserves_snapshot(pa, monkeypatch):
    """審查 S1:開頭 CPU 正常、讀 VULN_CMD 或 SPYWARE_CMD 前 CPU 超標 → rejected,不送清單、保留上一份快照。"""
    w, r, _ = make(pa)
    assert w.run_once() == "ok"
    before_meta = r.get(keys.SIG_META)
    before_vuln = r.get(keys.SIG_ITEMS_VULN)
    before_spy = r.get(keys.SIG_ITEMS_SPYWARE)

    # 情境 1:第 1 次(開頭)CPU 10% 通過,第 2 次(讀 VULN_CMD 前)CPU 65% 超標 → 不送 VULN / SPYWARE
    pa.requests.clear()
    pa.values["threat_version"] = "9174-10355"
    idles = iter([90.0, 35.0])
    orig_respond = pa.respond

    def seq_respond(p: dict[str, str]) -> str:
        if p.get("cmd") == CPU_CMD:
            pa.values["idle"] = next(idles, 90.0)
        return orig_respond(p)

    monkeypatch.setattr(pa, "respond", seq_respond)
    assert w.run_once() == "rejected"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD, INFO_CMD, CPU_CMD]
    assert status(r)["state"] == "rejected" and "65.0%" in status(r)["message"]
    assert w.status.snapshot()["signatureState"] == "rejected"
    assert r.get(keys.SIG_META) == before_meta and r.get(keys.SIG_ITEMS_VULN) == before_vuln and r.get(keys.SIG_ITEMS_SPYWARE) == before_spy

    # 情境 2:第 1、2 次 CPU 10% 通過(已讀 VULN_CMD),第 3 次(讀 SPYWARE_CMD 前)CPU 70% 超標 → 不送 SPYWARE、保留快照
    pa.requests.clear()
    idles = iter([90.0, 90.0, 30.0])
    assert w.run_once() == "rejected"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD, INFO_CMD, CPU_CMD, VULN_CMD, CPU_CMD]
    assert status(r)["state"] == "rejected" and "70.0%" in status(r)["message"]
    assert r.get(keys.SIG_META) == before_meta and r.get(keys.SIG_ITEMS_VULN) == before_vuln and r.get(keys.SIG_ITEMS_SPYWARE) == before_spy

    # 情境 3:第 2 次 CPU 回應無法解析(cpu is None)→ rejected、不送 VULN / SPYWARE
    pa.requests.clear()
    call_count = [0]

    def unreadable_second_cpu(p: dict[str, str]) -> str:
        if p.get("cmd") == CPU_CMD:
            call_count[0] += 1
            if call_count[0] == 2:
                return '<response status="success"><result>unparseable</result></response>'
            pa.values["idle"] = 90.0
        return orig_respond(p)

    monkeypatch.setattr(pa, "respond", unreadable_second_cpu)
    assert w.run_once() == "rejected"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD, INFO_CMD, CPU_CMD]
    assert r.get(keys.SIG_META) == before_meta


def test_failures_empty_list_too_large_preserve_previous_snapshot(pa, monkeypatch):
    w, r, _ = make(pa)
    assert w.run_once() == "ok"
    before_meta = r.get(keys.SIG_META)
    before_vuln = r.get(keys.SIG_ITEMS_VULN)
    before_spy = r.get(keys.SIG_ITEMS_SPYWARE)

    # 弱點清單空白 → failed,保留上一份快照
    pa.vuln_xml = '<response status="success"><result><vulnerability/></result></response>'
    assert w.run_once(manual=True) == "failed"
    assert r.get(keys.SIG_META) == before_meta
    assert r.get(keys.SIG_ITEMS_VULN) == before_vuln
    assert r.get(keys.SIG_ITEMS_SPYWARE) == before_spy
    assert status(r)["state"] == "failed" and "空的" in status(r)["message"] and status(r)["count"] == "4"

    # 間諜軟體空白 → failed,保留上一份快照
    pa.vuln_xml = PREDEFINED_VULNERABILITY
    pa.phone_home_xml = '<response status="success"><result/></response>'
    assert w.run_once(manual=True) == "failed"
    assert r.get(keys.SIG_ITEMS_SPYWARE) == before_spy

    # 超過筆數上限 → failed,保留上一份快照
    import netops_pa.signatures as sig_mod

    pa.phone_home_xml = PREDEFINED_PHONE_HOME
    monkeypatch.setattr(sig_mod, "MAX_SIGNATURES", 1)
    assert w.run_once(manual=True) == "failed"
    assert "超過 1 筆" in status(r)["message"] and r.get(keys.SIG_ITEMS_VULN) == before_vuln
    monkeypatch.undo()

    # 回應超過 max_bytes → failed,不寫快照
    w_small, r_small, _ = make(pa, max_bytes=512)
    assert w_small.run_once() == "failed"
    assert "回應過大" in status(r_small)["message"] and r_small.get(keys.SIG_META) is None


def test_optional_no_such_node_profiles_and_masked_wrong_key(pa):
    w, r, _ = make(pa)
    pa.profile_group_xml = NO_SUCH_NODE
    pa.vp_profiles_xml = NO_SUCH_NODE
    pa.as_profiles_xml = NO_SUCH_NODE
    assert w.run_once() == "ok"
    profiles = json.loads(r.get(keys.SIG_PROFILES))
    assert profiles["profileGroups"] == {} and profiles["vulnerabilityProfiles"] == [] and profiles["spywareProfiles"] == []

    # 錯誤金鑰:失敗且訊息不外洩金鑰
    bad_key = "wrong-signature-secret-99999"
    register_secret(bad_key)
    w_bad, r_bad, _ = make(pa, key=bad_key)
    assert w_bad.run_once() == "failed"
    assert bad_key not in json.dumps(status(r_bad))


def test_on_demand_threat_id_lookup_cache_cooldown_cpu_and_validation(pa):
    w, r, _ = make(pa)
    # 1. 成功查詢並快取 1 天 + 設 10 秒全域限流
    lid1 = enqueue_lookup(r, "547000", "l-1")
    assert w.run_one_lookup() == lid1
    j1 = read_lookup(r, lid1)
    assert j1["status"] == "done" and j1["cached"] == "0" and j1["mgmtCpu"] == "10.0"
    assert json.loads(j1["result"]) == {
        "id": "547000",
        "name": "Test App-ID change signature",
        "subtype": "vulnerability",
        "severity": "informational",
        "description": "Test threat description from PA-560.",
    }
    assert 0 < r.ttl(keys.SIG_LOOKUP_COOL) <= keys.SIG_LOOKUP_COOL_SEC
    assert 0 < r.ttl(keys.sig_lookup_cache("547000")) <= keys.SIG_LOOKUP_CACHE_TTL
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD, build_threat_id_cmd("547000")]

    # 2. 同 ID 命中快取:完全不打 PA(也不受限流影響)
    pa.requests.clear()
    lid2 = enqueue_lookup(r, "547000", "l-2")
    assert w.run_one_lookup() == lid2
    j2 = read_lookup(r, lid2)
    assert j2["status"] == "done" and j2["cached"] == "1" and pa.requests == []

    # 3. 不同 ID 但全系統仍在 10 秒限流內 → rejected
    lid3 = enqueue_lookup(r, "999999", "l-3")
    assert w.run_one_lookup() == lid3
    j3 = read_lookup(r, lid3)
    assert j3["status"] == "rejected" and j3["error"] == "NETOPS_PA_SIGNATURE_COOLDOWN" and pa.requests == []

    # 4. 清除限流後查不存在 ID → not_found 並寫入負快取 1 天;再查同 ID 命中負快取不打 PA
    r.delete(keys.SIG_LOOKUP_COOL)
    lid4 = enqueue_lookup(r, "999999", "l-4")
    assert w.run_one_lookup() == lid4
    j4 = read_lookup(r, lid4)
    assert j4["status"] == "not_found" and "本機特徵庫查無" in j4["message"]
    assert json.loads(r.get(keys.sig_lookup_cache("999999")))["found"] is False

    pa.requests.clear()
    lid4b = enqueue_lookup(r, "999999", "l-4b")
    assert w.run_one_lookup() == lid4b
    assert read_lookup(r, lid4b)["status"] == "not_found" and read_lookup(r, lid4b)["cached"] == "1" and pa.requests == []

    # 4c. PA 回 No such node 也視為 not_found 並寫負快取
    r.delete(keys.SIG_LOOKUP_COOL)
    pa.fail["<id>888888</id>"] = NO_SUCH_NODE
    lid4c = enqueue_lookup(r, "888888", "l-4c")
    assert w.run_one_lookup() == lid4c
    assert read_lookup(r, lid4c)["status"] == "not_found"
    pa.fail.pop("<id>888888</id>", None)

    # 5. CPU > 50% → rejected,不送 show threat id
    r.delete(keys.SIG_LOOKUP_COOL)
    pa.requests.clear()
    pa.values["idle"] = 30.0
    lid5 = enqueue_lookup(r, "111111", "l-5")
    assert w.run_one_lookup() == lid5
    j5 = read_lookup(r, lid5)
    assert j5["status"] == "rejected" and j5["error"] == "NETOPS_PA_SIGNATURE_CPU_HIGH"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD]

    # 6. 非法 ID(注入嘗試)→ failed,不碰 PA、不設限流
    r.delete(keys.SIG_LOOKUP_COOL)
    pa.requests.clear()
    lid6 = enqueue_lookup(r, "547000</id></threat><request/>", "l-6")
    assert w.run_one_lookup() == lid6
    j6 = read_lookup(r, lid6)
    assert j6["status"] == "failed" and j6["error"] == "NETOPS_PA_SIGNATURE_INVALID"
    assert pa.requests == [] and r.get(keys.SIG_LOOKUP_COOL) is None

    # 7. 暫停中 → rejected,不碰 PA
    w_paused, r_paused, _ = make(pa, paused=True)
    lid7 = enqueue_lookup(r_paused, "222222", "l-7")
    assert w_paused.run_one_lookup() == lid7
    assert read_lookup(r_paused, lid7)["error"] == "NETOPS_PA_SIGNATURE_PAUSED" and pa.requests == []


def test_on_demand_lookup_unknown_placeholder_and_stale_cache(pa):
    """F1-a:PA 回 Unknown 佔位時寫為 not_found 並快取 found=false;舊快取含 Unknown 亦直接視為 not_found 且不改寫快取。"""
    w, r, _ = make(pa)
    pa.threat_ids["109010004"] = {
        "name": "Unknown",
        "subtype": "Unknown",
        "severity": "",
        "description": "",
    }
    lid1 = enqueue_lookup(r, "109010004", "l-unk-1")
    assert w.run_one_lookup() == lid1
    j1 = read_lookup(r, lid1)
    assert j1["status"] == "not_found"
    assert "本機特徵庫查無" in j1["message"]
    assert json.loads(r.get(keys.sig_lookup_cache("109010004")))["found"] is False

    # 舊快取若曾存成 found:true + Unknown 佔位 → 視為 not_found、不打 PA、不刪除/改寫快取
    pa.requests.clear()
    stale_val = json.dumps(
        {
            "found": True,
            "checkedAt": "2026-11-20T01:00:00Z",
            "item": {"id": "109010005", "name": "Unknown", "subtype": "Unknown", "severity": None, "description": None},
        }
    )
    r.set(keys.sig_lookup_cache("109010005"), stale_val, ex=3600)
    lid2 = enqueue_lookup(r, "109010005", "l-unk-2")
    assert w.run_one_lookup() == lid2
    j2 = read_lookup(r, lid2)
    assert j2["status"] == "not_found" and j2["cached"] == "1"
    assert "本機特徵庫查無" in j2["message"]
    assert pa.requests == []
    assert r.get(keys.sig_lookup_cache("109010005")).decode() == stale_val


def test_signature_config(tmp_path):
    base = {"GW_ENV": "test", "REDIS_URL": "redis://x"}
    assert load_config(base).signature is None

    shared = tmp_path / "shared"
    shared.write_text("shared-key-123456")
    pol = tmp_path / "pol"
    pol.write_text("policy-key-123456")
    sig = tmp_path / "sig"
    sig.write_text("sig-key-123456")

    # 金鑰回退順序:PA_SIGNATURE_API_KEY_FILE → PA_POLICY_API_KEY_FILE → PA_API_KEY_FILE
    c1 = load_config({**base, "PA_SIGNATURE_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(shared)}).signature
    assert c1 and c1.api_key == "shared-key-123456" and c1.interval == 1800 and c1.max_mgmt_cpu == 50 and c1.timeout == 30

    c2 = load_config({
        **base,
        "PA_SIGNATURE_ENABLED": "1",
        "PA_HOST": "pa",
        "PA_API_KEY_FILE": str(shared),
        "PA_POLICY_API_KEY_FILE": str(pol),
    }).signature
    assert c2 and c2.api_key == "policy-key-123456"

    c3 = load_config({
        **base,
        "PA_SIGNATURE_ENABLED": "1",
        "PA_HOST": "pa",
        "PA_API_KEY_FILE": str(shared),
        "PA_POLICY_API_KEY_FILE": str(pol),
        "PA_SIGNATURE_API_KEY_FILE": str(sig),
        "PA_SIGNATURE_MINUTES": "60",
        "PA_SIGNATURE_MAX_MGMT_CPU": "40",
        "PA_SIGNATURE_HTTP_TIMEOUT_SECONDS": "90",
    }).signature
    assert c3 and c3.api_key == "sig-key-123456" and c3.interval == 3600 and c3.max_mgmt_cpu == 40 and c3.timeout == 90

    # 邊界與正式區拒絕明文金鑰
    with pytest.raises(ConfigError, match="PA_SIGNATURE_MINUTES"):
        load_config({**base, "PA_SIGNATURE_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(shared), "PA_SIGNATURE_MINUTES": "5"})
    with pytest.raises(ConfigError, match="PA_SIGNATURE_MAX_MGMT_CPU"):
        load_config({**base, "PA_SIGNATURE_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(shared), "PA_SIGNATURE_MAX_MGMT_CPU": "60"})
    with pytest.raises(ConfigError, match="PA_SIGNATURE_ENABLED"):
        load_config({**base, "PA_SIGNATURE_ENABLED": "1", "PA_HOST": "pa"})
    with pytest.raises(ConfigError, match="PA_SIGNATURE_API_KEY_FILE"):
        load_config({"GW_ENV": "prod", "REDIS_URL": "redis://x", "PA_SIGNATURE_ENABLED": "1", "PA_HOST": "pa", "PA_SIGNATURE_API_KEY": "plain"})
