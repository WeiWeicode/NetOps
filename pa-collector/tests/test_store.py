"""Redis 寫入:鍵格式、修剪與保留時間(D21)、每分鐘統計與排行。"""

from __future__ import annotations

import json
import time

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.pipeline import Pipeline, RateLimiter
from netops_pa.records import normalize
from netops_pa.status import Status
from netops_pa.store import RedisStore

NOW = 1_762_300_000.0  # 2025-11-04T23:46:40Z(固定時間)


@pytest.fixture
def r():
    return fakeredis.FakeRedis()


def test_key_formats_match_plan():
    # PA-LIVE-PLAN §4;Node 端 infra/redis 用同一格式
    assert keys.snap("cpu") == "netops:pa:snap:cpu"
    assert keys.series("session") == "netops:pa:series:session"
    assert keys.log_stream("traffic") == "netops:pa:log:traffic"
    assert keys.agg("threat", "202611051030") == "netops:pa:agg:threat:202611051030"
    assert keys.top("traffic", "src", "202611051030") == "netops:pa:top:traffic:src:202611051030"
    assert keys.HEARTBEAT == "netops:pa:heartbeat"
    assert keys.minute_bucket(NOW) == "202511042346"
    assert keys.LOG_RETENTION["traffic"] == 3600 and keys.AGG_RETENTION["traffic"] == 86400
    assert keys.LOG_RETENTION["threat"] == keys.AGG_RETENTION["url"] == 2 * 86400


def test_write_traffic_stream_agg_and_tops(r):
    s = RedisStore(r, top_n=200)
    recs = [
        normalize("traffic", {"time": "2026/11/05 10:00:00", "src": "10.1.1.1", "dst": "8.8.8.8", "app": "dns", "rule": "r1",
                              "proto": "udp", "dport": "53", "action": "allow", "bytes": "100", "packets": "2"}),
        normalize("traffic", {"src": "10.1.1.1", "dst": "1.1.1.1", "app": "ssl", "proto": "tcp", "dport": 443, "action": "deny", "bytes": 50}),
    ]
    assert s.write_logs([("traffic", recs[0], NOW), ("traffic", recs[1], NOW)]) == 2
    entries = r.xrange(keys.log_stream("traffic"))
    assert len(entries) == 2
    assert json.loads(entries[0][1][b"d"])["dport"] == 53
    b = keys.minute_bucket(NOW)
    h = {k.decode(): int(v) for k, v in r.hgetall(keys.agg("traffic", b)).items()}
    assert h == {"count": 2, "bytes": 150, "packets": 2, "action:allow": 1, "action:deny": 1, "proto:udp": 1, "proto:tcp": 1}
    assert r.zscore(keys.top("traffic", "src", b), "10.1.1.1") == 2
    assert r.zscore(keys.top("traffic", "port", b), "tcp/443") == 1
    assert r.zscore(keys.top("traffic", "srcBytes", b), "10.1.1.1") == 150
    # TTL:統計 = 保留時間 + 1 分鐘
    assert 86400 < r.ttl(keys.agg("traffic", b)) <= 86460
    assert 86400 < r.ttl(keys.top("traffic", "app", b)) <= 86460


def test_repeat_count_weights_non_traffic(r):
    s = RedisStore(r, top_n=200)
    rec = normalize("threat", {"name": "Brute Force", "src": "1.2.3.4", "severity": "high", "action": "reset-both", "repeat": "5"})
    s.write_logs([("threat", rec, NOW)])
    b = keys.minute_bucket(NOW)
    assert int(r.hget(keys.agg("threat", b), "count")) == 5
    assert int(r.hget(keys.agg("threat", b), "severity:high")) == 5
    assert r.zscore(keys.top("threat", "name", b), "Brute Force") == 5
    assert 2 * 86400 < r.ttl(keys.agg("threat", b)) <= 2 * 86400 + 60


def test_stream_trimmed_by_retention(r):
    s = RedisStore(r, top_n=200)
    rec = normalize("traffic", {"src": "10.0.0.1"})
    # 先寫一筆 2 小時前的(Stream ID 用指定時間),再寫一批現在的 → 舊的被 MINID 修剪
    old_id = f"{int((time.time() - 7200) * 1000)}-0"
    r.xadd(keys.log_stream("traffic"), {"d": "{}"}, id=old_id)
    s.write_logs([("traffic", rec, time.time())] * 3)
    ids = [e[0].decode() for e in r.xrange(keys.log_stream("traffic"))]
    assert old_id not in ids and len(ids) == 3


