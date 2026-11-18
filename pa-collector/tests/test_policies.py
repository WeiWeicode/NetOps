"""PA 安全規則收集(PR-1):解析正規化、唯讀白名單、CPU 門檻、暫停、手動重新整理、版本雜湊、Key 只在標頭。"""

from __future__ import annotations

import json
import threading
import urllib.parse
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.config import ConfigError, PolicyConfig, load_config
from netops_pa.pa_query import CPU_CMD
from netops_pa.policies import (
    ALLOWED_CMDS,
    HITS_CMD,
    RULES_CMD,
    PolicyApi,
    PolicyWorker,
    config_cmd,
    content_hash,
    parse_hits,
    parse_objects,
    parse_rules,
)
from netops_pa.status import Status
from tests.fake_pa import SYSTEM_RESOURCES

KEY = "secret-policy-key-0123456789"

RULES = """<response status="success"><result total-count="1" count="1"><security><rules>
<entry name="Allow-Web" uuid="u-1"><from><member>trust</member></from><to><member>untrust</member></to>
<source><member>Net_Office</member></source><destination><member>any</member></destination><source-user><member>any</member></source-user>
<source-hip><member>any</member></source-hip><destination-hip><member>any</member></destination-hip>
<application><member>ssl</member><member>web-browsing</member></application><service><member>application-default</member></service>
<category><member>any</member></category><action>allow</action><profile-setting><group><member>default</member></group></profile-setting>
<log-end>yes</log-end><log-setting>to-syslog</log-setting><tag><member>Web</member></tag><group-tag>Web</group-tag>
<rule-type>universal</rule-type><description>office web</description></entry>
<entry name="Old-Rule" uuid="u-2"><from><member>any</member></from><to><member>any</member></to><source><member>any</member></source>
<destination><member>GRP_Servers</member></destination><application><member>any</member></application><service><member>tcp-8080</member></service>
<action>deny</action><disabled>yes</disabled><negate-destination>yes</negate-destination></entry>
<entry name="Deny-All" uuid="u-3"><from><member>any</member></from><to><member>any</member></to><source><member>any</member></source>
<destination><member>any</member></destination><application><member>any</member></application><service><member>any</member></service>
<action>drop</action><log-start>yes</log-start></entry>
</rules></security></result></response>"""
OBJECTS = {
    "address": """<response status="success"><result><address>
<entry name="Net_Office"><ip-netmask>10.10.112.0/22</ip-netmask><description>office</description></entry>
<entry name="Srv_Range"><ip-range>10.10.130.10-10.10.130.20</ip-range></entry>
<entry name="Example"><fqdn>example.com</fqdn><tag><member>Web</member></tag></entry></address></result></response>""",
    "address-group": """<response status="success"><result><address-group>
<entry name="GRP_Servers"><static><member>Srv_Range</member><member>Net_Office</member></static></entry></address-group></result></response>""",
    "service": """<response status="success"><result><service>
<entry name="tcp-8080"><protocol><tcp><port>8080</port></tcp></protocol></entry></service></result></response>""",
    "service-group": """<response status="success"><result><service-group>
<entry name="SG_Web"><members><member>tcp-8080</member><member>service-https</member></members></entry></service-group></result></response>""",
    "application-group": """<response status="success"><result><application-group>
<entry name="AG_Mail"><members><member>smtp</member><member>imap</member></members></entry></application-group></result></response>""",
    "tag": """<response status="success"><result><tag><entry name="Web"><color>color3</color></entry></tag></result></response>""",
}
HITS = """<response status="success"><result><rule-hit-count><vsys><entry name="vsys1"><rule-base><entry name="security"><rules>
<entry name="Allow-Web"><latest>yes</latest><hit-count>1234</hit-count><last-hit-timestamp>1763452800</last-hit-timestamp>
<last-reset-timestamp>0</last-reset-timestamp><first-hit-timestamp>1700000000</first-hit-timestamp>
<rule-creation-timestamp>1690000000</rule-creation-timestamp><rule-modification-timestamp>1760000000</rule-modification-timestamp></entry>
<entry name="Old-Rule"><latest>yes</latest><hit-count>0</hit-count><last-hit-timestamp>0</last-hit-timestamp></entry>
<entry name="intrazone-default"><latest>yes</latest><hit-count>9</hit-count></entry>
</rules></entry></rule-base></entry></vsys></rule-hit-count></result></response>"""


