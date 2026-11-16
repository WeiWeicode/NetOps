"""SDK 輪詢:真正的 pan-os-python 連到假 PA(tests/fake_pa.py)。"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.config import PollConfig
from netops_pa.poller import READ_ONLY_COMMANDS, Poller, SdkClient, interface_rates, parse_counters, parse_dataplane, parse_system
from netops_pa.status import Status
from netops_pa.store import RedisStore
from tests.fake_pa import COUNTERS, ERROR_403, RESOURCE_MONITOR, SYSTEM_RESOURCES, FakePa


@pytest.fixture
def fake_pa():
    with FakePa() as pa:
        yield pa


def make(pa: FakePa, key: str = "test-key"):
    cfg = PollConfig(host="127.0.0.1", port=pa.port, api_key=key, ca_file="", tls_insecure=False, interval=15, timeout=5)
    r = fakeredis.FakeRedis()
    store = RedisStore(r, top_n=200)
    status = Status("t", "test", True, False)
    return Poller(SdkClient(cfg, use_http=True), store.write_snapshot, status, 15), r, status


def snap(r, metric):
    raw = r.get(keys.snap(metric))
    return json.loads(raw) if raw else None


def test_poll_writes_snapshots_with_ttl_and_series(fake_pa):
    poller, r, status = make(fake_pa)
    assert poller.poll_once() == []
    s = snap(r, "session")
    assert s["active"] == 3912 and s["max"] == 262142 and s["utilization"] == 1.5 and s["tcp"] == 3100
    assert s["time"].endswith("Z")
    assert snap(r, "throughput") == {"time": s["time"], "bps": 85_000_000, "pps": 12000, "cps": 45}
    cpu = snap(r, "cpu")
    assert cpu["mgmt"] == 10.0 and cpu["dataplane"] == 5.0
    assert cpu["memTotal"] == int(7948.4 * 1024**2)
    # 快照 60 秒過期(過期即停止更新);趨勢寫 Stream
    for m in keys.METRICS:
        assert 0 < r.ttl(keys.snap(m)) <= keys.SNAP_TTL
        assert r.xlen(keys.series(m)) == 1
    assert status.get("pollOkAt") and status.get("pollError") is None


def test_interface_rates_need_two_polls(fake_pa):
    poller, r, _ = make(fake_pa)
    poller.poll_once()
    first = snap(r, "interfaces")["items"]
    assert first[0] == {"name": "ethernet1/1", "rxBps": None, "txBps": None}
    fake_pa.values.update(i1=1000 + 125_000, o1=2000 + 250_000)
    poller._prev = (poller._prev[0] - 10, poller._prev[1])  # 模擬隔 10 秒
    poller.poll_once()
    items = {i["name"]: i for i in snap(r, "interfaces")["items"]}
    assert items["ethernet1/1"]["rxBps"] == pytest.approx(100_000, rel=0.05)
    assert items["ethernet1/1"]["txBps"] == pytest.approx(200_000, rel=0.05)
    assert items["ethernet1/2"]["rxBps"] == 0


def test_only_read_only_op_commands_are_sent(fake_pa):
    poller, _, _ = make(fake_pa)
    poller.poll_once()
    assert fake_pa.requests, "應該有送出請求"
    for p in fake_pa.requests:
        assert p["type"] == "op"
        assert p["cmd"].startswith("<show>")
    with pytest.raises(ValueError):
        poller.client.op("request restart system")


def test_invalid_key_records_error_without_leaking_key(fake_pa):
    poller, r, status = make(fake_pa, key="wrong-secret-key")
    failed = poller.poll_once()
    assert set(failed) == {"session", "system", "dataplane", "interfaces"}
    assert r.get(keys.snap("session")) is None
    err = status.get("pollError") or ""
    assert err and "wrong-secret-key" not in err
    assert status.get("pollErrorAt")


def test_one_failing_command_does_not_block_others(fake_pa):
    fake_pa.fail["<resource-monitor>"] = ERROR_403
    poller, r, status = make(fake_pa)
    assert poller.poll_once() == ["dataplane"]
    assert snap(r, "session")["active"] == 3912
    cpu = snap(r, "cpu")
    assert cpu["mgmt"] == 10.0 and cpu["dataplane"] is None
    assert "dataplane" in (status.get("pollError") or "")


def test_unreachable_pa():
    cfg = PollConfig(host="127.0.0.1", port=1, api_key="k", ca_file="", tls_insecure=False, interval=15, timeout=2)
    status = Status("t", "test", True, False)
    poller = Poller(SdkClient(cfg, use_http=True), lambda *a: None, status, 15)
    assert len(poller.poll_once()) == 4
    assert status.get("pollErrorAt")


def test_tls_verification_on_by_default():
    cfg = PollConfig(host="pa.invalid", port=443, api_key="k", ca_file="", tls_insecure=False, interval=15, timeout=2)
    x = SdkClient(cfg)._fw.generate_xapi()
    import ssl
    assert x.ssl_context.verify_mode == ssl.CERT_REQUIRED and x.ssl_context.check_hostname


def test_parsers_tolerate_version_differences():
    # 欄位缺少、結構不同:回 None,不丟例外
    assert parse_dataplane(ET.fromstring("<response><result/></response>")) is None
    assert parse_system(ET.fromstring("<response><result>no top output</result></response>"))["mgmt"] is None
    # KiB 單位(舊版 top)
    kib = SYSTEM_RESOURCES.replace("MiB Mem :   7948.4", "KiB Mem :   8139161").format(idle=50)
    assert parse_system(ET.fromstring(kib))["memTotal"] == 8139161 * 1024
    assert parse_dataplane(ET.fromstring(RESOURCE_MONITOR.format(c0=10, c1=20))) == 15.0
    # 介面:只取 ifnet 有位元組計數的 entry,hw 區段略過
    c = parse_counters(ET.fromstring(COUNTERS.format(i1=1, o1=2, i2=3, o2=4)))
    assert c == {"ethernet1/1": (1, 2), "ethernet1/2": (3, 4)}
    # 計數歸零(重開機)不算負數
    assert interface_rates({"e": (100, 100)}, {"e": (5, 5)}, 10) == [{"name": "e", "rxBps": None, "txBps": None}]


def test_whitelist_has_no_write_commands():
    for cmd in READ_ONLY_COMMANDS.values():
        assert cmd.startswith("show ")


def test_counter_interface_sends_value_not_element(fake_pa):
    """PAN-OS 12.1.7-h3 實測:interface 要的是值;show counter interface all 會被 SDK 轉成 <all/> 而失敗。"""
    poller, r, _ = make(fake_pa)
    assert "interfaces" not in poller.poll_once()
    cmds = [p["cmd"] for p in fake_pa.requests]
    assert "<show><counter><interface>all</interface></counter></show>" in cmds
    assert snap(r, "interfaces")["items"]


def test_fake_pa_rejects_counter_interface_element(fake_pa):
    """假 PA 照實機:<interface><all/> 回 non NULL value 錯誤(白名單若改回沒加引號的寫法,上一個測試會失敗)。"""
    good = fake_pa.respond({"key": "test-key", "cmd": "<show><counter><interface>all</interface></counter></show>"})
    bad = fake_pa.respond({"key": "test-key", "cmd": "<show><counter><interface><all></all></interface></counter></show>"})
    assert 'status="success"' in good
    assert 'status="error"' in bad and "non NULL value" in bad