def test_top_trimmed_to_n_after_minute_ends(r):
    s = RedisStore(r, top_n=10)
    batch = [("traffic", {"src": f"10.0.0.{i}"}, NOW) for i in range(80)]
    s.write_logs(batch)
    b = keys.minute_bucket(NOW)
    # 分鐘進行中最多 5N
    assert r.zcard(keys.top("traffic", "src", b)) == 50
    s.write_logs([("traffic", {"src": "10.9.9.9"}, NOW + 60)])
    assert r.zcard(keys.top("traffic", "src", b)) == 10


def test_heartbeat_replaces_whole_hash(r):
    s = RedisStore(r, top_n=10)
    s.write_heartbeat({"a": "1", "pollError": "x"})
    s.write_heartbeat({"a": "2"})
    assert r.hgetall(keys.HEARTBEAT) == {b"a": b"2"}
    assert r.ttl(keys.HEARTBEAT) == -1


def test_snapshot_series_trimmed(r):
    s = RedisStore(r, top_n=10)
    r.xadd(keys.series("cpu"), {"d": "{}"}, id=f"{int((time.time() - 3 * 86400) * 1000)}-0")
    s.write_snapshot("cpu", {"mgmt": 1}, time.time())
    assert r.xlen(keys.series("cpu")) == 1


def test_normalize_drops_unknown_fields_and_controls():
    rec = normalize("traffic", {"src": "10.0.0.1\n", "evil": "x", "bytes": "-5", "sport": "12a", "app": "a\tb", "url": "x"})
    assert rec == {"src": "10.0.0.1", "bytes": 0, "sport": 0, "app": "a b"}
    assert normalize("traffic", {"evil": 1}) is None
    # 威脅 / URL / Data / WildFire 共用欄位白名單:來源 Port、目的 NAT Port 保留並轉數字,非數字變 0
    for t in ("threat", "url", "data", "wildfire"):
        assert normalize(t, {"sport": "12822", "dport": "443", "natDport": "20077"}) == {"sport": 12822, "dport": 443, "natDport": 20077}
        assert normalize(t, {"sport": "x1", "natDport": ""}) == {"sport": 0, "natDport": 0}
    assert normalize("traffic", ["not", "object"]) is None
    long = normalize("threat", {"url": "a" * 2000, "name": "n" * 500})
    assert len(long["url"]) == 512 and len(long["name"]) == 200


def test_normalize_seqno_and_session_id():
    """CQ9 例外:TRAFFIC 與威脅類保留 seqno(數字字串,64 位元)、sessionId(整數);其他類型不收。"""
    for t in ("traffic", "threat", "url", "data", "wildfire"):
        rec = normalize(t, {"src": "10.0.0.1", "seqno": "7688588907462574142", "sessionId": "288580"})
        assert rec == {"src": "10.0.0.1", "seqno": "7688588907462574142", "sessionId": 288580}
    # 2^64-1 是上限;前導 0 去掉;超過、負數、非數字、全形數字、布林都不寫 seqno
    assert normalize("traffic", {"seqno": "18446744073709551615"})["seqno"] == "18446744073709551615"
    assert normalize("traffic", {"seqno": "0042", "src": "a"})["seqno"] == "42"
    assert normalize("traffic", {"seqno": 123, "src": "a"})["seqno"] == "123"
    for bad in ("18446744073709551616", "-1", "12a", "", "１２３", True, None, 1.5, "1" * 21):
        assert "seqno" not in normalize("traffic", {"seqno": bad, "src": "a"})
    assert normalize("traffic", {"sessionId": "x"}) == {"sessionId": 0}
    for t in ("decryption", "globalprotect", "userid"):
        assert normalize(t, {"seqno": "1", "sessionId": "2"}) is None


def test_seqno_survives_redis_round_trip(r):
    """寫進 Stream 的 JSON 裡 seqno 是字串(Node 端 JSON.parse 不會失去精度)。"""
    store = RedisStore(r, top_n=10)
    rec = normalize("traffic", {"src": "10.0.0.1", "seqno": "7688588907462574142", "sessionId": "1"})
    store.write_logs([("traffic", rec, NOW)])
    ((_id, fields),) = r.xrange(keys.log_stream("traffic"))
    assert b'"seqno":"7688588907462574142"' in fields[b"d"] and b'"sessionId":1' in fields[b"d"]


# ---------- pipeline ----------
class FailingStore:
    def write_logs(self, batch):
        raise ConnectionError("redis down")

    def write_heartbeat(self, fields):
        raise ConnectionError("redis down")


def test_pipeline_queue_full_drops_and_counts(r):
    st = Status("t", "test", False, True)
    p = Pipeline(RedisStore(r, 10), st, queue_size=1000, max_rate=100_000)
    recs = [{"src": "1"}] * 1500
    assert p.submit("threat", recs, "http") == 1000
    snap = st.snapshot()
    assert snap["received"] == "1000" and snap["dropped"] == "500" and snap["httpOkAt"]
    assert p.flush_once(0.1) == 1000
    assert r.xlen(keys.log_stream("threat")) == 1000