class FakePolicyPa:
    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []
        self.idle = 90.0
        self.rules = RULES
        self.fail_rules = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                p = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode()).items()}
                p["_url"] = self.path
                p["_key"] = self.headers.get("X-PAN-KEY", "")
                fake.requests.append(p)
                data = fake.respond(p).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]

    def respond(self, p: dict[str, str]) -> str:
        if p["_key"] != KEY:
            return '<response status="error" code="403"><result><msg>Invalid Credential</msg></result></response>'
        cmd = p.get("cmd", "")
        if cmd == CPU_CMD:
            return SYSTEM_RESOURCES.format(idle=self.idle)
        if cmd == RULES_CMD:
            return '<response status="error" code="13"><msg>boom</msg></response>' if self.fail_rules else self.rules
        if cmd == HITS_CMD:
            return HITS
        for tag, xml in OBJECTS.items():
            if cmd == config_cmd(tag):
                return xml
        return '<response status="error"><msg>unknown</msg></response>'

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.server.shutdown()


@pytest.fixture
def pa():
    with FakePolicyPa() as p:
        yield p


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(pa: FakePolicyPa, key: str = KEY, paused: bool = False):
    cfg = PolicyConfig(host="127.0.0.1", port=pa.port, api_key=key, ca_file="", tls_insecure=False, timeout=5, interval=1800, max_mgmt_cpu=50)
    r = fakeredis.FakeRedis()
    clock = Clock()
    w = PolicyWorker(r, PolicyApi(cfg, use_http=True), Status("t", "test", False, False), 1800, 50, paused=lambda: paused, clock=clock)
    return w, r, clock


def status(r) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in r.hgetall(keys.POLICY_STATUS).items()}


def test_parse_rules_order_and_fields():
    rules = parse_rules(ET.fromstring(RULES))
    assert [(r["position"], r["name"]) for r in rules] == [(1, "Allow-Web"), (2, "Old-Rule"), (3, "Deny-All")]
    web = rules[0]
    assert web["fromZones"] == ["trust"] and web["toZones"] == ["untrust"]
    assert web["sources"] == ["Net_Office"] and web["applications"] == ["ssl", "web-browsing"]
    assert web["profileGroup"] == "default" and web["profiles"] == {}
    assert web["logEnd"] is True and web["logStart"] is False and web["logSetting"] == "to-syslog"
    assert web["sourceDevices"] == ["any"] and web["groupTag"] == "Web" and web["type"] == "universal" and web["uuid"] == "u-1"
    old = rules[1]
    assert old["disabled"] is True and old["negateDestination"] is True and old["action"] == "deny"
    assert old["sourceUsers"] == [] and old["profileGroup"] is None
    assert rules[2]["logStart"] is True
    # 沒有規則(節點不存在)
    assert parse_rules(ET.fromstring('<response status="success"><result/></response>')) == []


def test_parse_objects_and_hits():
    addr = parse_objects("addresses", ET.fromstring(OBJECTS["address"]))
    assert [(a["name"], a["type"], a["value"]) for a in addr] == [
        ("Example", "fqdn", "example.com"),
        ("Net_Office", "ip-netmask", "10.10.112.0/22"),
        ("Srv_Range", "ip-range", "10.10.130.10-10.10.130.20"),
    ]
    assert parse_objects("addressGroups", ET.fromstring(OBJECTS["address-group"]))[0]["static"] == ["Srv_Range", "Net_Office"]
    svc = parse_objects("services", ET.fromstring(OBJECTS["service"]))[0]
    assert (svc["protocol"], svc["destinationPort"]) == ("tcp", "8080")
    assert parse_objects("serviceGroups", ET.fromstring(OBJECTS["service-group"]))[0]["members"] == ["tcp-8080", "service-https"]
    assert parse_objects("applicationGroups", ET.fromstring(OBJECTS["application-group"]))[0]["members"] == ["smtp", "imap"]
    assert parse_objects("tags", ET.fromstring(OBJECTS["tag"]))[0]["color"] == "color3"
    # shared 底下沒有物件時 PA 回 No such node:視為空
    assert parse_objects("addresses", ET.fromstring('<response status="success"><result/></response>')) == []
    hits = parse_hits(ET.fromstring(HITS))
    assert hits["Allow-Web"] == {"hitCount": 1234, "lastHit": "2025-11-18T08:00:00Z", "firstHit": "2023-11-14T22:13:20Z", "lastReset": None,
                                 "created": "2023-07-22T04:26:40Z", "modified": "2025-10-09T08:53:20Z"}
    assert hits["Old-Rule"]["hitCount"] == 0 and hits["Old-Rule"]["lastHit"] is None
    assert "intrazone-default" in hits


