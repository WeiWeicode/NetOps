"""連線檢查(python -m netops_pa check):用假 PA 跑一次,不寫 Redis、不印 API Key。"""

from __future__ import annotations

from netops_pa.check import hint, load_poll, run
from netops_pa.config import PollConfig
from netops_pa.poller import SdkClient
from tests.fake_pa import ERROR_403, FakePa

SYSTEM_INFO = (
    '<response status="success"><result><system><hostname>PA-560</hostname><model>PA-560</model>'
    "<sw-version>10.2.9</sw-version><serial>012345678901</serial></system></result></response>"
)


def _run(pa: FakePa, key: str = "test-key"):
    lines: list[str] = []
    cfg = PollConfig(host="127.0.0.1", port=pa.port, api_key=key, ca_file="", tls_insecure=False, interval=15, timeout=5)
    env = {"GW_ENV": "test", "PA_HOST": "127.0.0.1", "PA_PORT": str(pa.port), "PA_API_KEY": key}
    code = run(env, lines.append, SdkClient(cfg, use_http=True))
    return code, "\n".join(lines)


def test_check_success_prints_version_without_key():
    with FakePa() as pa:
        pa.fail["<system><info"] = SYSTEM_INFO
        code, out = _run(pa)
    assert code == 0
    assert "sw-version=10.2.9" in out and "serial=…8901" in out and "012345678901" not in out
    assert "test-key" not in out and "全部成功" in out
    # 檢查也只送唯讀 op
    assert all(r["type"] == "op" and r["cmd"].startswith("<show>") for r in pa.requests)


def test_check_reports_failures_with_hint():
    with FakePa() as pa:
        pa.fail["<system><info"] = ERROR_403
        code, out = _run(pa, key="wrong-key-123")
    assert code == 1
    assert "wrong-key-123" not in out
    assert "API Key 無效" in out


def test_check_config_errors():
    lines: list[str] = []
    assert run({"GW_ENV": "test"}, lines.append) == 2 and "PA_HOST" in lines[0]
    lines.clear()
    assert run({"GW_ENV": "prod", "PA_HOST": "h", "PA_API_KEY_FILE": "/nonexistent"}, lines.append) == 2


def test_hint_certificate():
    assert "SAN" in hint("SSLCertVerificationError: certificate verify failed: IP address mismatch")
    assert load_poll({"GW_ENV": "test", "PA_HOST": "pa", "PA_API_KEY": "k"}).port == 443
