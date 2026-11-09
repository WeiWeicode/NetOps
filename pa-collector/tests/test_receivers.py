"""HTTP 與 Syslog 接收端點:來源 IP、Token、畸形與過大輸入。"""

from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import time

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.pipeline import Pipeline
from netops_pa.receiver_http import HttpReceiver, parse_body
from netops_pa.receiver_syslog import Framer, SyslogReceiver, parse_message
from netops_pa.servers import source_allowed
from netops_pa.status import Status

TOKEN = "t" * 40
LOCAL = (ipaddress.ip_network("127.0.0.1/32"),)
OTHER = (ipaddress.ip_network("10.99.99.99/32"),)


def make_pipeline():
    r = fakeredis.FakeRedis()
    from netops_pa.store import RedisStore

    st = Status("t", "test", False, True)
    return Pipeline(RedisStore(r, 10), st, queue_size=10_000, max_rate=10_000), st, r


@pytest.fixture
def http_rx():
    p, st, r = make_pipeline()
    srv = HttpReceiver(("127.0.0.1", 0), token=TOKEN, pipeline=p, max_body=8192, allowed=LOCAL, max_connections=4, tls=None, status=st)
    srv.start()
    yield srv, p, st, r
    srv.shutdown()
    srv.server_close()


def post(srv, path, body: bytes, token=TOKEN, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    h = {"Content-Type": "application/json", **({"X-NetOps-Token": token} if token is not None else {}), **(headers or {})}
    c.request("POST", path, body=body, headers=h)
    resp = c.getresponse()
    data = resp.read()
    c.close()
    return resp.status, json.loads(data) if data else None, resp


def test_http_accepts_object_array_and_ndjson(http_rx):
    srv, p, st, r = http_rx
    assert post(srv, "/v1/logs/threat", json.dumps({"name": "x", "src": "1.1.1.1", "repeat": "2"}).encode())[:2] == (200, {"accepted": 1})
    assert post(srv, "/v1/logs/url", json.dumps([{"url": "a.com/x"}, {"url": "b.com"}]).encode())[1] == {"accepted": 2}
    assert post(srv, "/v1/logs/userid", b'{"user":"u1","ip":"10.0.0.1"}\n{"user":"u2"}\n')[1] == {"accepted": 2}
    p.flush_once(0.1)
    assert r.xlen(keys.log_stream("threat")) == 1 and r.xlen(keys.log_stream("url")) == 2
    assert st.get("httpOkAt")


def test_http_rejects_bad_token_path_and_method(http_rx):
    srv, _, st, _ = http_rx
    assert post(srv, "/v1/logs/threat", b"{}", token="wrong")[0] == 401
    assert post(srv, "/v1/logs/threat", b"{}", token=None)[0] == 401
    # TRAFFIC 走 Syslog,HTTP 不收;未知類型與路徑 404
    assert post(srv, "/v1/logs/traffic", b"{}")[0] == 404
    assert post(srv, "/v1/logs/../threat", b"{}")[0] == 404
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    c.request("GET", "/v1/logs/threat")
    resp = c.getresponse()
    assert resp.status == 405
    assert "Python" not in (resp.getheader("Server") or "")
    assert int(st.snapshot()["rejected"]) >= 5


def test_http_size_and_malformed(http_rx):
    srv, _, st, _ = http_rx
    assert post(srv, "/v1/logs/threat", b"x" * 9000)[0] == 413
    assert post(srv, "/v1/logs/threat", b"{not json")[0] == 400
    assert post(srv, "/v1/logs/threat", b'{"unknown":1}')[1] == {"accepted": 0}
    assert int(st.snapshot()["malformed"]) == 2


def test_http_rejects_source_not_allowed():
    p, st, _ = make_pipeline()
    srv = HttpReceiver(("127.0.0.1", 0), token=TOKEN, pipeline=p, max_body=4096, allowed=OTHER, max_connections=4, tls=None, status=st)
    srv.start()
    try:
        with pytest.raises((ConnectionError, http.client.HTTPException, OSError)):
            post(srv, "/v1/logs/threat", b"{}")
        assert st.snapshot()["rejected"] == "1"
    finally:
        srv.shutdown()
        srv.server_close()


def test_source_allowed():
    nets = (ipaddress.ip_network("10.10.0.0/16"),)
    assert source_allowed("10.10.1.2", nets)
    assert source_allowed("::ffff:10.10.1.2", nets)
    assert not source_allowed("10.11.0.1", nets)
    assert not source_allowed("garbage", nets)


def test_parse_body():
    assert parse_body(b"") is None
    assert parse_body(b"\xff\xfe") is None
    assert parse_body(b'{"a":1}\nbad') is None
    assert parse_body(b'[{"a":1}]') == [{"a": 1}]


# ---------- Syslog ----------
TRAFFIC = {"type": "TRAFFIC", "time": "2026/11/05 10:00:00", "src": "10.1.1.1", "dst": "8.8.8.8", "dport": "53", "bytes": "120"}


def bsd(obj) -> bytes:
    return b"<14>Nov  5 10:00:00 PA-560 " + json.dumps(obj).encode()


def test_parse_message_formats():
    assert parse_message(bsd(TRAFFIC))["dport"] == 53
    ietf = b'<14>1 2026-11-05T10:00:00+08:00 PA-560 - - - - ' + json.dumps(TRAFFIC).encode()
    assert parse_message(ietf)["src"] == "10.1.1.1"
    assert parse_message(bsd({**TRAFFIC, "type": "THREAT"})) is None
    assert parse_message(b"<14>no json here") is None
    assert parse_message(b"<14>{broken") is None
    assert parse_message(b"<14>[1,2]") is None


def test_framer_newline_and_octet_counting():
    f = Framer(1000)
    m1, m2 = bsd(TRAFFIC), bsd({**TRAFFIC, "src": "10.2.2.2"})
    data = m1 + b"\n" + f"{len(m2)} ".encode() + m2
    # 分成小塊送入(TCP 可能任意切段)
    out = []
    for i in range(0, len(data), 7):
        out += f.feed(data[i : i + 7])
    assert out == [m1, m2]


def test_framer_oversize():
    f = Framer(100)
    assert f.feed(b"<14>" + b"a" * 200 + b"\n<14>ok\n") == [b"<14>ok"]
    assert f.oversize == 1
    # 沒有換行的超長資料:丟棄到下一個換行
    f2 = Framer(100)
    assert f2.feed(b"<14>" + b"b" * 150) == []
    assert f2.feed(b"cc\n<14>next\n") == [b"<14>next"]
    # 長度分框宣告超過上限:斷線
    f3 = Framer(100)
    f3.feed(b"5000 <14>x")
    assert f3.fatal and f3.oversize == 1


@pytest.fixture
def syslog_rx():
    p, st, r = make_pipeline()
    srv = SyslogReceiver(("127.0.0.1", 0), pipeline=p, max_message=1024, allowed=LOCAL, max_connections=2, tls=None, status=st)
    srv.start()
    yield srv, p, st, r
    srv.shutdown()
    srv.server_close()


def wait_for(cond, seconds=3.0):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_syslog_end_to_end(syslog_rx):
    srv, p, st, r = syslog_rx
    with socket.create_connection(srv.server_address, timeout=5) as s:
        s.sendall(bsd(TRAFFIC) + b"\n" + b"<14>garbage\n" + bsd({**TRAFFIC, "src": "10.3.3.3"}) + b"\n")
    assert wait_for(lambda: st.snapshot()["received"] == "2")
    p.flush_once(0.1)
    assert r.xlen(keys.log_stream("traffic")) == 2
    assert st.snapshot()["malformed"] == "1" and st.get("syslogOkAt")


def test_syslog_connection_limit(syslog_rx):
    srv, _, st, _ = syslog_rx
    conns = [socket.create_connection(srv.server_address, timeout=5) for _ in range(2)]
    try:
        time.sleep(0.2)
        extra = socket.create_connection(srv.server_address, timeout=5)
        # 超過上限的連線被立即關閉
        assert extra.recv(10) == b""
        extra.close()
        assert wait_for(lambda: int(st.snapshot()["rejected"]) >= 1)
    finally:
        for c in conns:
            c.close()


# ---------- 審查補充:畸形與邊界輸入 ----------
def test_http_deep_json_and_huge_int_are_malformed(http_rx):
    srv, _, st, _ = http_rx
    assert post(srv, "/v1/logs/threat", b"[" * 3000)[0] == 400
    assert post(srv, "/v1/logs/threat", b'{"repeat":' + b"1" * 4400 + b"}")[0] == 400
    assert int(st.snapshot()["malformed"]) == 2


@pytest.mark.parametrize("value", ["²", "-1", "1e3", "9999999999"])
def test_http_bad_content_length(http_rx, value):
    srv = http_rx[0]
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    c.putrequest("POST", "/v1/logs/threat")
    c.putheader("X-NetOps-Token", TOKEN)
    c.putheader("Content-Length", value)
    c.endheaders()
    assert c.getresponse().status in (411, 413)


def test_http_chunked_rejected(http_rx):
    srv = http_rx[0]
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    c.putrequest("POST", "/v1/logs/threat")
    c.putheader("X-NetOps-Token", TOKEN)
    c.putheader("Transfer-Encoding", "chunked")
    c.endheaders()
    # 伺服器讀完標頭就回 411 並關閉連線(不讀本文)
    assert c.getresponse().status == 411


def test_http_head_has_no_body(http_rx):
    srv = http_rx[0]
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    c.request("HEAD", "/v1/logs/threat")
    resp = c.getresponse()
    assert resp.status == 501 and resp.read() == b""


def test_syslog_deep_json_is_malformed():
    assert parse_message(b"<14>" + b"[" * 3000) is None
    assert parse_message(b'<14>{"bytes":' + b"1" * 5000 + b"}") is None


@pytest.mark.parametrize("step", [1, 3, 64, 4096])
def test_framer_any_chunking(step):
    msgs = [bsd({**TRAFFIC, "src": f"10.0.0.{i}"}) for i in range(5)]
    data = msgs[0] + b"\r\n\n" + f"{len(msgs[1])} ".encode() + msgs[1] + msgs[2] + b"\n" + b"\n".join(msgs[3:]) + b"\n"
    f = Framer(1000)
    out = []
    for i in range(0, len(data), step):
        out += f.feed(data[i : i + step])
    assert out == msgs


def test_framer_waits_on_digits_only_and_zero_prefix():
    f = Framer(1000)
    assert f.feed(b"12") == []
    assert f.feed(b" <14>abcdefgh") == [b"<14>abcdefgh"]
    # 0 開頭不是長度分框,當成一般換行訊息
    assert Framer(1000).feed(b"0 hello\n") == [b"0 hello"]


def test_connection_slot_released_after_close(syslog_rx):
    srv, _, st, _ = syslog_rx
    for _ in range(5):
        socket.create_connection(srv.server_address, timeout=5).close()
    assert wait_for(lambda: srv._slots._value == 2)
    assert st.snapshot()["rejected"] == "0"