def test_whitelist_rejects_other_commands(pa):
    w, _, _ = make(pa)
    for cmd in ("<show><config><running></running></config></show>", "<request><restart><system/></restart></request>",
                config_cmd("rulebase/nat"), "<show><session><all/></session></show>"):
        with pytest.raises(ValueError):
            w.api.op(cmd)
    assert pa.requests == []
    assert CPU_CMD in ALLOWED_CMDS and len(ALLOWED_CMDS) == 9


def test_run_once_writes_snapshot_hits_status(pa):
    w, r, _ = make(pa)
    assert w.run_once() == "ok"
    snap = json.loads(r.get(keys.POLICY_SNAPSHOT))
    assert [x["name"] for x in snap["rules"]] == ["Allow-Web", "Old-Rule", "Deny-All"]
    assert set(snap["objects"]) == {"addresses", "addressGroups", "services", "serviceGroups", "applicationGroups", "tags"}
    assert len(snap["hash"]) == 64 and snap["fetchedAt"].endswith("Z")
    assert 0 < r.ttl(keys.POLICY_SNAPSHOT) <= keys.POLICY_TTL
    assert json.loads(r.get(keys.POLICY_HITS))["items"]["Allow-Web"]["hitCount"] == 1234
    st = status(r)
    assert st["state"] == "ok" and st["ruleCount"] == "3" and st["hash"] == snap["hash"] and st["mgmtCpu"] == "10.0"
    # 只送 type=op 的白名單指令;Key 只在標頭,不在網址與內容
    assert all(p["type"] == "op" and p["cmd"] in ALLOWED_CMDS for p in pa.requests)
    assert all(KEY not in p["_url"] and KEY not in json.dumps({k: v for k, v in p.items() if k != "_key"}) for p in pa.requests)
    assert len(pa.requests) == 1 + 1 + 6 + 1


def test_hash_ignores_hits_and_changes_with_rules(pa):
    w, r, _ = make(pa)
    w.run_once()
    h1 = json.loads(r.get(keys.POLICY_SNAPSHOT))["hash"]
    w.run_once()
    assert json.loads(r.get(keys.POLICY_SNAPSHOT))["hash"] == h1
    # 調換順序也算變更(順序是規則的一部分)
    pa.rules = RULES.replace('name="Old-Rule"', 'name="Old-Rule-2"')
    w.run_once()
    assert json.loads(r.get(keys.POLICY_SNAPSHOT))["hash"] != h1
    rules = parse_rules(ET.fromstring(RULES))
    assert content_hash(rules, {}) != content_hash(list(reversed(rules)), {})


def test_cpu_high_rejected_without_reading_rules(pa):
    w, r, _ = make(pa)
    pa.idle = 30.0
    assert w.run_once() == "rejected"
    assert [p["cmd"] for p in pa.requests] == [CPU_CMD]
    assert status(r)["state"] == "rejected" and "70.0%" in status(r)["message"]
    assert r.get(keys.POLICY_SNAPSHOT) is None


def test_paused_sends_nothing(pa):
    w, r, _ = make(pa, paused=True)
    assert w.run_once() == "paused"
    assert pa.requests == [] and status(r)["state"] == "paused"


def test_pa_error_and_wrong_key_masked(pa):
    w, r, _ = make(pa)
    pa.fail_rules = True
    assert w.run_once() == "failed"
    assert status(r)["state"] == "failed" and "code 13" in status(r)["message"]
    w2, r2, _ = make(pa, key="wrong-key-but-long-enough")
    assert w2.run_once() == "failed"
    assert "wrong-key" not in json.dumps(status(r2))


def test_schedule_and_manual_refresh(pa):
    w, r, clock = make(pa)
    assert w.tick() == "ok"  # 啟動後立即一次
    n = len(pa.requests)
    clock.t = 100
    assert w.tick() is None and len(pa.requests) == n
    # 手動請求:立即執行並消耗請求
    r.set(keys.POLICY_REFRESH, json.dumps({"emp": "S112009"}))
    assert w.tick() == "ok" and r.get(keys.POLICY_REFRESH) is None
    assert status(r)["trigger"] == "manual"
    clock.t = 100 + 1800
    assert w.tick() == "ok" and status(r)["trigger"] == "schedule"