def test_pipeline_rate_limit():
    st = Status("t", "test", False, True)
    p = Pipeline(RedisStore(fakeredis.FakeRedis(), 10), st, queue_size=100_000, max_rate=100)
    assert p.submit("threat", [{"src": "1"}] * 300, "http") == 100
    assert st.snapshot()["dropped"] == "200"


def test_rate_limiter_refills():
    t = [0.0]
    rl = RateLimiter(10, clock=lambda: t[0])
    assert rl.take(15) == 10
    assert rl.take(1) == 0
    t[0] = 0.5
    assert rl.take(10) == 5


def test_redis_failure_recorded_in_status():
    st = Status("t", "test", False, True)
    p = Pipeline(FailingStore(), st, queue_size=100, max_rate=1000)  # type: ignore[arg-type]
    p.submit("traffic", [{"src": "1"}] * 3, "syslog")
    assert p.flush_once(0.1) == 0
    snap = st.snapshot()
    assert snap["redisFailed"] == "3" and "redis down" in snap["redisError"]
    p.heartbeat()  # 心跳也失敗:不丟例外


def test_pipeline_thread_writes_heartbeat(r):
    st = Status("t", "test", False, False)
    p = Pipeline(RedisStore(r, 10), st, queue_size=100, max_rate=1000)
    p.start()
    p.submit("url", [{"url": "example.com/a"}], "http")
    p.stop()
    hb = {k.decode(): v.decode() for k, v in r.hgetall(keys.HEARTBEAT).items()}
    assert hb["pollEnabled"] == "0" and hb["receiveEnabled"] == "0" and hb["updatedAt"].endswith("Z")
    assert r.xlen(keys.log_stream("url")) == 1


# ---------- 審查補充 ----------
def test_streams_and_series_have_expire(r):
    s = RedisStore(r, top_n=10)
    s.write_logs([("traffic", {"src": "1"}, time.time()), ("threat", {"name": "x"}, time.time())])
    assert 3600 < r.ttl(keys.log_stream("traffic")) <= 3660
    assert 2 * 86400 < r.ttl(keys.log_stream("threat")) <= 2 * 86400 + 60
    s.write_snapshot("cpu", {"mgmt": 1}, time.time())
    assert 2 * 86400 < r.ttl(keys.series("cpu")) <= 2 * 86400 + 60


def test_kpi_values_capped_per_minute(r):
    from netops_pa.store import KPI_MAX_VALUES, KPI_OTHER

    s = RedisStore(r, top_n=10)
    s.write_logs([("traffic", {"action": f"a{i}"}, NOW) for i in range(KPI_MAX_VALUES + 20)])
    h = r.hgetall(keys.agg("traffic", keys.minute_bucket(NOW)))
    actions = [k for k in h if k.startswith(b"action:")]
    assert len(actions) == KPI_MAX_VALUES + 1
    assert int(h[f"action:{KPI_OTHER}".encode()]) == 20


def test_pending_top_kept_when_execute_fails(r):
    s = RedisStore(r, top_n=10)
    s.write_logs([("traffic", {"src": "1"}, NOW)])
    bad = RedisStore(FailingRedis(), top_n=10)
    bad._pending_top = s._pending_top
    with pytest.raises(ConnectionError):
        bad.write_logs([("traffic", {"src": "2"}, NOW + 60)])
    assert keys.minute_bucket(NOW) in bad._pending_top


class FailingRedis:
    def pipeline(self, transaction=False):
        class P:
            def __getattr__(self, name):
                if name == "execute":
                    def boom():
                        raise ConnectionError("down")
                    return boom
                return lambda *a, **k: None
        return P()


def test_heartbeat_success_clears_redis_error(r):
    st = Status("t", "test", True, False)
    st.fail("redis", "earlier failure")
    Pipeline(RedisStore(r, 10), st, queue_size=10, max_rate=10).heartbeat()
    assert st.get("redisError") is None and st.get("redisOkAt")


def test_syslog_cannot_starve_http(r):
    st = Status("t", "test", False, True)
    p = Pipeline(RedisStore(r, 10), st, queue_size=1000, max_rate=100_000)
    assert p.submit("traffic", [{"src": "1"}] * 1000, "syslog") == 800
    assert p.submit("threat", [{"name": "x"}] * 300, "http") == 200


def test_mask_known_secret_and_formats():
    from netops_pa.status import mask, register_secret

    register_secret("SuperSecretApiKey123")
    assert "SuperSecretApiKey123" not in mask("error {'X-PAN-KEY': 'SuperSecretApiKey123'}")
    assert mask("url?type=op&key=abc123&cmd=x") == "url?type=op&key=***&cmd=x"
    assert "abc" not in mask('{"token": "abc"}')
