"""PA 精準查詢執行者(C5):參數再驗、CPU 門檻、log 工作輪詢與逾時取消、Session Browser、名額與冷卻、API Key 不外洩。
假 PA(本檔的 FakeQueryPa)只接受 X-PAN-KEY 標頭的 Key,並記錄每個請求,確認只送唯讀請求。
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.config import QueryConfig
from netops_pa.pa_query import CPU_CMD, JobError, QueryWorker, XmlApi, build_log_query, build_session_cmd, parse_logs, parse_sessions
from netops_pa.status import Status
from tests.fake_pa import SYSTEM_RESOURCES

KEY = "secret-query-key-0123456789"
NOW = datetime(2026, 11, 12, 2, 0, tzinfo=UTC)  # 台灣 10:00

LOG_FIN = """<response status="success"><result><job><status>FIN</status></job><log><logs count="2" progress="100">
<entry logid="1"><receive_time>2026/11/12 09:58:01</receive_time><src>10.10.130.124</src><dst>8.8.8.8</dst>
<sport>51000</sport><dport>443</dport><app>ssl</app><action>allow</action><bytes>1200</bytes><bytes_sent>200</bytes_sent>
<bytes_received>1000</bytes_received><from>trust</from><to>untrust</to><rule>Allow-Web</rule></entry>
<entry logid="2"><receive_time>2026/11/12 09:59:01</receive_time><src>10.10.130.124</src><dst>1.1.1.1</dst>
<sport>51001</sport><dport>53</dport><app>dns</app><action>allow</action></entry>
</logs></log></result></response>"""
LOG_ACT = '<response status="success"><result><job><status>ACT</status></job></result></response>'
SESSIONS = """<response status="success"><result>
<entry><idx>101</idx><application>ssl</application><state>ACTIVE</state><type>FLOW</type><source>10.10.130.124</source><sport>51000</sport>
<dst>8.8.8.8</dst><dport>443</dport><proto>6</proto><from>trust</from><to>untrust</to><start-time>Wed Nov 12 09:59:00 2026</start-time>
<total-byte-count>5000</total-byte-count><security-rule>Allow-Web</security-rule><xsource>203.0.113.1</xsource></entry>
</result></response>"""


class FakeQueryPa:
    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []
        self.idle = 90.0
        self.log_polls_until_fin = 1
        self._polls = 0
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
        if p.get("type") == "op" and p.get("cmd") == CPU_CMD:
            return SYSTEM_RESOURCES.format(idle=self.idle)
        if p.get("type") == "op" and "<session>" in p.get("cmd", ""):
            return SESSIONS
        if p.get("type") == "log" and p.get("action") == "get":
            self._polls += 1
            return LOG_FIN if self._polls >= self.log_polls_until_fin else LOG_ACT
        if p.get("type") == "log" and p.get("action") == "finish":
            return '<response status="success"><result>Job 77 finished</result></response>'
        if p.get("type") == "log":
            return ('<response status="success" code="19"><result><msg><line>query job enqueued with jobid 77</line></msg>'
                    '<job>77</job></result></response>')
        return '<response status="error"><msg>unknown</msg></response>'

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.server.shutdown()


@pytest.fixture
def pa():
    with FakeQueryPa() as p:
        yield p


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make(pa: FakeQueryPa, key: str = KEY, max_cpu: int = 50):
    cfg = QueryConfig(host="127.0.0.1", port=pa.port, api_key=key, ca_file="", tls_insecure=False, timeout=5, max_mgmt_cpu=max_cpu)
    r = fakeredis.FakeRedis()
    clock = Clock()
    w = QueryWorker(r, XmlApi(cfg, use_http=True), Status("t", "test", False, False), max_cpu, clock=clock, sleep=clock.sleep, now=lambda: NOW)
    return w, r


def submit(r, kind: str, params: dict, job_id: str = "11111111-1111-1111-1111-111111111111") -> str:
    r.hset(keys.paq_job(job_id), mapping={"status": "queued", "kind": kind, "emp": "S112009", "params": json.dumps(params)})
    r.set(keys.PAQ_ACTIVE, job_id, ex=90)
    r.lpush(keys.PAQ_JOBS, job_id)
    return job_id


def job(r, job_id: str) -> dict[str, str]:
    return {k.decode(): v.decode() for k, v in r.hgetall(keys.paq_job(job_id)).items()}


LOG_PARAMS = {"logType": "traffic", "ip": "10.10.130.124", "from": "2026-11-12T09:45:00+08:00", "to": "2026-11-12T10:00:00+08:00", "nlogs": 500}


def test_build_log_query_only_validated_values():
    q = build_log_query(LOG_PARAMS, NOW)
    assert q.query == "( addr in 10.10.130.124 ) and ( receive_time geq '2026/11/12 09:45:00' ) and ( receive_time leq '2026/11/12 10:00:00' )"
    assert q.nlogs == 500
    bad = [
        {**LOG_PARAMS, "ip": "10.10.130.124 ) or ( addr in 0.0.0.0"},
        {**LOG_PARAMS, "ip": "10.0.0.0/8"},
        {**LOG_PARAMS, "from": "2026-11-12T09:44:59+08:00"},
        {**LOG_PARAMS, "to": "2026-11-12T08:59:00+08:00", "from": "2026-11-12T08:50:00+08:00"},
        {**LOG_PARAMS, "from": "2026-11-12T09:45:00"},
        {**LOG_PARAMS, "nlogs": 501},
        {**LOG_PARAMS, "nlogs": True},
        {**LOG_PARAMS, "logType": "url"},
    ]
    for p in bad:
        with pytest.raises(JobError):
            build_log_query(p, NOW)


def test_build_session_cmd():
    assert build_session_cmd({"ip": "10.0.0.1"}) == "<show><session><all><filter><source>10.0.0.1</source></filter></all></session></show>"
    assert "<destination>2001:db8::1</destination>" in build_session_cmd({"ip": "2001:db8:0::1", "direction": "dst"})
    with pytest.raises(JobError):
        build_session_cmd({"ip": "<x/>"})


def test_log_job_done_key_only_in_header(pa):
    w, r = make(pa)
    pa.log_polls_until_fin = 2
    jid = submit(r, "log", LOG_PARAMS)
    assert w.run_one() == jid
    j = job(r, jid)
    assert j["status"] == "done", j
    rows = json.loads(j["result"])
    assert rows[0]["time"] == "2026/11/12 09:58:01" and rows[0]["sent"] == 200 and rows[0]["fromZone"] == "trust"
    assert j["count"] == "2" and j["truncated"] == "0" and j["mgmtCpu"] == "10.0"
    # 名額釋放、全域間隔、TTL
    assert r.get(keys.PAQ_ACTIVE) is None
    assert 0 < r.ttl(keys.PAQ_COOL_GLOBAL) <= 10
    assert 0 < r.ttl(keys.paq_job(jid)) <= 600
    # 只送唯讀請求;Key 不在 URL 與內容
    kinds = [(p.get("type"), p.get("action", ""), p.get("cmd", "")[:20]) for p in pa.requests]
    assert kinds == [("op", "", CPU_CMD[:20]), ("log", "", ""), ("log", "get", ""), ("log", "get", "")]
    for p in pa.requests:
        assert "key" not in p and KEY not in p["_url"]


def test_cpu_over_threshold_rejected_without_query(pa):
    w, r = make(pa)
    pa.idle = 40.0  # 管理平面 60%
    jid = submit(r, "log", LOG_PARAMS)
    w.run_one()
    j = job(r, jid)
    assert j["status"] == "rejected" and j["error"] == "NETOPS_PA_QUERY_CPU_HIGH"
    assert [p.get("type") for p in pa.requests] == ["op"]


def test_timeout_cancels_pa_job(pa):
    w, r = make(pa)
    pa.log_polls_until_fin = 10**6
    jid = submit(r, "log", LOG_PARAMS)
    w.run_one()
    j = job(r, jid)
    assert j["status"] == "failed" and j["error"] == "NETOPS_PA_QUERY_TIMEOUT"
    assert pa.requests[-1].get("action") == "finish" and pa.requests[-1].get("job-id") == "77"
    # 輪詢間隔 2 → 5 秒,60 秒內大約 13 次
    gets = [p for p in pa.requests if p.get("action") == "get"]
    assert 10 <= len(gets) <= 16


def test_session_browser(pa):
    w, r = make(pa)
    jid = submit(r, "session", {"ip": "10.10.130.124", "direction": "src"})
    w.run_one()
    j = job(r, jid)
    assert j["status"] == "done"
    rows = json.loads(j["result"])
    assert rows[0]["src"] == "10.10.130.124" and rows[0]["bytes"] == 5000 and rows[0]["natSrc"] == "203.0.113.1"


def test_expired_slot_and_invalid_params_do_not_touch_pa(pa):
    w, r = make(pa)
    jid = submit(r, "log", LOG_PARAMS)
    r.delete(keys.PAQ_ACTIVE)
    w.run_one()
    assert job(r, jid)["error"] == "NETOPS_PA_QUERY_EXPIRED"
    jid2 = submit(r, "log", {**LOG_PARAMS, "ip": "1.2.3.4' or 1"}, "22222222-2222-2222-2222-222222222222")
    w.run_one()
    assert job(r, jid2)["error"] == "NETOPS_PA_QUERY_INVALID"
    assert pa.requests == []


def test_wrong_key_failure_is_masked(pa):
    w, r = make(pa, key="wrong-key-abcdefgh")
    jid = submit(r, "session", {"ip": "10.0.0.1"})
    w.run_one()
    j = job(r, jid)
    # CPU 讀不到 → 不送查詢
    assert j["status"] == "rejected" and j["error"] == "NETOPS_PA_QUERY_CPU_UNKNOWN"
    assert "wrong-key" not in json.dumps(j)


def test_parsers_limit():
    import xml.etree.ElementTree as ET

    many = "<response status='success'><result>" + "<entry><idx>1</idx></entry>" * 3 + "</result></response>"
    rows, truncated = parse_sessions(ET.fromstring(many), limit=2)
    assert len(rows) == 2 and truncated
    assert parse_logs(ET.fromstring(LOG_FIN), limit=1)[0]["dst"] == "8.8.8.8"


def test_now_window_uses_now():
    future = {**LOG_PARAMS, "from": (NOW + timedelta(minutes=2)).isoformat(), "to": (NOW + timedelta(minutes=5)).isoformat()}
    with pytest.raises(JobError):
        build_log_query(future, NOW)


def test_unexpected_params_fail_job_and_skip_global_gap(pa):
    w, r = make(pa)
    jid = "33333333-3333-3333-3333-333333333333"
    r.hset(keys.paq_job(jid), mapping={"status": "queued", "kind": "log", "emp": "emp:S1", "params": "[]"})
    r.set(keys.PAQ_ACTIVE, jid, ex=90)
    r.lpush(keys.PAQ_JOBS, jid)
    w.run_one()
    assert job(r, jid)["status"] == "failed" and job(r, jid)["error"] == "NETOPS_PA_QUERY_INVALID"
    # 沒有送 PA:不設全域間隔、名額釋放
    assert r.get(keys.PAQ_COOL_GLOBAL) is None and r.get(keys.PAQ_ACTIVE) is None
    assert pa.requests == []


def test_worker_waits_global_gap_and_refunds_cooldown_on_reject(pa):
    w, r = make(pa)
    r.set(keys.PAQ_COOL_GLOBAL, "1", px=4000)
    pa.idle = 30.0  # 管理平面 70% → rejected
    jid = submit(r, "session", {"ip": "10.0.0.1"})
    r.set("netops:paq:cool:emp:S112009", "1", ex=60)
    r.hset(keys.paq_job(jid), "emp", "emp:S112009")
    w.run_one()
    assert w.clock() >= 3.9  # 先等完全域間隔才查 CPU(pttl 取整數毫秒)
    assert job(r, jid)["status"] == "rejected"
    assert r.get("netops:paq:cool:emp:S112009") is None


def test_whitelist_and_no_redirect(pa):
    w, r = make(pa)
    with pytest.raises(ValueError):
        w.api.call({"type": "config", "action": "set"})
    with pytest.raises(ValueError):
        w.api.op("<show><session><all><filter><source>1.1.1.1</source></filter></all></session><request/></show>")
    # 3xx 不跟隨(Key 不會被帶到別的主機)
    from netops_pa.pa_query import PaApiError

    class Redirect(FakeQueryPa):
        pass

    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/steal")
            self.end_headers()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        cfg = QueryConfig(host="127.0.0.1", port=srv.server_address[1], api_key=KEY, ca_file="", tls_insecure=False, timeout=5, max_mgmt_cpu=50)
        with pytest.raises(PaApiError, match="302"):
            XmlApi(cfg, use_http=True).op(CPU_CMD)
    finally:
        srv.shutdown()


def test_ipv4_mapped_address_is_normalised():
    assert "addr in 10.0.0.5" in build_log_query({**LOG_PARAMS, "ip": "::ffff:10.0.0.5"}, NOW).query