def test_config(tmp_path):
    base = {"GW_ENV": "test", "REDIS_URL": "redis://x"}
    assert load_config(base).policy is None
    key = tmp_path / "k"
    key.write_text("shared-key-123456")
    cfg = load_config({**base, "PA_POLICY_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(key)}).policy
    assert cfg and cfg.api_key == "shared-key-123456" and cfg.interval == 1800 and cfg.max_mgmt_cpu == 50
    own = tmp_path / "own"
    own.write_text("policy-key-123456")
    cfg = load_config({**base, "PA_POLICY_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(key), "PA_POLICY_API_KEY_FILE": str(own),
                       "PA_POLICY_MINUTES": "60"}).policy
    assert cfg and cfg.api_key == "policy-key-123456" and cfg.interval == 3600
    with pytest.raises(ConfigError, match="PA_POLICY_MINUTES"):
        load_config({**base, "PA_POLICY_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(key), "PA_POLICY_MINUTES": "5"})
    with pytest.raises(ConfigError, match="PA_POLICY_ENABLED"):
        load_config({**base, "PA_POLICY_ENABLED": "1", "PA_HOST": "pa"})


def test_call_also_enforces_whitelist(pa):
    w, _, _ = make(pa)
    for params in ({"type": "op", "cmd": "<show><config><running></running></config></show>"}, {"type": "log", "log-type": "config"},
                   {"type": "op", "cmd": RULES_CMD, "action": "set"}, {"type": "config", "action": "show"}):
        with pytest.raises(ValueError):
            w.api.call(params)
    assert pa.requests == []


def test_empty_rules_keep_previous_snapshot(pa):
    w, r, _ = make(pa)
    w.run_once()
    before = r.get(keys.POLICY_SNAPSHOT)
    pa.rules = '<response status="success"><result/></response>'
    assert w.run_once() == "failed"
    assert r.get(keys.POLICY_SNAPSHOT) == before
    st = status(r)
    assert st["state"] == "failed" and "空的" in st["message"] and st["ruleCount"] == "3"


def test_parse_error_and_too_large_are_failures(pa, monkeypatch):
    w, r, _ = make(pa)
    import netops_pa.policies as pol

    monkeypatch.setattr(pol, "parse_hits", lambda root: (_ for _ in ()).throw(AttributeError("x")))
    assert w.run_once() == "failed" and "AttributeError" in status(r)["message"]
    monkeypatch.undo()
    monkeypatch.setattr(pol, "MAX_RULES", 2)
    assert w.run_once() == "failed" and "超過 2 條" in status(r)["message"]
    assert r.get(keys.POLICY_SNAPSHOT) is None
    with pytest.raises(pol.TooLargeError):
        pol._list(["a"] * (pol.MAX_ITEMS + 1))


def test_retry_after_failure_and_manual_min_gap(pa):
    w, r, clock = make(pa)
    pa.idle = 30.0
    assert w.tick() == "rejected"
    clock.t = 299
    assert w.tick() is None
    pa.idle = 90.0
    clock.t = 300
    assert w.tick() == "ok"
    # 上次執行 30 秒前:手動請求保留,不消耗
    r.set(keys.POLICY_REFRESH, "1")
    clock.t = 330
    assert w.tick() is None and r.get(keys.POLICY_REFRESH) is not None
    clock.t = 360
    assert w.tick() == "ok" and r.get(keys.POLICY_REFRESH) is None


def test_paused_rechecks_soon(pa):
    paused = [True]
    cfg = PolicyConfig(host="127.0.0.1", port=pa.port, api_key=KEY, ca_file="", tls_insecure=False, timeout=5, interval=1800, max_mgmt_cpu=50)
    r = fakeredis.FakeRedis()
    clock = Clock()
    w = PolicyWorker(r, PolicyApi(cfg, use_http=True), Status("t", "test", False, False), 1800, 50, paused=lambda: paused[0], clock=clock)
    assert w.tick() == "paused"
    paused[0] = False
    clock.t = 60
    assert w.tick() == "ok"
