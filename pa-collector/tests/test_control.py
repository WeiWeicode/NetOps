"""測試區手動開關(control.py;PA-LIVE-PLAN §4 netops:pa:control):輪詢暫停、接收暫停丟棄計數、正式區不讀、Redis 失敗沿用。"""

from __future__ import annotations

import fakeredis
import pytest

from netops_pa import keys
from netops_pa.control import Control
from netops_pa.pipeline import Pipeline
from netops_pa.poller import Poller
from netops_pa.status import Status
from netops_pa.store import RedisStore


@pytest.fixture
def r():
    return fakeredis.FakeRedis()


def test_control_key_format():
    assert keys.CONTROL == "netops:pa:control"


def test_reads_pause_flags(r):
    c = Control(RedisStore(r, 10).read_control, enabled=True)
    assert c.poll_paused() is False and c.receive_paused is False
    r.hset(keys.CONTROL, mapping={"pollPaused": "1", "receivePaused": "1", "updatedBy": "S112009 測試"})
    assert c.poll_paused() is True
    assert c.receive_paused is True
    r.hset(keys.CONTROL, mapping={"pollPaused": "0"})
    assert c.poll_paused() is False


def test_prod_never_reads(r):
    r.hset(keys.CONTROL, mapping={"pollPaused": "1", "receivePaused": "1"})
    c = Control(RedisStore(r, 10).read_control, enabled=False)
    assert c.poll_paused() is False and c.receive_paused is False


def test_redis_failure_keeps_last_state(r):
    state = {"fail": False}
    store = RedisStore(r, 10)

    def read():
        if state["fail"]:
            raise ConnectionError("down")
        return store.read_control()

    r.hset(keys.CONTROL, mapping={"pollPaused": "1"})
    c = Control(read, enabled=True)
    assert c.poll_paused() is True
    state["fail"] = True
    assert c.poll_paused() is True


class _Client:
    def __init__(self) -> None:
        self.calls = 0

    def op(self, cmd):  # noqa: ANN001
        self.calls += 1
        raise RuntimeError("not reached in this test")


def test_poller_skips_pa_while_paused(r):
    status = Status("t", "test", True, False)
    client = _Client()
    paused = {"v": True}
    poller = Poller(client, lambda *a: None, status, 15, lambda: paused["v"])
    poller._prev = (0.0, {"ethernet1/1": (1, 1)})
    status.fail("poll", "session: old error")
    poller.cycle()
    snap = status.snapshot()
    assert client.calls == 0
    assert snap["pollPaused"] == "1"
    assert "pollError" not in snap
    # 繼續時不拿暫停前的計數相減
    assert poller._prev is None
    paused["v"] = False
    poller.cycle()
    assert client.calls > 0
    assert status.snapshot()["pollPaused"] == "0"


def test_receive_paused_drops_and_counts(r):
    store = RedisStore(r, 10)
    status = Status("t", "test", False, True)
    control = Control(store.read_control, enabled=True)
    p = Pipeline(store, status, queue_size=100, max_rate=1000, control=control)
    r.hset(keys.CONTROL, mapping={"receivePaused": "1"})
    p.heartbeat()
    assert p.submit("threat", [{"src": "1.1.1.1"}, {"src": "2.2.2.2"}], "http") == 0
    hb = {k.decode(): v.decode() for k, v in r.hgetall(keys.HEARTBEAT).items()}
    assert hb["receivePaused"] == "1"
    p.heartbeat()
    hb = {k.decode(): v.decode() for k, v in r.hgetall(keys.HEARTBEAT).items()}
    assert hb["paused"] == "2" and hb["received"] == "0"
    r.hset(keys.CONTROL, mapping={"receivePaused": "0"})
    p.heartbeat()
    assert p.submit("threat", [{"src": "1.1.1.1"}], "http") == 1
    hb = {k.decode(): v.decode() for k, v in r.hgetall(keys.HEARTBEAT).items()}
    assert hb["receivePaused"] == "0"


def test_receive_disabled_never_reports_paused(r):
    store = RedisStore(r, 10)
    status = Status("t", "test", True, False)
    p = Pipeline(store, status, queue_size=100, max_rate=1000, control=Control(store.read_control, enabled=True))
    r.hset(keys.CONTROL, mapping={"receivePaused": "1"})
    p.heartbeat()
    hb = {k.decode(): v.decode() for k, v in r.hgetall(keys.HEARTBEAT).items()}
    assert hb["receivePaused"] == "0"
